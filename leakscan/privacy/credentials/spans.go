package credentials

import "strings"

// Span locates an individual sensitive value in the original UTF-8 text.
// Unlike Match.Value (an audit identity), these offsets are safe for replacement.
type Span struct {
 Start, End int
 RuleID, Severity, Confidence string
}

// Spans preserves the audit rules and also exposes every component of composite
// credentials, including normalized multiline keys and both halves of AK/SK.
func Spans(text string) []Span {
 var out []Span
 add := func(a,b int,id,sev,conf string) { if a>=0 && b>a && b<=len(text) && conf!=ConfPlaceholder {out=append(out,Span{a,b,id,sev,conf})} }
 lower:=strings.ToLower(text)
 for _,m:=range Scan(text) {
  if m.Confidence==ConfPlaceholder || m.Value=="" {continue}
  for at:=0;at<len(text); {i:=strings.Index(text[at:],m.Value);if i<0 {break};a:=at+i;add(a,a+len(m.Value),m.RuleID,m.Severity,m.Confidence);at=a+len(m.Value)}
 }
 blocks:=[]struct{head,end,id string}{
  {"-----BEGIN ","-----END ","private_key_pem"},
  {"-----BEGIN OpenVPN Static key V1-----","-----END OpenVPN Static key V1-----","vpn_openvpn"},
  {"PuTTY-User-Key-File-","Private-MAC:","ssh_private_key"},
 }
 for _,block:=range blocks {
  for at:=0;at<len(text); {
   i:=strings.Index(text[at:],block.head);if i<0 {break};a:=at+i;end:=min(len(text),a+maxBlock)
   if block.head=="-----BEGIN " {if j:=strings.Index(text[a+len(block.head):],"-----");j<0 || !strings.Contains(text[a:a+len(block.head)+j],"PRIVATE KEY") {at=a+len(block.head);continue}}
   if j:=strings.Index(text[a+len(block.head):end],block.end);j>=0 {
    e:=a+len(block.head)+j+len(block.end)
    if block.end=="-----END " {if k:=strings.Index(text[e:end],"-----");k>=0 {e+=k+5}}
    end=e
   }
   for _,m:=range Scan(text[a:end]) {if m.Confidence!=ConfPlaceholder && (m.RuleID==block.id || m.RuleID=="ssh_private_key" || m.RuleID=="pgp_private_key") {add(a,end,m.RuleID,m.Severity,m.Confidence);break}}
   at=max(a+len(block.head),end)
  }
 }
 // Composite audit matches deliberately use the ID as their identity. Mask
 // each Secret as well; otherwise replacing the ID alone would leak it.
 addGroups:=func(re interface{FindAllStringSubmatchIndex(string,int)[][]int},group int,id string) {
  for _,loc:=range re.FindAllStringSubmatchIndex(text,-1) {a,b:=loc[2*group],loc[2*group+1];if a<0 {continue};m:=finalize(Match{RuleID:id,Value:text[a:b],Severity:SevHigh,Confidence:ConfHigh});add(a,b,id,m.Severity,m.Confidence)}
 }
 if strings.Contains(text,"LTAI") || strings.Contains(text,"STS.") || containsAny(lower,aliyunContext) {addGroups(reAliyunSecret,1,"aliyun_accesskey")}
 if strings.Contains(text,"AKIA") || strings.Contains(text,"ASIA") {addGroups(reAWSSecret,1,"aws_accesskey")}
 if strings.Contains(text,"AKID") {addGroups(reTencentSecret,1,"tencent_accesskey")}
 if reOVPNDirective.MatchString(text) && reOVPNRemote.MatchString(text) {
  for _,loc:=range reOVPNRemote.FindAllStringSubmatchIndex(text,-1) {add(loc[2],loc[3],"vpn_openvpn",SevMedium,ConfHigh)}
  addGroups(reOVPNUserPass,1,"vpn_openvpn");addGroups(reOVPNUserPass,2,"vpn_openvpn")
 }
 return out
}
