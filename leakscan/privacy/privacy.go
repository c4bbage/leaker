// Package privacy detects sensitive text and protects LLM requests with
// reversible, conversation-scoped placeholders. It never proxies traffic itself.
package privacy

import (
 "context"
 "encoding/json"
 "errors"
	"net/http"
 "fmt"
 "maps"
 "slices"
 "strings"
 "sync"

 "leakscan/privacy/credentials"
 "leakscan/privacy/internal/magpie"
)

const UpstreamRevision = "3b2794cadd9e316fb5b9d30266f6ef3358d98d40"
const Version = "2026-10-28.1"
const ( Mask="mask"; Warn="warn"; Block="block" )
var (
 ErrBlocked=errors.New("privacy: policy blocked request")
 ErrClosed=errors.New("privacy: session is closed")
 ErrInvalidJSON=errors.New("privacy: invalid JSON")
 ErrTooLarge=errors.New("privacy: input exceeds configured limit")
 ErrProcessing=errors.New("privacy: protection failed; do not forward original input")
 ErrModel=errors.New("privacy: local model unavailable")
)

type Rule = magpie.Rule
// Found uses UTF-8 byte offsets and the Magpie/Privacy Filter model labels.
type Found = magpie.Found
// Model must return one result per input text. Implementations must be safe for
// concurrent use when shared by multiple conversations.
type Model interface { Find(context.Context, []string) ([][]Found,error) }

// Config is copied by New. The zero value enables all rule categories and the
// auto-downloaded AstrLink Guard model. RulesOnly explicitly disables models.
type Config struct {
 RulesOnly bool
 Models []ModelID
 Model Model
 CacheDir string
 DisableSecrets, DisablePersonal bool
 Kinds map[string]bool
 Words []string
 WordsAnyCase, WordsWhole, Shape bool
 Rules []Rule
 Actions map[string]string
 Allow []string
 MaxInputBytes int
}

// Detection contains no raw secret. Start/End are byte offsets in Detect's input.
// For ProtectJSON the offsets are relative to the containing decoded string.
type Detection struct {
 Start,End int
 Kind,By,Action,Placeholder string
 Length int
}

type Result struct { Body []byte; Detections []Detection }

type Protector struct { config Config; model Model }

func New(c Config)(*Protector,error) {
 if c.MaxInputBytes==0 { c.MaxInputBytes=8<<20 };if c.MaxInputBytes<1{return nil,errors.New("privacy: MaxInputBytes must be positive")}
 if c.RulesOnly && (c.Model!=nil || len(c.Models)>0) {return nil,errors.New("privacy: RulesOnly conflicts with configured models")}
 rs,err:=magpie.CheckRules(c.Rules);if err!=nil{return nil,errors.New("privacy: invalid custom rules")};c.Rules=rs
 c.Kinds=maps.Clone(c.Kinds);c.Actions=maps.Clone(c.Actions);c.Words=slices.Clone(c.Words);c.Allow=slices.Clone(c.Allow);c.Models=slices.Clone(c.Models)
 for _,a:=range c.Actions{if a!=Mask&&a!=Warn&&a!=Block{return nil,errors.New("privacy: unknown action")}}
 p:=&Protector{config:c,model:c.Model}
 if p.model==nil && !c.RulesOnly {p.model,err=NewLocalModel(LocalModelConfig{Models:c.Models,CacheDir:c.CacheDir});if err!=nil{return nil,err}}
 return p,nil
}

// NewSession creates an isolated secret mapping. Retain it across turns of ONE
// authorized conversation only. Close after its last response has finished.
func(p *Protector) NewSession()*Session{return &Session{p:p,engine:magpie.New()}}

type Session struct { mu sync.Mutex; p *Protector;engine *magpie.Engine;closed bool }
func(s *Session) Close()error{s.mu.Lock();defer s.mu.Unlock();if !s.closed{s.engine.Close();s.closed=true};return nil}

func(s *Session) options(ctx context.Context, hits *[]Detection)magpie.Options{
 c:=s.p.config
 o:=magpie.Options{Secrets:!c.DisableSecrets,Personal:!c.DisablePersonal,Kinds:c.Kinds,Words:c.Words,WordsAnyCase:c.WordsAnyCase,WordsWhole:c.WordsWhole,Shape:c.Shape,Rules:c.Rules,Actions:c.Actions,Allow:c.Allow}
 // All categories are available by default, including Magpie's opt-in ones.
 if o.Kinds==nil{o.Kinds=map[string]bool{}}else{o.Kinds=maps.Clone(o.Kinds)}
 for _,cat:=range magpie.Categories{if _,ok:=o.Kinds[cat.ID];!ok{o.Kinds[cat.ID]=true}}
 o.Extra=func(text string)[]magpie.Located{var out []magpie.Located;for _,sp:=range credentials.Spans(text){out=append(out,magpie.Located{Start:sp.Start,End:sp.End,Kind:strings.ToUpper(sp.RuleID),By:"leaker"})};return out}
 if hits!=nil{o.Seen=func(h magpie.Hit){a:=h.Action;if a==""{a=Mask};*hits=append(*hits,Detection{h.Start,h.End,h.Kind,h.By,a,h.Placeholder,h.Len})}}
 if s.p.model!=nil{o.Model=func(texts []string)[][]Found{got,err:=s.p.model.Find(ctx,texts);if err!=nil||len(got)!=len(texts){panic(ErrModel)};for i,fs:=range got{for _,f:=range fs{if f.Start<0||f.End<=f.Start||f.End>len(texts[i]){panic(ErrModel)}}};return got}}
 return o
}

func(s *Session) check(ctx context.Context,n int)error{if s.closed{return ErrClosed};if err:=ctx.Err();err!=nil{return err};if n>s.p.config.MaxInputBytes{return ErrTooLarge};return nil}
func recoverError(err *error){if r:=recover();r!=nil{if e,ok:=r.(error);ok&&errors.Is(e,ErrModel){*err=ErrModel}else{*err=ErrProcessing}}}

// Detect does not store new recoverable secret values. It never blocks based on
// policy; callers can inspect Action to decide what to do.
func(s *Session) Detect(ctx context.Context,text string)(hits []Detection,err error){
 s.mu.Lock();defer s.mu.Unlock();defer recoverError(&err)
 if err=s.check(ctx,len(text));err!=nil{return nil,err}
 o:=s.options(ctx,nil)
 for _,h:=range s.engine.Detect(text,o){a:=h.Action;if a==""{a=Mask};hits=append(hits,Detection{h.Start,h.End,h.Kind,h.By,a,h.Placeholder,h.Len})}
 return hits,ctx.Err()
}

func(s *Session) ProtectText(ctx context.Context,text string)(out string,hits []Detection,err error){
 s.mu.Lock();defer s.mu.Unlock();defer recoverError(&err)
 if err=s.check(ctx,len(text));err!=nil{return "",nil,err}
 out,_=s.engine.Mask(text,s.options(ctx,&hits));if err=policyError(ctx,hits);err!=nil{return "",hits,err};return
}

// ProtectJSON keeps protocol IDs, schemas, signatures and binary data intact.
// An error returns no Body; never substitute the original request on failure.
func(s *Session) ProtectJSON(ctx context.Context,body []byte)(result Result,err error){
 s.mu.Lock();defer s.mu.Unlock();defer recoverError(&err)
 if err=s.check(ctx,len(body));err!=nil{return Result{},err};if !json.Valid(body){return Result{},ErrInvalidJSON}
 result.Body,_=s.engine.MaskJSON(body,s.options(ctx,&result.Detections))
 if err=policyError(ctx,result.Detections);err!=nil{result.Body=nil};return
}
func policyError(ctx context.Context,hits []Detection)error{if err:=ctx.Err();err!=nil{return err};for _,h:=range hits{if h.Action==Block{return ErrBlocked}};return nil}
func(s *Session) RestoreText(ctx context.Context,text string)(out string,err error){s.mu.Lock();defer s.mu.Unlock();defer recoverError(&err);if err=s.check(ctx,len(text));err!=nil{return "",err};return s.engine.Restore(text,false),nil}
func(s *Session) RestoreJSON(ctx context.Context,body []byte)(out []byte,err error){s.mu.Lock();defer s.mu.Unlock();defer recoverError(&err);if err=s.check(ctx,len(body));err!=nil{return nil,err};if !json.Valid(body){return nil,ErrInvalidJSON};return s.engine.RestoreJSON(body),nil}

// DetectRules is a network-free scan of every built-in rule and category.
func DetectRules(text string)([]Detection,error){p,err:=New(Config{RulesOnly:true});if err!=nil{return nil,err};s:=p.NewSession();defer s.Close();return s.Detect(context.Background(),text)}
func(p *Protector) String()string{return fmt.Sprintf("privacy.Protector(version=%s)",Version)}


// RestoringWriter wraps an HTTP response writer to restore placeholders in SSE streams.
type RestoringWriter = magpie.Writer

// NewRestoringWriter creates a stream writer restoring placeholders across chunk boundaries.
func (s *Session) NewRestoringWriter(w interface {
	Header() http.Header
	Write([]byte) (int, error)
	WriteHeader(int)
}) *RestoringWriter {
	return s.engine.NewWriter(w.(interface {
		Header() http.Header
		Write([]byte) (int, error)
		WriteHeader(int)
	}))
}
