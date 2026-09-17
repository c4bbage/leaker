// 行为规则引擎（ECAP-008）：单事件匹配，只检测不拦截。
//
// 范围（实施方案 §5.1，PRODUCT §6）：
//   - 一条记录 → 一次判定，不做序列关联（序列是 v0.2 的 ECAP-009）；
//   - 只做检测，不做拦截；
//   - 不纳入破坏性操作规则——rm -rf、fork bomb、反弹 shell、持久化、
//     docker privileged、包管理等属 EDR，PRODUCT §6 已显式排除
//     （ESRC-014 记录了 CC-Monitor 33 条中 30 条不纳入的判断）。
//
// schema（Rule/Event/Finding）与 CC-Monitor 的 default_rules.json 独立撞型
// （ESRC-014），但本实现与其代码无关：该仓库无 LICENSE，不可复用。
//
// 路径判定统一走 paths.go 的 MatchPath（EBR-006 在行为侧的对应要求：
// 路径清单只有一份），绝不内联另一份清单。
//
// EBR-002 的行为侧体现：Finding.Excerpt 必须先脱敏再截断——命令行参数里
// 可能带着凭证原文（如 echo $PRIVATE_KEY 的输出、含 token 的 URL），
// behavior_test.go 的 TestExcerptNeverContainsCredential 用 rules.Scan
// 反扫护住这条规则。
package behavior

import (
	"regexp"
	"strings"

	"leakscan/internal/rules"
)

// Rule 是一条行为规则。
type Rule struct {
	ID       string   // 稳定标识，进 behavior.csv 的 rule_id 列
	Name     string   // 中文名，进报告
	Tools    []string // 适用的工具名（如 Read/Bash）；空表示全部工具
	Field    string   // 在 Event.Fields 的哪个字段上匹配，如 "command" / "file_path"
	Pattern  string   // RE2 正则；对路径字段以外的字段，匹配即命中
	Severity string   // 复用 rules.Sev*（EBR-006：严重程度词表只有一份）
	OS       []string // 限定平台；空表示全平台
}

// Event 是从会话记录归一化出的一次工具调用。
type Event struct {
	Tool   string            // 工具名，如 "Read" / "Bash"
	Fields map[string]string // 字段名 → 值（command、file_path 等）
}

// Finding 是一条行为命中。注意它没有凭证值、指纹和脱敏片段——
// 这正是它不能复用 detect.Hit 的原因：Hit 的三个核心字段
// （Fingerprint/Masked/Note）都依赖一条具体凭证，行为命中没有。
type Finding struct {
	RuleID   string
	Name     string
	Severity string
	Tool     string
	Field    string
	Excerpt  string // 命中片段，已截断；字段可能含凭证时必须先脱敏
}

// excerptLimit 限制 Excerpt 长度（字节）。命令行、路径都可能很长，
// 报告里只需要能认出是哪条命令/哪个文件。
const excerptLimit = 160

// sensitiveFields 是可能含凭证原文的字段。命中发生在这些字段上时，
// Excerpt 先用内容规则的占位符思路做一层保守脱敏（把疑似凭证形态的
// 长串替换掉），再截断。判定复用 rules.Scan：命中的片段用其 Masked。
func (f Finding) redactExcerpt(value string) string {
	// 先用内容规则反扫，把每处命中替换为"规则名+掩码"，杜绝原文落盘（EBR-002）。
	ms := rules.Scan(value)
	out := value
	// 从后往前替换，避免偏移错位。
	for i := len(ms) - 1; i >= 0; i-- {
		m := ms[i]
		if m.Value == "" || !strings.Contains(out, m.Value) {
			continue
		}
		out = strings.ReplaceAll(out, m.Value, m.Masked)
	}
	if len(out) > excerptLimit {
		out = out[:excerptLimit] + "…"
	}
	return out
}

// shellTools 是"执行命令"类工具在各 agent 中的名字。Claude Code 叫 Bash，
// Codex CLI 叫 shell / local_shell（实测，2026-09-15）。新适配器接入时把该
// agent 的命令执行工具名加进这里，行为规则不需要逐条改。
var shellTools = []string{"Bash", "shell", "local_shell"}

// rules 表。v0.1 必含五条（实施方案 §5.2），全部围绕凭证可见性。
//
// credential_cmd_read / credential_tool_invoke / env_dump 作用在 Bash 的
// command 字段上。command 是"未切词的自由文本"，其中路径可能不在末尾，
// 因此这三条规则不走"MatchPath(整条命令)"，而是由 Scan 先按分隔符切词
// （tokenizeCommand），对每个 token 逐个调 MatchPath——这正是 paths_test.go
// 的 TestMatchPathRequiresPathToken 钉住的调用契约。
var allRules = []Rule{
	{
		ID:       "credential_file_read",
		Name:     "读取了凭证文件",
		Tools:    []string{"Read", "open", "view"},
		Field:    "file_path",
		Severity: rules.SevHigh,
	},
	{
		ID:       "credential_file_write",
		Name:     "写入/修改了凭证文件",
		Tools:    []string{"Write", "Edit", "NotebookEdit"},
		Field:    "file_path",
		Severity: rules.SevMedium,
	},
	{
		ID:       "credential_cmd_read",
		Name:     "命令行读取凭证文件",
		Tools:    shellTools,
		Field:    "command",
		Severity: rules.SevHigh,
	},
	{
		ID:       "credential_tool_invoke",
		Name:     "调用系统凭证工具",
		Tools:    shellTools,
		Field:    "command",
		Severity: rules.SevHigh,
		// 平台凭证工具的查询子命令。按官方文档独立编写（Apple security(1)、
		// GNOME secret-tool、Windows cmdkey），未参考 CC-Monitor 的正则。
		Pattern: `(?:\bsecurity\s+(?:find-generic-password|find-internet-password|dump-keychain)\b)` +
			`|(?:\bsecret-tool\s+(?:lookup|search)\b)` +
			`|(?i)(?:\bcmdkey\s+/list\b)` +
			`|(?:\bkubectl\s+get\s+secrets?\b)` +
			`|(?i)(?:\bdocker\s+login\b)`,
	},
	{
		ID:       "env_dump",
		Name:     "整体导出环境变量",
		Tools:    shellTools,
		Field:    "command",
		Severity: rules.SevMedium,
		// env / printenv / export -p / Get-ChildItem Env:。`env` 只在作为
		// 独立命令（前导分隔符或行首）时才算整体导出——`git env`、
		// `python3 -m venv` 里的 env 子串不算；`env FOO=bar cmd` 是带
		// 赋值运行别的命令，也不是整体导出。命令后面跟重定向（> file）
		// 常见于把导出结果落盘，同样算命中。
		// 只认"命令位"（命令串开头或前导分隔符之后）——grep 参数、字符串
		// 字面量里的 "printenv" 不在命令位，不命中（真实扫描复检发现
		// grep 模式串误报）。(?m) 让 ^ 匹配多行命令的每一行行首：
		// 多行脚本里独立成行的 env 调用同样是整体导出。
		Pattern: `(?im)(?:^|&&|;|\||\()\s*(?:env|printenv|export\s+-p)\s*(?:$|&&|;|\||\)|#|>|<|\d*&)` +
			`|(?im)(?:^|&&|;|\||\()\s*Get-ChildItem\s+Env:`,
	},
	{
		ID:       "credential_grep_scan",
		Name:     "递归检索凭证关键词",
		Tools:    shellTools,
		Field:    "command",
		Severity: rules.SevMedium,
		// 对整个目录树递归 grep/rg 密码类关键词，是典型的"凭证搜刮"行为：
		// 一次命中可能带出大量凭证行。要求 grep 族工具名出现，且命令里同时
		// 含递归旗标（-r/-R/--recursive/rg 的 -g/--glob 也常用于全库）与
		// 凭证词；凭证词可能在引号里，所以前后都放行引号。普通的
		// `grep TODO main.go`（无递归）不命中。两个顺序方向各写一条。
		Pattern: `(?is)\b(grep|rg|ag|ack)\b[^|;&]{0,160}(\s-[a-zA-Z]*[rR][a-zA-Z]*\b|--recursive\b|\s-g\b|--glob\b)[^|;&]{0,260}\b(password|passwd|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|token)\b` +
			`|(?is)\b(password|passwd|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|token)\b[^|;&]{0,260}\b(grep|rg|ag|ack)\b[^|;&]{0,160}(\s-[a-zA-Z]*[rR][a-zA-Z]*\b|--recursive\b|\s-g\b|--glob\b)` +
			// rg/ag 默认就是递归的（ripgrep 手册/ag 手册），不需要递归旗标，
			// 单独一条：rg/ag + 凭证词即命中。
			`|(?is)\b(rg|ag)\b[^|;&]{0,260}\b(password|passwd|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|token)\b`,
	},
	{
		ID:       "proc_env_read",
		Name:     "读取进程环境变量",
		Tools:    shellTools,
		Field:    "command",
		Severity: rules.SevHigh,
		// /proc/<pid>/environ 是 Linux 上其他进程环境变量（含 ssh-agent 等
		// 凭证持有进程）的读取入口；pid 可以是数字、$VAR、${VAR}、$$(命令
		// 替换前缀) 或 self。macOS 等价物是 ps eww。按 proc(5) 与 ps(1)
		// 官方文档独立编写。
		Pattern: `/proc/(?:\d+|\$\([^)]*\)|\$\{[^}]+\}|\$\w+|self)/(?:environ|cmdline)\b|(?i)\bps\s+ew+[a-z]*\b`,
		OS:      []string{"linux", "darwin"},
	},
}

// compiled 是编译后的规则缓存。
type compiled struct {
	rule Rule
	re   *regexp.Regexp // Pattern 非空时才有
}

var compiledRules = func() []compiled {
	out := make([]compiled, 0, len(allRules))
	for _, r := range allRules {
		c := compiled{rule: r}
		if r.Pattern != "" {
			c.re = regexp.MustCompile(r.Pattern)
		}
		out = append(out, c)
	}
	return out
}()

// toolMatch 判断事件的工具名是否在规则的适用列表内。
func toolMatch(ruleTools []string, tool string) bool {
	if len(ruleTools) == 0 {
		return true
	}
	for _, t := range ruleTools {
		if strings.EqualFold(t, tool) {
			return true
		}
	}
	return false
}

// tokenizeCommand 把命令行切成候选路径 token（paths.go 的 MatchPath 契约
// 要求传入单个路径）。按空白与常见 shell 分隔符切分；保留引号内的整体。
func tokenizeCommand(cmd string) []string {
	var toks []string
	var cur strings.Builder
	inQuote := byte(0)
	flush := func() {
		if cur.Len() > 0 {
			toks = append(toks, strings.Trim(cur.String(), `"'`))
			cur.Reset()
		}
	}
	for i := range len(cmd) {
		c := cmd[i]
		switch {
		case inQuote != 0:
			if c == inQuote {
				inQuote = 0
			} else {
				cur.WriteByte(c)
			}
		case c == '"' || c == '\'':
			inQuote = c
		case c == ' ' || c == '\t' || c == '\n' || c == '|' || c == ';' || c == '>' || c == '<' || c == '&':
			flush()
		default:
			cur.WriteByte(c)
		}
	}
	flush()
	return toks
}

// Scan 对一次工具调用做单事件判定。同一条规则对同一事件至多产生一条
// Finding（避免 cat 多个文件时行为.csv 刷屏；具体路径在 Excerpt 里）。
func Scan(e Event) []Finding {
	var out []Finding
	seen := map[string]bool{}
	for _, c := range compiledRules {
		r := c.rule
		if !toolMatch(r.Tools, e.Tool) {
			continue
		}
		val, ok := e.Fields[r.Field]
		if !ok || val == "" {
			continue
		}
		matched := ""
		switch {
		case c.re != nil:
			if c.re.MatchString(val) {
				matched = val
			}
		case r.Field == "file_path":
			// file_path 是单个路径 token，直接走敏感路径表（EBR-006 行为侧）。
			if hits := MatchPath(val); len(hits) > 0 {
				matched = val
			}
		case r.Field == "command":
			// command 是自由文本：切词后逐 token 过敏感路径表。
			hit := false
			for _, tok := range tokenizeCommand(val) {
				if len(MatchPath(tok)) > 0 {
					hit = true
					matched = tok // Excerpt 用命中的那个路径，不用整条命令
					break
				}
			}
			if !hit {
				// 路径不在 token 里但命令模式（如 ssh-add /path）可能整串命中，
				// 已由上面 c.re 分支处理；这里兜底用整条命令再试一次路径表。
				if len(MatchPath(val)) > 0 {
					matched = val
				}
			}
		}
		if matched == "" || seen[r.ID] {
			continue
		}
		seen[r.ID] = true
		f := Finding{RuleID: r.ID, Name: r.Name, Severity: r.Severity, Tool: e.Tool, Field: r.Field}
		if r.Field == "command" && c.re != nil {
			// 命令模式规则（credential_tool_invoke / env_dump）：截断展示命令本身。
			f.Excerpt = f.redactExcerpt(val)
		} else {
			f.Excerpt = f.redactExcerpt(matched)
		}
		out = append(out, f)
	}
	return out
}
