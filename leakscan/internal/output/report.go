package output

import (
	"bufio"
	"cmp"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"leakscan/internal/rules"
)

// Finding 是按"员工（或 Key）+ 凭证指纹"汇总的发现，可从 hits.csv 随时重算。
type Finding struct {
	Subject     string
	UserID      string
	UserName    string
	DeptName    string
	RuleID      string
	TypeName    string
	Tier        int
	Severity    string
	Confidence  string
	FirstCall   time.Time
	LastCall    time.Time
	Requests    map[string]bool
	Roles       map[string]bool
	Tables      map[string]bool
	UserAgents  map[string]bool
	Fingerprint string
	Masked      string
	Note        string
	GatewayKey  string
	SameFPUsers int
	priority    int
}

var sevRank = map[string]int{rules.SevHigh: 3, rules.SevMedium: 2, rules.SevLow: 1}

// tier3 记录本次聚合中被排除的第三层命中数（按规则）。
var tier3 map[string]int

// BuildReport 读取 hits.csv 生成 findings.csv 与 summary.md。
// p 决定报告措辞与统计口径：leakscan 传 GatewayProfile()，leakagent 传 EndpointProfile()。
func BuildReport(dir string, p Profile) error {
	st, err := LoadState(dir)
	if err != nil {
		return fmt.Errorf("读取断点/覆盖统计：%w", err)
	}
	findings, placeholders, err := aggregate(filepath.Join(dir, HitsFile))
	if err != nil {
		return err
	}
	if err := writeFindings(filepath.Join(dir, FindingsFile), findings, p); err != nil {
		return err
	}
	return writeSummary(filepath.Join(dir, SummaryFile), st, findings, placeholders, p)
}

func aggregate(path string) ([]*Finding, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	br := bufio.NewReader(f)
	if b, _ := br.Peek(3); string(b) == "\xef\xbb\xbf" {
		br.Discard(3)
	}
	r := csv.NewReader(br)
	r.FieldsPerRecord = -1
	header, err := r.Read()
	if err != nil {
		return nil, 0, fmt.Errorf("读取 hits.csv 表头：%w", err)
	}
	col := map[string]int{}
	for i, h := range header {
		col[h] = i
	}
	get := func(row []string, name string) string {
		i, ok := col[name]
		if !ok || i >= len(row) {
			return ""
		}
		return strings.TrimPrefix(row[i], "'")
	}
	byKey := map[string]*Finding{}
	placeholders := 0
	tier3 = map[string]int{}
	for {
		row, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, 0, fmt.Errorf("读取 hits.csv：%w", err)
		}
		if get(row, "confidence") == rules.ConfPlaceholder {
			placeholders++
			continue
		}
		// 第三层（JWT、口令字段）在真实代码流量中误报多，默认只保留在 hits.csv，单独计数
		if rules.TypeOf(get(row, "rule_id")).Tier >= 3 {
			tier3[get(row, "rule_id")]++
			continue
		}
		subject := get(row, "user_id")
		if subject == "" {
			subject = "key:" + get(row, "key_id")
		}
		fp := get(row, "fingerprint")
		k := subject + "|" + fp
		ts, _ := time.Parse(time.RFC3339, get(row, "call_ts"))
		ruleID := get(row, "rule_id")
		t := rules.TypeOf(ruleID)
		fd, ok := byKey[k]
		if !ok {
			fd = &Finding{Subject: subject, UserID: get(row, "user_id"), UserName: get(row, "user_name"), DeptName: get(row, "dept_name"),
				RuleID: ruleID, TypeName: t.Name, Tier: t.Tier, Severity: get(row, "severity"), Confidence: get(row, "confidence"),
				FirstCall: ts, LastCall: ts, Requests: map[string]bool{}, Roles: map[string]bool{}, Tables: map[string]bool{}, UserAgents: map[string]bool{},
				Fingerprint: fp, Masked: get(row, "masked"), Note: get(row, "note"), GatewayKey: get(row, "gateway_key"), priority: t.Priority}
			byKey[k] = fd
		}
		if t.Priority < fd.priority {
			fd.priority, fd.RuleID, fd.TypeName, fd.Tier, fd.Masked, fd.Note = t.Priority, ruleID, t.Name, t.Tier, get(row, "masked"), get(row, "note")
		}
		if s := get(row, "severity"); sevRank[s] > sevRank[fd.Severity] {
			fd.Severity = s
		}
		if ts.Before(fd.FirstCall) {
			fd.FirstCall = ts
		}
		if ts.After(fd.LastCall) {
			fd.LastCall = ts
		}
		if g := get(row, "gateway_key"); g != "" {
			fd.GatewayKey = g
		}
		fd.Requests[get(row, "request_id")] = true
		fd.Tables[get(row, "table")] = true
		for role := range strings.SplitSeq(get(row, "roles"), ";") {
			if role != "" {
				fd.Roles[role] = true
			}
		}
		if ua := get(row, "user_agent"); ua != "" && len(fd.UserAgents) < 5 {
			fd.UserAgents[ua] = true
		}
	}
	// 同一凭证出现在多个员工名下：可能是共享凭证，或贴出了他人的凭证
	usersByFP := map[string]map[string]bool{}
	for _, fd := range byKey {
		if usersByFP[fd.Fingerprint] == nil {
			usersByFP[fd.Fingerprint] = map[string]bool{}
		}
		usersByFP[fd.Fingerprint][fd.Subject] = true
	}
	out := slices.Collect(maps.Values(byKey))
	for _, fd := range out {
		fd.SameFPUsers = len(usersByFP[fd.Fingerprint])
	}
	slices.SortFunc(out, func(a, b *Finding) int {
		if sevRank[a.Severity] != sevRank[b.Severity] {
			return cmp.Compare(sevRank[b.Severity], sevRank[a.Severity])
		}
		if a.Tier != b.Tier {
			return cmp.Compare(a.Tier, b.Tier)
		}
		if len(a.Requests) != len(b.Requests) {
			return cmp.Compare(len(b.Requests), len(a.Requests))
		}
		return cmp.Compare(a.Subject+a.Fingerprint, b.Subject+b.Fingerprint)
	})
	return out, placeholders, nil
}

func keys(m map[string]bool) string {
	return strings.Join(slices.Sorted(maps.Keys(m)), ";")
}

func sampleKeys(m map[string]bool, n int) string {
	out := slices.Sorted(maps.Keys(m))
	if len(out) > n {
		out = out[:n]
	}
	return strings.Join(out, ";")
}

// writeFindings 生成 findings.csv。端上 Profile 隐藏部门列（恒为空，无意义）。
func writeFindings(path string, fs []*Finding, p Profile) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	f.WriteString("\xef\xbb\xbf")
	w := csv.NewWriter(f)
	header := []string{"severity", "tier", "type_name", "rule_id", "user_id", "user_name", "dept_name", "first_call", "last_call",
		"request_count", "roles", "tables", "masked", "fingerprint", "same_credential_users", "note", "gateway_key", "user_agents", "sample_request_ids"}
	if !p.ShowDeptColumn {
		header = []string{"severity", "tier", "type_name", "rule_id", "user_id", "user_name", "first_call", "last_call",
			"request_count", "roles", "tables", "masked", "fingerprint", "same_credential_users", "note", "gateway_key", "user_agents", "sample_request_ids"}
	}
	w.Write(header)
	for _, fd := range fs {
		row := []string{fd.Severity, strconv.Itoa(fd.Tier), fd.TypeName, fd.RuleID, fd.UserID, fd.UserName, fd.DeptName,
			fd.FirstCall.Format(time.RFC3339), fd.LastCall.Format(time.RFC3339), strconv.Itoa(len(fd.Requests)), keys(fd.Roles), keys(fd.Tables),
			fd.Masked, fd.Fingerprint, strconv.Itoa(fd.SameFPUsers), fd.Note, fd.GatewayKey, keys(fd.UserAgents), sampleKeys(fd.Requests, 3)}
		if !p.ShowDeptColumn {
			row = append(row[:6], row[7:]...) // 去掉 dept_name（第 6 列）
		}
		w.Write(sanitize(row))
	}
	w.Flush()
	return w.Error()
}

var roleNames = map[string]string{
	"user_input": "用户输入", "tool_result": "工具结果（agent 读取）", "tool_call": "工具调用参数", "system": "系统提示",
	"assistant_history": "历史模型回复", "model_output": "模型输出", "model_reasoning": "模型推理", "tool_definition": "工具定义",
	"request_header": "请求头", "request_other": "请求其他字段", "raw_unparsed": "无法解析的原文",
}

func writeSummary(path string, st *RunState, fs []*Finding, placeholders int, prof Profile) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	p := func(format string, a ...any) { fmt.Fprintf(f, format, a...) }

	p("# %s\n\n", prof.ReportTitle)
	p("> %s\n\n", prof.SensitivityNote)
	p("| 项 | 值 |\n| --- | --- |\n")
	if st.Source != "" {
		p("| 输入文件 | %s |\n", md(st.Source))
	} else {
		p("| 扫描窗口 | %s ~ %s |\n", st.From.Format(time.RFC3339), st.To.Format(time.RFC3339))
		p("| 扫描表 | %s |\n", strings.Join(st.Tables, "、"))
	}
	p("| 规则集版本 | %s |\n", st.RulesetVersion)
	p("| 开始 / 更新时间 | %s / %s |\n", st.StartedAt.Format(time.RFC3339), st.UpdatedAt.Format(time.RFC3339))
	status := "未完成（可用 -resume 继续）"
	if st.Source != "" {
		status = "未完成（文件扫描不支持续扫，请重新扫描）"
	}
	if st.FinishedAt != nil {
		status = "已完成 " + st.FinishedAt.Format(time.RFC3339)
	}
	p("| 状态 | %s |\n\n", status)

	p("## 1. 检测覆盖\n\n")
	p("%s\n\n", prof.CoverageNote)
	if prof.CoverageGapLabels == nil {
		// 网关固定表：逐字保持原有输出（TestGatewayReportUnchanged 护住）。
		p("| 表 | 记录数 | 有请求体 | 有响应体 | 无内容（Key 关闭日志） | 无内容（其他原因） | 请求体解析失败 | 超过大小上限未扫 | 有命中的记录 |\n")
		p("| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n")
		for _, t := range st.Tables {
			c := st.Coverage[t]
			if c == nil {
				continue
			}
			p("| %s | %d | %d（%s） | %d | %d | %d | %d | %d | %d |\n", t, c.Rows, c.WithRequestBody, pct(c.WithRequestBody, c.Rows),
				c.WithResponseBody, c.NoContentLogOff, c.NoContentUnknown, c.RequestParseFail, c.Oversize, c.RecordsWithHits)
		}
		for _, t := range st.Tables {
			if c := st.Coverage[t]; c != nil && c.Oversize > 0 {
				p("\n**注意：`%s` 有 %d 条记录因内容超过大小上限未扫描。** 超大的往往是带文件内容的长 agent 会话，恰恰是私钥最可能出现的地方。请调大 `-max-body` 后对这些时段重扫。\n", t, c.Oversize)
			}
		}
	} else {
		// 端上表：基础计数 + 由 CoverageGapLabels 决定渲染哪些缺口列。
		// 列序由 coverageGapFields 固定，不依赖 map 遍历顺序。
		p("| 表 | 记录数 | 有请求体 | 有响应体")
		for _, f := range coverageGapFields {
			if label := prof.CoverageGapLabels[f]; label != "" {
				p(" | %s", label)
			}
		}
		p(" | 有命中的记录 |\n")
		p("| --- | --- | --- | ---")
		for _, f := range coverageGapFields {
			if prof.CoverageGapLabels[f] != "" {
				p(" | ---")
			}
		}
		p(" | --- |\n")
		for _, t := range st.Tables {
			c := st.Coverage[t]
			if c == nil {
				continue
			}
			p("| %s | %d | %d | %d", t, c.Rows, c.WithRequestBody, c.WithResponseBody)
			for _, f := range coverageGapFields {
				if prof.CoverageGapLabels[f] != "" {
					p(" | %d", gapValue(c, f))
				}
			}
			p(" | %d |\n", c.RecordsWithHits)
		}
	}
	if st.Source != "" {
		p("%s", prof.FileModeNote)
	} else {
		p("\ncall_traces 的记录按其自身写入时间筛选，归属信息取自同一 request_id 的 call_logs。\n\n")
	}

	if prof.ShowSystemIssues {
		p("## 2. 系统性问题：网关自身保存了调用方凭证\n\n")
		sys := false
		for _, t := range st.Tables {
			if c := st.Coverage[t]; c != nil && c.AuthHeader > 0 {
				sys = true
				p("- `%s`：%d 条记录的请求头中保存了认证头，其中 **%d 条疑似未脱敏**。这意味着网关库本身就是一份调用方 Key 清单，需要网关侧在落库前脱敏，并评估轮换。\n", t, c.AuthHeader, c.AuthUnmasked)
			}
		}
		if !sys {
			p("未发现请求头中保存认证头（或本次未扫描 call_traces）。\n")
		}
	}

	people := map[string]bool{}
	high := 0
	for _, fd := range fs {
		people[fd.Subject] = true
		if fd.Severity == rules.SevHigh {
			high++
		}
	}
	p("\n## 3. 总览\n\n")
	p("- 发现 %d 个（%s × 凭证），涉及 %d %s，其中高危 %d 个。\n", len(fs), prof.SubjectNoun, len(people), prof.SubjectCountLabel, high)
	p("- 已排除疑似示例或占位值的命中 %d 条（明细仍保留在 hits.csv，置信度为 placeholder）。\n", placeholders)
	if len(tier3) > 0 {
		var parts []string
		for _, t := range rules.Types() {
			if n := tier3[t.ID]; n > 0 {
				parts = append(parts, fmt.Sprintf("%s %d 条", t.Name, n))
			}
		}
		p("- 第三层低危命中（误报较多，未计入发现，明细见 hits.csv）：%s。\n", strings.Join(parts, "、"))
	}
	p("\n")

	p("## 4. 按凭证类型\n\n| 层级 | 类型 | 发现数 | 高危 | 涉及%s |\n| --- | --- | --- | --- | --- |\n", prof.SubjectNoun)
	type agg struct {
		n, high int
		people  map[string]bool
	}
	byType := map[string]*agg{}
	for _, fd := range fs {
		a := byType[fd.RuleID]
		if a == nil {
			a = &agg{people: map[string]bool{}}
			byType[fd.RuleID] = a
		}
		a.n++
		if fd.Severity == rules.SevHigh {
			a.high++
		}
		a.people[fd.Subject] = true
	}
	for _, t := range rules.Types() {
		if a := byType[t.ID]; a != nil {
			p("| %d | %s | %d | %d | %d |\n", t.Tier, t.Name, a.n, a.high, len(a.people))
		}
	}
	tier1 := []string{"ssh_private_key", "vpn_openvpn", "vpn_wireguard", "vpn_ipsec_psk", "aliyun_accesskey", "gitlab_token"}
	var missing []string
	for _, id := range tier1 {
		if byType[id] == nil {
			missing = append(missing, rules.TypeOf(id).Name)
		}
	}
	if len(missing) > 0 {
		p("\n第一层类型中本次未发现：%s。\n", strings.Join(missing, "、"))
	}

	if st.Source == "" && prof.ShowDBSections {
		p("\n## 5. 按部门\n\n| 部门 | 发现数 | 高危 | 涉及%s |\n| --- | --- | --- | --- |\n", prof.SubjectNoun)
		byDept := map[string]*agg{}
		for _, fd := range fs {
			d := fd.DeptName
			if d == "" {
				d = "（未知）"
			}
			a := byDept[d]
			if a == nil {
				a = &agg{people: map[string]bool{}}
				byDept[d] = a
			}
			a.n++
			if fd.Severity == rules.SevHigh {
				a.high++
			}
			a.people[fd.Subject] = true
		}
		depts := slices.Collect(maps.Keys(byDept))
		slices.SortFunc(depts, func(a, b string) int {
			if byDept[a].high != byDept[b].high {
				return cmp.Compare(byDept[b].high, byDept[a].high)
			}
			return cmp.Compare(a, b)
		})
		for _, d := range depts {
			a := byDept[d]
			p("| %s | %d | %d | %d |\n", d, a.n, a.high, len(a.people))
		}
	}

	p("\n## 6. 凭证从哪里出去的（来源角色）\n\n")
	p("%s\n\n| 来源 | 发现数 |\n| --- | --- |\n", prof.RoleSectionNote)
	byRole := map[string]int{}
	for _, fd := range fs {
		for r := range fd.Roles {
			byRole[r]++
		}
	}
	roles := slices.Collect(maps.Keys(byRole))
	// 计数相同时按角色名排序，保证输出确定（map 遍历次序随机）。
	slices.SortFunc(roles, func(a, b string) int {
		if byRole[a] != byRole[b] {
			return cmp.Compare(byRole[b], byRole[a])
		}
		return cmp.Compare(a, b)
	})
	for _, r := range roles {
		name := roleNames[r]
		if name == "" {
			name = r
		}
		p("| %s | %d |\n", name, byRole[r])
	}

	if st.Source == "" && prof.ShowDBSections {
		p("\n## 7. 客户端（User-Agent）\n\n| 客户端 | 发现数 |\n| --- | --- |\n")
		byUA := map[string]int{}
		for _, fd := range fs {
			for ua := range fd.UserAgents {
				byUA[shortUA(ua)]++
			}
		}
		uas := slices.Collect(maps.Keys(byUA))
		// 计数相同时按名字典序排定，保证输出确定（否则相等元素的次序会随
		// map 遍历漂移，黄金文件测试会偶发失败）。
		slices.SortFunc(uas, func(a, b string) int {
			if byUA[a] != byUA[b] {
				return cmp.Compare(byUA[b], byUA[a])
			}
			return cmp.Compare(a, b)
		})
		for i, u := range uas {
			if i >= 15 {
				break
			}
			p("| %s | %d |\n", strings.ReplaceAll(u, "|", "\\|"), byUA[u])
		}
	}

	// 端上报告的"Agent 行为观察"插在 §7 的位置（网关没有 UA 节也没有行为节），
	// 高危发现表仍叫 §8，两个产品的章节号保持一致。
	if !prof.ShowDBSections && st.Source != "" {
		writeBehaviorSection(p, filepath.Dir(path))
	}

	p("\n## 8. 高危发现（前 50 条，完整列表见 findings.csv）\n\n")
	if prof.ShowDeptColumn {
		p("| 员工 | 部门 | 类型 | 脱敏片段 | 来源 | 调用次数 | 首次 | 最近 | 同一凭证涉及人数 | 说明 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n")
	} else {
		p("| %s | 类型 | 脱敏片段 | 来源 | 调用次数 | 首次 | 最近 | 同一凭证涉及人数 | 说明 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n", prof.SubjectNoun)
	}
	n := 0
	for _, fd := range fs {
		if fd.Severity != rules.SevHigh {
			continue
		}
		if n >= 50 {
			break
		}
		n++
		name := fd.UserName
		if name == "" {
			name = fd.Subject
		}
		var rs []string
		for r := range fd.Roles {
			if roleNames[r] != "" {
				rs = append(rs, roleNames[r])
			} else {
				rs = append(rs, r)
			}
		}
		slices.Sort(rs)
		if prof.ShowDeptColumn {
			p("| %s | %s | %s | `%s` | %s | %d | %s | %s | %d | %s |\n", md(name), md(fd.DeptName), fd.TypeName, strings.ReplaceAll(fd.Masked, "`", "'"),
				strings.Join(rs, "、"), len(fd.Requests), shortTime(fd.FirstCall), shortTime(fd.LastCall), fd.SameFPUsers, md(fd.Note))
		} else {
			p("| %s | %s | `%s` | %s | %d | %s | %s | %d | %s |\n", md(name), fd.TypeName, strings.ReplaceAll(fd.Masked, "`", "'"),
				strings.Join(rs, "、"), len(fd.Requests), shortTime(fd.FirstCall), shortTime(fd.LastCall), fd.SameFPUsers, md(fd.Note))
		}
	}
	if n == 0 {
		p("| （无） |\n")
	}
	if len(st.Errors) > 0 {
		p("\n## 9. 扫描错误\n\n")
		for _, e := range st.Errors {
			p("- %s\n", md(e))
		}
	}
	return nil
}

// coverageGapFields 固定端上覆盖表缺口列的渲染顺序。Go map 遍历顺序随机，
// 不能拿来决定列序，否则端上报告的列序不稳定。
var coverageGapFields = []string{
	"RequestParseFail", "ResponseParseFail", "Oversize",
	"AgentUnsupported", "ParseFailed", "FileVanished",
}

// gapValue 按字段名取 Coverage 上的缺口计数。名字必须与 coverageGapFields
// / Profile.CoverageGapLabels 的键一致；未知名字返回 0（不渲染是调用方的责任）。
func gapValue(c *Coverage, field string) int64 {
	switch field {
	case "RequestParseFail":
		return c.RequestParseFail
	case "ResponseParseFail":
		return c.ResponseParseFail
	case "Oversize":
		return c.Oversize
	case "AgentUnsupported":
		return c.AgentUnsupported
	case "ParseFailed":
		return c.ParseFailed
	case "FileVanished":
		return c.FileVanished
	}
	return 0
}

// behaviorAgg 是按规则聚合的行为观察计数。
type behaviorAgg struct {
	RuleID   string
	RuleName string
	Severity string
	Count    int
	LastSeen string // 最近一次的 session:line，便于回查
}

// loadBehavior 读取 behavior.csv 并按规则聚合。文件不存在是正常情况
// （没有行为命中 / 网关侧不产生该文件），返回 nil。
func loadBehavior(dir string) []*behaviorAgg {
	f, err := os.Open(filepath.Join(dir, BehaviorFile))
	if err != nil {
		return nil
	}
	defer f.Close()
	r := csv.NewReader(f)
	header, err := r.Read()
	if err != nil {
		return nil
	}
	col := map[string]int{}
	for i, h := range header {
		col[h] = i
	}
	get := func(row []string, name string) string {
		i, ok := col[name]
		if !ok || i >= len(row) {
			return ""
		}
		return row[i]
	}
	byRule := map[string]*behaviorAgg{}
	var order []*behaviorAgg
	for {
		row, err := r.Read()
		if err != nil {
			break
		}
		id := get(row, "rule_id")
		if id == "" {
			continue
		}
		a := byRule[id]
		if a == nil {
			a = &behaviorAgg{RuleID: id, RuleName: get(row, "rule_name"), Severity: get(row, "severity")}
			byRule[id] = a
			order = append(order, a)
		}
		a.Count++
		a.LastSeen = get(row, "source_file") + ":" + get(row, "line")
	}
	var rank = map[string]int{rules.SevHigh: 3, rules.SevMedium: 2, rules.SevLow: 1}
	// 稳定排序保留严重程度、次数均相同时的首次出现顺序。
	slices.SortStableFunc(order, func(a, b *behaviorAgg) int {
		if rank[a.Severity] != rank[b.Severity] {
			return cmp.Compare(rank[b.Severity], rank[a.Severity])
		}
		return cmp.Compare(b.Count, a.Count)
	})
	return order
}

// writeBehaviorSection 渲染"Agent 行为观察"。行为命中与凭证发现分开陈述
// （两者整改动作不同），只对端上报告渲染（网关流量里没有工具调用事件）。
func writeBehaviorSection(p func(format string, a ...any), dir string) {
	aggs := loadBehavior(dir)
	if aggs == nil {
		return
	}
	p("\n## 7. Agent 行为观察\n\n")
	p("以下是 agent 读取/写入凭证文件、调用凭证工具的记录（不针对具体凭证）。\"工具结果\"类命中说明 agent 的自动化读取碰到了凭证；整改重点是收窄 agent 的读取范围。\n\n")
	p("| 严重程度 | 行为 | 次数 | 最近位置 |\n| --- | --- | --- | --- |\n")
	for _, a := range aggs {
		p("| %s | %s | %d | %s |\n", a.Severity, a.RuleName, a.Count, md(a.LastSeen))
	}
}

func shortTime(t time.Time) string {
	if t.IsZero() || t.Year() <= 1 {
		return "—"
	}
	return t.Format("2006-01-02 15:04")
}

func pct(a, b int64) string {
	if b == 0 {
		return "—"
	}
	return fmt.Sprintf("%.1f%%", float64(a)*100/float64(b))
}

func md(s string) string { return strings.ReplaceAll(strings.ReplaceAll(s, "|", "\\|"), "\n", " ") }

func shortUA(ua string) string {
	if i := strings.IndexAny(ua, " ("); i > 0 {
		return ua[:i]
	}
	if len(ua) > 60 {
		return ua[:60]
	}
	return ua
}
