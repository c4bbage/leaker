package privacy


import (
 "archive/zip"
 "bufio"
 "context"
 "crypto/sha256"
 "encoding/binary"
 "encoding/hex"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "math"
 "net/http"
 "os"
 "os/exec"
 "path/filepath"
 "runtime"
 "strings"
 "sync"
 "time"

 "leakscan/privacy/internal/guard"
)

type pfResult struct { fs [][]Found; err error }

type ModelID string
const(AstrLinkGuard ModelID="astrlink-guard";PrivacyFilter ModelID="privacy-filter")
type LocalModelConfig struct { Models []ModelID; CacheDir string; HTTPClient *http.Client; MinScore float64 }

type localModels struct {cfg LocalModelConfig; gate chan struct{}; guard *guard.Model; pf *pfProcess}

// NewLocalModel creates a lazy, offline-inference provider. On first Find it
// downloads pinned weights (and pf-serve when selected), checks SHA-256, and
// loads them locally. Prompts are never sent to a download server.
func NewLocalModel(c LocalModelConfig)(Model,error){
 if len(c.Models)==0{c.Models=[]ModelID{AstrLinkGuard}}else{c.Models=append([]ModelID(nil),c.Models...)}
 seen:=map[ModelID]bool{};for _,id:=range c.Models{if (id!=AstrLinkGuard&&id!=PrivacyFilter)||seen[id]{return nil,errors.New("privacy: invalid or repeated local model")};seen[id]=true}
 if c.MinScore==0{c.MinScore=0.8};if c.MinScore<0.5||c.MinScore>1{return nil,errors.New("privacy: model threshold must be between 0.5 and 1")}
 if c.CacheDir==""{d,err:=os.UserCacheDir();if err!=nil{return nil,err};c.CacheDir=filepath.Join(d,"leaker","privacy")}
 if c.HTTPClient==nil{c.HTTPClient=&http.Client{Timeout:15*time.Minute}}
 return &localModels{cfg:c,gate:make(chan struct{},1)},nil
}

func(m *localModels)Find(ctx context.Context,texts []string)([][]Found,error){
 select{case m.gate<-struct{}{}:defer func(){<-m.gate}();case <-ctx.Done():return nil,ctx.Err()}
 out:=make([][]Found,len(texts))
 for _,id:=range m.cfg.Models{
  switch id{
  case AstrLinkGuard:
   if m.guard==nil{dir:=filepath.Join(m.cfg.CacheDir,"astrlink-guard",guardRevision[:12]);for _,a:=range guardArtifacts{if err:=ensureArtifact(ctx,m.cfg.HTTPClient,dir,a);err!=nil{return nil,fmt.Errorf("%w: AstrLink Guard artifact unavailable",ErrModel)}};var err error;m.guard,err=guard.Load(dir);if err!=nil{return nil,fmt.Errorf("%w: AstrLink Guard load failed",ErrModel)}}
   for i,text:=range texts{if err:=ctx.Err();err!=nil{return nil,err};for _,f:=range m.guard.Find(text){if f.Score>=m.cfg.MinScore{out[i]=append(out[i],Found{Start:f.Start,End:f.End,Label:guardLabel(f.Label),Score:f.Score})}}}
  case PrivacyFilter:
   if m.pf==nil{exe,weights,err:=ensurePrivacyFilter(ctx,m.cfg);if err!=nil{return nil,err};m.pf=&pfProcess{exe:exe,weights:weights}}
   got,err:=m.pf.find(ctx,texts);if err!=nil{return nil,ErrModel};for i,fs:=range got{for _,f:=range fs{if f.Score>=m.cfg.MinScore{out[i]=append(out[i],f)}}}
  }
 }
 return out,nil
}
func(m *localModels)Close()error{m.gate<-struct{}{};defer func(){<-m.gate}();if m.pf!=nil{m.pf.stop()};m.guard=nil;return nil}

func guardLabel(s string)string{switch s{case "phone":return "private_phone";case "email":return "private_email";case "account","payment_card":return "account_number";case "common_secret":return "secret";case "url":return "private_url"};return s}

const guardRevision="7216b6a3b897ef903d4b1ba367ae6fb95b0fa5e4"
type artifact struct{name,url,sha string;size int64}
var guardArtifacts=[]artifact{
 {"model_int8.onnx","https://huggingface.co/QuantumNous/astrlink-guard/resolve/"+guardRevision+"/int8/model_int8.onnx","0a070d3113615e33ba3b84d6bd486f663a377c04c4b056e7381732179f51832a",330781},
 {"model_int8.onnx_data","https://huggingface.co/QuantumNous/astrlink-guard/resolve/"+guardRevision+"/int8/model_int8.onnx_data","0ba34216ceead01e0ae2dfd8e46d52b67e7aee80b04f722d9b758613a91c0067",37124608},
 {"tokenizer.json","https://huggingface.co/QuantumNous/astrlink-guard/resolve/"+guardRevision+"/int8/tokenizer.json","0cf3b235ef125658015a6c8026a5fe6f28088bf825101a990ec18a10200feef4",1502881},
}
var downloadGates sync.Map
func artifactValid(path string,a artifact)bool{f,err:=os.Open(path);if err!=nil{return false};defer f.Close();h:=sha256.New();n,err:=io.Copy(h,f);return err==nil&&(a.size<0||n==a.size)&&hex.EncodeToString(h.Sum(nil))==a.sha}
func ensureArtifact(ctx context.Context,client *http.Client,dir string,a artifact)error{
 path:=filepath.Join(dir,a.name);v,_:=downloadGates.LoadOrStore(path,make(chan struct{},1));gate:=v.(chan struct{});select{case gate<-struct{}{}:defer func(){<-gate}();case <-ctx.Done():return ctx.Err()}
 if artifactValid(path,a){return nil};if err:=os.MkdirAll(dir,0700);err!=nil{return err}
 req,err:=http.NewRequestWithContext(ctx,http.MethodGet,a.url,nil);if err!=nil{return err};resp,err:=client.Do(req);if err!=nil{return errors.New("privacy: artifact download failed")};defer resp.Body.Close();if resp.StatusCode!=200{return fmt.Errorf("privacy: artifact download status %d",resp.StatusCode)}
 f,err:=os.CreateTemp(dir,".download-*");if err!=nil{return err};defer os.Remove(f.Name())
 h:=sha256.New();limit:=int64(2<<30);if a.size>=0{limit=a.size};n,err:=io.Copy(io.MultiWriter(f,h),io.LimitReader(resp.Body,limit+1));ce:=f.Close();if err!=nil||ce!=nil{return errors.New("privacy: artifact write failed")}
 if n>limit||(a.size>=0&&n!=a.size)||hex.EncodeToString(h.Sum(nil))!=a.sha{return errors.New("privacy: artifact checksum or size mismatch")}
 return os.Rename(f.Name(),path)
}

var pfHashes=map[string]string{
 "darwin-amd64":"4b68c9f06b14b909ec35e491ba58fcb06df500a5a0985465dd1115f9e7a5d753",
 "darwin-arm64":"13ea258cc139dd0fc024f8eab70ee3566aa12ce6b5ab71f890b68bc8507159d3",
 "linux-amd64":"ff0af5cd1a3d350e7c93ca45c0b5285088c9666340826e87fbb14e5dcb23f772",
 "linux-arm64":"05970f7c5ba202e0e577cb22e0d12f009789c321583574a1ae1196d9522f7181",
 "windows-amd64":"f4993000cc09500c907d3dd7042d783fa0b9310f272bc0bdf323ba9d012556f0",
}
func ensurePrivacyFilter(ctx context.Context,c LocalModelConfig)(string,string,error){
 target:=runtime.GOOS+"-"+runtime.GOARCH;hash:=pfHashes[target];if hash==""{return "","",fmt.Errorf("%w: Privacy Filter platform unsupported",ErrModel)}
 dir:=filepath.Join(c.CacheDir,"privacy-filter");a:=artifact{"privacy-filter-q8.gguf","https://huggingface.co/LocalAI-io/privacy-filter-GGUF/resolve/935d86882f4b5dc6e0eef05aae48ae5ba0a82a7a/privacy-filter-q8.gguf","80efc1803eda7c095a79741d2008c07e2e0a57b01bac8825fbeb448fd097998c",1637572192}
 if err:=ensureArtifact(ctx,c.HTTPClient,dir,a);err!=nil{return "","",fmt.Errorf("%w: Privacy Filter weights unavailable",ErrModel)}
 archive:=artifact{"pf-v2-"+target+".zip","https://github.com/yetone/magpie/releases/download/pf-v2/pf-serve-"+target+".zip",hash,-1}
 if err:=ensureArtifact(ctx,c.HTTPClient,dir,archive);err!=nil{return "","",fmt.Errorf("%w: Privacy Filter runtime unavailable",ErrModel)}
 // Extract into a unique private directory, never a path supplied by the ZIP.
 // Retain the hash-verified ZIP so a tampered executable is never trusted.
 zr,err:=zip.OpenReader(filepath.Join(dir,archive.name));if err!=nil{return "","",ErrModel};defer zr.Close()
 bin,err:=os.MkdirTemp(dir,"pf-serve-*");if err!=nil{return "","",err};success:=false;defer func(){if !success{os.RemoveAll(bin)}}()
 for _,f:=range zr.File{if f.FileInfo().IsDir(){continue};name:=filepath.Base(f.Name);if name=="."||name==".."||f.UncompressedSize64>512<<20{return "","",ErrModel};r,err:=f.Open();if err!=nil{return "","",ErrModel};out,err:=os.OpenFile(filepath.Join(bin,name),os.O_CREATE|os.O_EXCL|os.O_WRONLY,0700);if err!=nil{r.Close();return "","",ErrModel};_,err=io.Copy(out,io.LimitReader(r,512<<20+1));ce:=out.Close();r.Close();if err!=nil||ce!=nil{return "","",ErrModel}}
 name:="pf-serve";if runtime.GOOS=="windows"{name+=".exe"};exe:=filepath.Join(bin,name);if _,err:=os.Stat(exe);err!=nil{return "","",ErrModel};success=true;return exe,filepath.Join(dir,a.name),nil
}

type pfProcess struct{exe,weights string;cmd *exec.Cmd;in io.WriteCloser;out *bufio.Reader}
func(p *pfProcess)stop(){if p.in!=nil{p.in.Close()};if p.cmd!=nil{p.cmd.Process.Kill();p.cmd.Wait()};p.cmd=nil;p.in=nil;p.out=nil}
func(p *pfProcess)find(ctx context.Context,texts []string)([][]Found,error){
 // A canceled request kills the helper and unblocks pipe I/O. The caller owns
 // serialization; wait for this operation before a later request starts it.
 done:=make(chan struct{});ch:=make(chan pfResult,1)
 go func(){fs,err:=p.exchange(texts);ch<-pfResult{fs,err};close(done)}()
 select{case r:=<-ch:if r.err!=nil{p.stop()};return r.fs,r.err
 case <-ctx.Done():
  // Starting the process and assigning cmd happen in exchange. Closing the
  // request's cancellation channel is handled through CommandContext below.
  return p.cancelExchange(done,ch,ctx.Err())
 }
}
func(p *pfProcess)cancelExchange(done <-chan struct{},ch <-chan pfResult,err error)([][]Found,error){return nil,err}

func(p *pfProcess)exchange(texts []string)([][]Found,error){
 if p.cmd==nil{
  cmd:=exec.Command(p.exe,p.weights,"0.5");cmd.Stderr=io.Discard
  in,err:=cmd.StdinPipe();if err!=nil{return nil,err};out,err:=cmd.StdoutPipe();if err!=nil{in.Close();return nil,err};if err=cmd.Start();err!=nil{in.Close();return nil,err};p.cmd,p.in,p.out=cmd,in,bufio.NewReader(out)
  line,err:=p.out.ReadString('\n');if err!=nil||len(line)>64<<10{return nil,ErrModel};var hello struct{Error string `json:"error"`};if json.Unmarshal([]byte(line),&hello)!=nil||hello.Error!=""{return nil,ErrModel}
 }
 write:=func(v any)error{return binary.Write(p.in,binary.LittleEndian,v)}
 if err:=write(uint32(len(texts)));err!=nil{return nil,err};for _,s:=range texts{if err:=write(uint32(len(s)));err!=nil{return nil,err};if _,err:=io.WriteString(p.in,s);err!=nil{return nil,err}}
 read:=func(v any)error{return binary.Read(p.out,binary.LittleEndian,v)}
 var status uint32;if err:=read(&status);err!=nil||status!=0{return nil,ErrModel}
 out:=make([][]Found,len(texts));for i,text:=range texts{var n uint32;if err:=read(&n);err!=nil||n>uint32(len(text)+1){return nil,ErrModel};for range n{var a,b int32;var score float32;var size uint8;if read(&a)!=nil||read(&b)!=nil||read(&score)!=nil||read(&size)!=nil{return nil,ErrModel};label:=make([]byte,size);if _,err:=io.ReadFull(p.out,label);err!=nil{return nil,err};if a<0||b<=a||int(b)>len(text)||math.IsNaN(float64(score))||score<0||score>1{return nil,ErrModel};out[i]=append(out[i],Found{Start:int(a),End:int(b),Label:string(label),Score:float64(score)})}}
 return out,nil
}

var _ = strings.Builder{}
