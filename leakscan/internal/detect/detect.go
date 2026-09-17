// Package detect 对一条调用记录执行识别，输出不含原文的命中。
package detect

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
	"time"

	"leakscan/internal/extract"
	"leakscan/internal/rules"
)

// Record 是从网关库读出的一条调用记录。内容字段只在内存中处理。
type Record struct {
	Table      string
	RequestID  string
	CallTS     time.Time
	UserID     string
	UserName   string
	DeptID     string
	DeptName   string
	KeyID      string
	KeyName    string
	KeyType    string
	Model      string
	UserAgent  string
	IP         string
	LogEnabled *bool // nil 表示 Key 不存在或未知

	RequestBody    []byte
	ResponseBody   []byte
	RequestHeaders []byte
	HasHeaderCol   bool

	RequestOversize  bool
	ResponseOversize bool

	// SourcePath 是端上产品（ECAP-011）追加的字段：凭证原本所属的文件路径
	// （如 ~/.ssh/id_rsa）。网关侧恒为空，HitsHeader 的 source_path 列取自这里。
	// 这是 detect 包唯一允许的端上专用追加字段（实施方案 §0.1 例外条款）。
	SourcePath string
}

// Hit 是一条记录内、同一凭证指纹的汇总命中。不含凭证原文。
type Hit struct {
	RuleID      string
	TypeName    string
	Tier        int
	Severity    string
	Confidence  string
	Roles       []string
	Occurrences int
	Fingerprint string
	Masked      string
	Note        string
	GatewayKey  string // 本网关 Key 确认结果

	// SourcePath 是端上产品（ECAP-011）追加的字段：凭证原本所属的文件路径
	// （如 ~/.ssh/id_rsa）。网关侧恒为空。这是 output 层 HitsHeader 追加
	// source_path 列的数据来源，也是 detect 包唯一的端上专用字段。
	SourcePath string
}

// Stats 是单条记录对覆盖统计的贡献。
type Stats struct {
	HasRequestBody    bool
	HasResponseBody   bool
	HasHeaders        bool
	NoContent         bool
	RequestParseFail  bool
	ResponseParseFail bool
	Oversize          bool
	AuthHeader        bool
	AuthUnmasked      bool
}

// Outcome 是一条记录的处理结果。
type Outcome struct {
	Record Record
	Hits   []Hit
	Stats  Stats
}

// GatewayKey 是网关 api_keys 中的一行，只保留确认所需字段。
type GatewayKey struct {
	ID      string
	UserID  string
	Name    string
	Enabled bool
}

// Detector 线程安全，可被多个 worker 共享（字段只读）。
type Detector struct {
	hmacKey []byte
	// 网关 Key 哈希索引。网关的哈希方式未知（Q-016），这里按 SHA-256 十六进制尝试，
	// 对不上时结果为"未确认"，绝不向外部发请求验证。
	gatewayKeys      map[string]GatewayKey
	gatewayHashKnown bool
}

// New 创建识别器。gatewayHashes 为 key_hash → Key 信息。
func New(hmacKey []byte, gatewayHashes map[string]GatewayKey) *Detector {
	known := false
	for h := range gatewayHashes {
		if len(h) == 64 && isHex(h) {
			known = true
			break
		}
	}
	return &Detector{hmacKey: hmacKey, gatewayKeys: gatewayHashes, gatewayHashKnown: known}
}

// Fingerprint 用带密钥的 HMAC 生成不可还原的凭证指纹，
// 防止有人拿到输出文件后对短口令做离线穷举。
func (d *Detector) Fingerprint(value string) string {
	mac := hmac.New(sha256.New, d.hmacKey)
	mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil))[:32]
}

var sevRank = map[string]int{rules.SevHigh: 3, rules.SevMedium: 2, rules.SevLow: 1}
var confRank = map[string]int{rules.ConfHigh: 4, rules.ConfMedium: 3, rules.ConfLow: 2, rules.ConfPlaceholder: 1}

// Scan 处理一条记录。
func (d *Detector) Scan(rec Record) Outcome {
	out := Outcome{Record: rec}
	st := &out.Stats
	st.HasRequestBody = len(rec.RequestBody) > 0 && string(rec.RequestBody) != "null"
	st.HasResponseBody = len(rec.ResponseBody) > 0 && string(rec.ResponseBody) != "null"
	st.Oversize = rec.RequestOversize || rec.ResponseOversize

	segs := map[string]string{}
	merge := func(s extract.Segments) {
		for role, text := range s {
			if prev, ok := segs[role]; ok {
				segs[role] = prev + "\n" + text
			} else {
				segs[role] = text
			}
		}
	}
	if st.HasRequestBody {
		r := extract.Request(rec.RequestBody)
		st.RequestParseFail = !r.Parsed
		merge(r.Segments)
	}
	if st.HasResponseBody {
		r := extract.Response(rec.ResponseBody)
		st.ResponseParseFail = !r.Parsed
		merge(r.Segments)
	}
	if rec.HasHeaderCol && len(rec.RequestHeaders) > 0 {
		h := extract.Headers(rec.RequestHeaders)
		st.HasHeaders = true
		st.AuthHeader = h.AuthPresent
		st.AuthUnmasked = h.AuthLooksUnmasked
		merge(h.Segments)
	}
	st.NoContent = !st.HasRequestBody && !st.HasResponseBody

	type agg struct {
		hit      Hit
		roles    map[string]bool
		priority int
	}
	byFP := map[string]*agg{}
	roles := make([]string, 0, len(segs))
	for role := range segs {
		roles = append(roles, role)
	}
	sort.Strings(roles)
	for _, role := range roles {
		for _, m := range rules.Scan(segs[role]) {
			ruleID, note, gw := m.RuleID, m.Note, ""
			sev, conf := m.Severity, m.Confidence
			if m.RuleID == "llm_api_key_generic" && conf != rules.ConfPlaceholder {
				ruleID, sev, conf, note, gw = d.confirmGatewayKey(rec, m)
			}
			fp := d.Fingerprint(m.Value)
			t := rules.TypeOf(ruleID)
			a, ok := byFP[fp]
			if !ok {
				a = &agg{hit: Hit{RuleID: ruleID, TypeName: t.Name, Tier: t.Tier, Severity: sev, Confidence: conf,
					Fingerprint: fp, Masked: m.Masked, Note: note, GatewayKey: gw}, roles: map[string]bool{}, priority: t.Priority}
				byFP[fp] = a
			} else {
				if t.Priority < a.priority {
					a.priority = t.Priority
					a.hit.RuleID, a.hit.TypeName, a.hit.Tier = ruleID, t.Name, t.Tier
					a.hit.Masked, a.hit.Note = m.Masked, note
				}
				if sevRank[sev] > sevRank[a.hit.Severity] {
					a.hit.Severity = sev
				}
				if confRank[conf] > confRank[a.hit.Confidence] {
					a.hit.Confidence = conf
				}
				if gw != "" {
					a.hit.GatewayKey = gw
				}
			}
			a.hit.Occurrences++
			a.roles[role] = true
		}
	}
	fps := make([]string, 0, len(byFP))
	for fp := range byFP {
		fps = append(fps, fp)
	}
	sort.Strings(fps)
	for _, fp := range fps {
		a := byFP[fp]
		for r := range a.roles {
			a.hit.Roles = append(a.hit.Roles, r)
		}
		sort.Strings(a.hit.Roles)
		out.Hits = append(out.Hits, a.hit)
	}
	return out
}

func (d *Detector) confirmGatewayKey(rec Record, m rules.Match) (ruleID, sev, conf, note, status string) {
	ruleID, sev, conf, note = m.RuleID, m.Severity, m.Confidence, m.Note
	if !d.gatewayHashKnown {
		return ruleID, sev, conf, note, "无法确认（网关哈希方式未知）"
	}
	sum := sha256.Sum256([]byte(m.Value))
	gk, ok := d.gatewayKeys[hex.EncodeToString(sum[:])]
	if !ok {
		sum = sha256.Sum256([]byte(strings.TrimPrefix(m.Value, "sk-")))
		gk, ok = d.gatewayKeys[hex.EncodeToString(sum[:])]
	}
	if !ok {
		return ruleID, sev, conf, note, "不是本网关 Key 或无法确认"
	}
	status = "本网关 Key：" + gk.Name
	if !gk.Enabled {
		status += "（已停用）"
	}
	if gk.UserID != "" && rec.UserID != "" && gk.UserID != rec.UserID {
		note = "贴出的是他人的网关 Key（持有人 " + gk.UserID + "）"
	} else {
		note = "贴出的是本人的网关 Key"
	}
	sev = rules.SevHigh
	if !gk.Enabled {
		sev = rules.SevMedium
	}
	return "gateway_api_key", sev, rules.ConfHigh, note, status
}

func isHex(s string) bool {
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
