// Package rules 定义敏感凭证识别规则。
//
// 所有正则都使用 Go 标准库 regexp（RE2，线性时间），员工内容不可信，
// 不能使用会回溯的正则引擎。
package rules

import (
	"math"
	"regexp"
	"strings"
)

// Version 是规则集版本，写入每条命中记录。
const Version = "2026-09-16.1"

// 严重程度与置信度。
const (
	SevHigh   = "high"
	SevMedium = "medium"
	SevLow    = "low"

	ConfHigh        = "high"
	ConfMedium      = "medium"
	ConfLow         = "low"
	ConfPlaceholder = "placeholder"
)

// Match 是在一段文本中识别出的一处疑似凭证。Value 是凭证原文，只在内存中使用，
// 用于计算指纹和脱敏片段，绝不能写入任何输出。
type Match struct {
	RuleID     string
	Value      string
	Masked     string
	Severity   string
	Confidence string
	Note       string
}

// Type 描述一个凭证类型（附录 A）。
type Type struct {
	ID       string
	Name     string
	Tier     int
	Priority int // 同一凭证被多条规则命中时，数值小的优先
}

var types = []Type{
	{"ssh_private_key", "SSH 私钥", 1, 10},
	{"vpn_openvpn", "VPN 配置（OpenVPN）", 1, 11},
	{"vpn_wireguard", "VPN 配置（WireGuard）", 1, 12},
	{"vpn_ipsec_psk", "VPN 预共享密钥（IPsec）", 1, 13},
	{"aliyun_accesskey", "阿里云 AccessKey", 1, 14},
	{"gitlab_token", "GitLab 令牌", 1, 15},
	{"gateway_api_key", "本网关签发的 API Key", 2, 20},
	{"aws_accesskey", "AWS AccessKey", 2, 21},
	{"tencent_accesskey", "腾讯云 SecretId/SecretKey", 2, 22},
	{"huawei_accesskey", "华为云 AK/SK", 2, 23},
	{"gcp_service_account", "GCP 服务账号密钥", 2, 24},
	{"github_token", "GitHub 令牌", 2, 25},
	{"k8s_credential", "Kubernetes 凭证", 2, 26},
	{"db_connection", "数据库连接凭证", 2, 27},
	{"im_webhook", "IM 机器人 Webhook", 2, 28},
	{"app_secret", "办公/IM 应用密钥", 2, 29},
	{"telegram_bot_token", "Telegram Bot Token", 2, 30},
	{"slack_token", "Slack Token", 2, 31},
	{"notion_token", "Notion 集成密钥", 2, 32},
	{"anthropic_api_key", "Anthropic API Key", 2, 33},
	{"openai_api_key", "OpenAI API Key", 2, 34},
	{"google_api_key", "Google API Key", 2, 35},
	{"package_registry_token", "npm/PyPI 令牌", 2, 36},
	{"private_key_pem", "通用私钥（TLS/PKCS8）", 2, 37},
	{"pgp_private_key", "PGP 私钥", 2, 38},
	{"crypto_private_key", "加密钱包私钥", 2, 39},
	{"url_credential", "URL 内嵌账号口令", 2, 40},
	{"huggingface_token", "Hugging Face 访问令牌", 2, 41},
	{"sendgrid_key", "SendGrid API Key", 2, 42},
	{"stripe_secret", "Stripe 生产密钥", 2, 43},
	{"llm_api_key_generic", "sk- 格式 API Key（未确认归属）", 2, 50},
	{"jwt", "JWT 令牌", 3, 60},
	{"password_field", "配置中的口令字段", 3, 61},
}

var typeIndex = func() map[string]Type {
	m := make(map[string]Type, len(types))
	for _, t := range types {
		m[t.ID] = t
	}
	return m
}()

// TypeOf 返回规则对应的类型信息。
func TypeOf(id string) Type {
	if t, ok := typeIndex[id]; ok {
		return t
	}
	return Type{ID: id, Name: id, Tier: 3, Priority: 99}
}

// Types 返回全部类型，用于报告排序。
func Types() []Type { return types }

// regexRule 是"关键字预筛 + 正则 + 取值分组"的通用规则。
type regexRule struct {
	id         string
	keywords   []string // 小写；任意一个出现才执行正则
	re         *regexp.Regexp
	group      int
	severity   string
	confidence string
}

var regexRules = []regexRule{
	// ---- 第一层 ----
	{id: "gitlab_token", keywords: []string{"gl"},
		re:    regexp.MustCompile(`\b((?:glpat|gldt|glrt|glcbt|glptt|glft|glimt|glagent|glsoat|gloas|glffct|glwt)-[0-9A-Za-z_\-.]{20,255})`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "gitlab_token", keywords: []string{"gr1348941"},
		re:    regexp.MustCompile(`\b(GR1348941[0-9A-Za-z_\-]{20,64})`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "vpn_ipsec_psk", keywords: []string{"psk"},
		re:    regexp.MustCompile(`(?i)(?:^|\s):\s*PSK\s+"([^"\r\n]{6,128})"`),
		group: 1, severity: SevHigh, confidence: ConfMedium},
	{id: "vpn_ipsec_psk", keywords: []string{"psk", "pre-shared", "pre_shared", "preshared", "pre shared"},
		re:    regexp.MustCompile(`(?i)\b(?:pre[-_ ]?shared[-_ ]?key|ipsec[-_ ]?psk|leftpsk|rightpsk)\b["']?\s*[:=]\s*["']?([^\s"']{6,128})`),
		group: 1, severity: SevHigh, confidence: ConfMedium},

	// ---- 第二层 ----
	{id: "github_token", keywords: []string{"ghp_", "gho_", "ghu_", "ghs_", "ghr_"},
		re:    regexp.MustCompile(`\b((?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36})\b`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "github_token", keywords: []string{"github_pat_"},
		re:    regexp.MustCompile(`\b(github_pat_[0-9A-Za-z_]{80,255})`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "tencent_accesskey", keywords: []string{"akid"},
		re:    regexp.MustCompile(`\b(AKID[0-9A-Za-z]{13,40})\b`),
		group: 1, severity: SevMedium, confidence: ConfMedium},
	{id: "huawei_accesskey", keywords: []string{"huaweicloud", "hw_access", "hwcloud"},
		re:    regexp.MustCompile(`(?i)(?:HUAWEICLOUD_SDK_AK|HW_ACCESS_KEY|HWCLOUD_AK)["']?\s*[:=]\s*["']?([A-Z0-9]{20})\b`),
		group: 1, severity: SevMedium, confidence: ConfMedium},
	{id: "k8s_credential", keywords: []string{"client-key-data"},
		re:    regexp.MustCompile(`client-key-data:\s*([A-Za-z0-9+/=]{40,})`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "k8s_credential", keywords: []string{"token:"},
		re:    regexp.MustCompile(`(?m)^\s*token:\s*["']?(eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})`),
		group: 1, severity: SevHigh, confidence: ConfMedium},
	{id: "db_connection", keywords: []string{"://"},
		re:    regexp.MustCompile(`(?i)\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|clickhouse|oracle)://[^\s:/@"'<>]{0,64}:([^\s@"'<>]{3,128})@[^\s/"'<>]+`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "db_connection", keywords: []string{"jdbc:"},
		re:    regexp.MustCompile(`(?i)\bjdbc:[a-z0-9]+:[^\s"'<>]*?[?&;](?:password|pwd)=([^&;\s"'<>]{3,128})`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "im_webhook", keywords: []string{"open.feishu.cn", "open.larksuite.com"},
		re:    regexp.MustCompile(`https://open\.(?:feishu\.cn|larksuite\.com)/open-apis/bot/v2/hook/([0-9a-fA-F\-]{36})`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "im_webhook", keywords: []string{"oapi.dingtalk.com"},
		re:    regexp.MustCompile(`https://oapi\.dingtalk\.com/robot/send\?access_token=([0-9a-fA-F]{64})`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "im_webhook", keywords: []string{"qyapi.weixin.qq.com"},
		re:    regexp.MustCompile(`https://qyapi\.weixin\.qq\.com/cgi-bin/webhook/send\?key=([0-9a-fA-F\-]{36})`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "im_webhook", keywords: []string{"hooks.slack.com"},
		re:    regexp.MustCompile(`https://hooks\.slack\.com/services/(T[0-9A-Z]{6,}/B[0-9A-Z]{6,}/[0-9A-Za-z]{20,})`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "app_secret", keywords: []string{"secret"},
		re:    regexp.MustCompile(`(?i)\b(?:app_?secret|client_?secret|corp_?secret)\b["']?\s*[:=]\s*["']?([0-9A-Za-z_\-]{24,64})`),
		group: 1, severity: SevHigh, confidence: ConfMedium},
	{id: "telegram_bot_token", keywords: []string{":aa"},
		re:    regexp.MustCompile(`\b([0-9]{8,10}:AA[0-9A-Za-z_\-]{33})\b`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "slack_token", keywords: []string{"xox"},
		re:    regexp.MustCompile(`\b(xox[baprs]-[0-9A-Za-z\-]{10,255})`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "notion_token", keywords: []string{"secret_", "ntn_"},
		re:    regexp.MustCompile(`\b(secret_[0-9A-Za-z]{43}|ntn_[0-9A-Za-z]{46})\b`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "anthropic_api_key", keywords: []string{"sk-ant-"},
		re:    regexp.MustCompile(`\b(sk-ant-(?:api03|admin01)-[0-9A-Za-z_\-]{80,120})`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "openai_api_key", keywords: []string{"sk-proj-", "sk-svcacct-", "sk-admin-"},
		re:    regexp.MustCompile(`\b(sk-(?:proj|svcacct|admin)-[0-9A-Za-z_\-]{40,200})`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "openai_api_key", keywords: []string{"t3blbkfj"},
		re:    regexp.MustCompile(`\b(sk-[0-9A-Za-z]{20}T3BlbkFJ[0-9A-Za-z]{20})\b`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "google_api_key", keywords: []string{"aiza"},
		re:    regexp.MustCompile(`\b(AIza[0-9A-Za-z_\-]{35})\b`),
		group: 1, severity: SevMedium, confidence: ConfHigh},
	{id: "package_registry_token", keywords: []string{"npm_"},
		re:    regexp.MustCompile(`\b(npm_[0-9A-Za-z]{36})\b`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "package_registry_token", keywords: []string{"pypi-"},
		re:    regexp.MustCompile(`\b(pypi-AgEIcHlwaS5vcmc[0-9A-Za-z_\-]{50,255})`),
		group: 1, severity: SevHigh, confidence: ConfHigh},
	{id: "crypto_private_key", keywords: []string{"private", "privkey", "私钥"},
		re:    regexp.MustCompile(`(?i)(?:private[_ ]?key|privkey|私钥)["']?\s*[:=：]?\s*["']?(?:0x)?([0-9a-fA-F]{64})\b`),
		group: 1, severity: SevHigh, confidence: ConfMedium},
	{id: "llm_api_key_generic", keywords: []string{"sk-"},
		re:    regexp.MustCompile(`\b(sk-[0-9A-Za-z]{32,64})\b`),
		group: 1, severity: SevMedium, confidence: ConfMedium},

	// 以下三条的正则模式取自 kenn-io/agentsview 的 internal/secrets/rules.go
	// （MIT 许可，2026-09-14 读取）。仅移植了匹配模式本身；关键字预筛、
	// 占位符判定、脱敏与严重程度沿用本包既有机制，未使用其 validate/mask 实现。
	{id: "huggingface_token", keywords: []string{"hf_"},
		re:    regexp.MustCompile(`\b(hf_[0-9A-Za-z]{30,})\b`),
		group: 1, severity: SevMedium, confidence: ConfHigh},
	{id: "sendgrid_key", keywords: []string{"sg."},
		re:    regexp.MustCompile(`\b(SG\.[0-9A-Za-z_\-]{22}\.[0-9A-Za-z_\-]{43})(?:[^0-9A-Za-z_\-]|$)`),
		group: 1, severity: SevMedium, confidence: ConfHigh},
	{id: "stripe_secret", keywords: []string{"sk_live_", "rk_live_"},
		re:    regexp.MustCompile(`\b([sr]k_live_[0-9A-Za-z]{16,})\b`),
		group: 1, severity: SevHigh, confidence: ConfHigh},

	// ---- 第三层 ----
	{id: "jwt", keywords: []string{"eyj"},
		re:    regexp.MustCompile(`\b(eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})`),
		group: 1, severity: SevLow, confidence: ConfMedium},
	{id: "password_field", keywords: []string{"pass", "pwd"},
		re:    regexp.MustCompile(`(?i)(?:^|[\s"'{,(])(?:password|passwd|pwd|db_pass(?:word)?|mysql_pwd|pgpassword)["']?\s*[:=]\s*["']?([^\s"'<>{},;]{6,64})`),
		group: 1, severity: SevLow, confidence: ConfLow},
}

// Scan 在一段文本中识别所有疑似凭证。
func Scan(text string) []Match {
	if len(text) < 8 {
		return nil
	}
	lower := strings.ToLower(text)
	var out []Match
	out = append(out, scanPEM(text, lower)...)
	out = append(out, scanPuTTY(text, lower)...)
	out = append(out, scanOpenVPN(text, lower)...)
	out = append(out, scanWireGuard(text, lower)...)
	out = append(out, scanAliyun(text, lower)...)
	out = append(out, scanAWS(text, lower)...)
	out = append(out, scanTencentSecret(text, lower)...)
	out = append(out, scanGCP(text, lower)...)
	out = append(out, scanURLCredential(text, lower)...)
	for _, r := range regexRules {
		if !containsAny(lower, r.keywords) {
			continue
		}
		for _, sm := range r.re.FindAllStringSubmatch(text, -1) {
			v := sm[r.group]
			m := Match{RuleID: r.id, Value: v, Masked: Mask(v), Severity: r.severity, Confidence: r.confidence}
			if r.id == "password_field" {
				m.Masked = maskLen(v)
			}
			out = append(out, finalize(m))
		}
	}
	return out
}

// finalize 识别占位值和示例值并降级。
func finalize(m Match) Match {
	if IsPlaceholder(m.Value) {
		m.Confidence = ConfPlaceholder
		m.Severity = SevLow
		if m.Note == "" {
			m.Note = "疑似占位或示例值"
		}
	}
	return m
}

var placeholderWords = []string{
	"example", "sample", "dummy", "placeholder", "your_", "your-", "yourkey", "your key",
	"changeme", "change_me", "redacted", "masked", "xxxxxx", "******", "……", "...",
	"${", "{{", "<", ">", "test_key", "test-key", "testkey", "fake", "not_a_real", "notreal",
	"replace_me", "replaceme", "insert_", "todo",
}

// IsPlaceholder 判断值是否像文档示例、占位符或低熵字符串。
func IsPlaceholder(v string) bool {
	l := strings.ToLower(v)
	for _, w := range placeholderWords {
		if strings.Contains(l, w) {
			return true
		}
	}
	if len(v) >= 16 && entropy(v) < 3.0 {
		return true
	}
	// 精确重复较短单元的长值常见于测试夹具（例如把一段十六进制字母表
	// 重复数次凑足密钥长度）。这类值的香农熵可能刚好越过低熵阈值，仍不应
	// 被当作真实凭证；至少重复三次才降级，避免把偶然的双段结构误判为占位。
	if isRepeatedPattern(v) {
		return true
	}
	// 全部由遮盖/填充字符组成的值（***、xxx、....、----）一定是占位，
	// 与长度无关：真实数据里 postgres://user:***@host 这类脱敏串很常见，
	// 靠上面的熵值下限挡不住（长度不足 16）。
	if isFillerOnly(v) {
		return true
	}
	return false
}

// isRepeatedPattern 判断值是否由同一个更短单元精确重复至少三次组成。
func isRepeatedPattern(v string) bool {
	if len(v) < 16 {
		return false
	}
	// KMP 前缀表在线性时间内给出最短周期，避免对不可信长值反复拼接比较。
	prefix := make([]int, len(v))
	for i := 1; i < len(v); i++ {
		j := prefix[i-1]
		for j > 0 && v[i] != v[j] {
			j = prefix[j-1]
		}
		if v[i] == v[j] {
			j++
		}
		prefix[i] = j
	}
	unitLen := len(v) - prefix[len(v)-1]
	return len(v)%unitLen == 0 && len(v)/unitLen >= 3
}

// isFillerOnly 判断值是否只由遮盖或填充字符组成。
func isFillerOnly(v string) bool {
	if v == "" {
		return false
	}
	for _, r := range v {
		switch r {
		case '*', 'x', 'X', '.', '-', '_', '#', '•', '●', '·':
		default:
			return false
		}
	}
	return true
}

func entropy(s string) float64 {
	if s == "" {
		return 0
	}
	counts := map[rune]int{}
	n := 0
	for _, r := range s {
		counts[r]++
		n++
	}
	var h float64
	for _, c := range counts {
		p := float64(c) / float64(n)
		h -= p * math.Log2(p)
	}
	return h
}

// Mask 生成脱敏片段。长值保留前 4 后 4；20 个字符以内的短值露出 8 个字符占比太高，
// 只保留前 2 个字符和长度。
func Mask(v string) string {
	r := []rune(v)
	switch {
	case len(r) <= 2:
		return "****"
	case len(r) < 20:
		return string(r[:2]) + "****(长度" + itoa(len(r)) + ")"
	default:
		return string(r[:4]) + "****" + string(r[len(r)-4:])
	}
}

func maskLen(v string) string {
	return "****(长度" + itoa(len([]rune(v))) + ")"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func containsAny(s string, words []string) bool {
	for _, w := range words {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}
