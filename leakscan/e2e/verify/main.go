// verify 核对端到端扫描结果：预期发现齐全、续扫与完整扫描一致、输出文件不含凭证原文。
package main

import (
	"bufio"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"leakscan/internal/output"
	"leakscan/internal/rules"
)

var failed bool

func check(ok bool, format string, a ...any) {
	status := "通过"
	if !ok {
		status = "失败"
		failed = true
	}
	fmt.Printf("[%s] %s\n", status, fmt.Sprintf(format, a...))
}

func readCSV(path string) []map[string]string {
	f, err := os.Open(path)
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	defer f.Close()
	br := bufio.NewReader(f)
	if b, _ := br.Peek(3); string(b) == "\xef\xbb\xbf" {
		br.Discard(3)
	}
	r := csv.NewReader(br)
	rows, err := r.ReadAll()
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	var out []map[string]string
	for _, row := range rows[1:] {
		m := map[string]string{}
		for i, h := range rows[0] {
			m[h] = row[i]
		}
		out = append(out, m)
	}
	return out
}

func main() {
	full := flag.String("full", "", "完整扫描目录")
	resumed := flag.String("resumed", "", "中断续扫目录")
	probe := flag.String("probe", "", "probe 输出")
	flag.Parse()

	fs := readCSV(filepath.Join(*full, output.FindingsFile))
	has := func(name, rule, sev string, extra func(map[string]string) bool) bool {
		for _, f := range fs {
			if f["user_name"] == name && f["rule_id"] == rule && f["severity"] == sev && (extra == nil || extra(f)) {
				return true
			}
		}
		return false
	}
	check(has("张三", "ssh_private_key", "high", func(f map[string]string) bool {
		return f["request_count"] == "3" && f["roles"] == "tool_result"
	}), "张三：agent 工具结果中的 SSH 私钥，3 次调用合并为 1 个发现")
	check(has("李四", "aliyun_accesskey", "high", func(f map[string]string) bool { return f["roles"] == "user_input" }), "李四：用户输入中成对的阿里云 AK/SK")
	check(has("王五", "gitlab_token", "high", nil), "王五：git 地址内嵌 GitLab 令牌")
	check(has("王五", "vpn_openvpn", "high", nil), "王五：OpenVPN 配置含静态密钥")
	check(has("王五", "github_token", "high", func(f map[string]string) bool { return f["roles"] == "model_output" }), "王五：模型输出中出现 GitHub 令牌")
	check(has("赵六", "vpn_wireguard", "high", func(f map[string]string) bool { return f["roles"] == "tool_result" }), "赵六：Responses API 工具结果中的 WireGuard 私钥")
	check(has("孙七", "gateway_api_key", "high", func(f map[string]string) bool { return strings.Contains(f["note"], "他人") }), "孙七：贴出他人的本网关 Key")
	zhangSSH := 0
	for _, f := range fs {
		if f["user_name"] == "张三" && f["rule_id"] == "ssh_private_key" {
			zhangSSH++
		}
	}
	check(zhangSSH == 1, "张三的 SSH 私钥只有 1 个发现（实际 %d）", zhangSSH)
	for _, f := range fs {
		if f["user_name"] == "周八" {
			check(false, "周八（无泄漏）不应出现在发现中")
		}
	}

	var st output.RunState
	b, _ := os.ReadFile(filepath.Join(*full, output.CheckpointFile))
	json.Unmarshal(b, &st)
	cl := st.Coverage["call_logs"]
	check(cl != nil && cl.NoContentLogOff == 20, "覆盖统计：Key 关闭日志的无内容记录 20 条（实际 %d）", cl.NoContentLogOff)
	ct := st.Coverage["call_traces"]
	check(ct != nil && ct.AuthUnmasked > 0, "系统性问题：call_traces 请求头认证信息未脱敏 %d 条", ct.AuthUnmasked)
	summary, _ := os.ReadFile(filepath.Join(*full, output.SummaryFile))
	check(strings.Contains(string(summary), "没有发现 ≠ 没有泄漏"), "报告包含覆盖说明")
	check(strings.Contains(string(summary), "已排除疑似示例或占位值的命中") && !strings.Contains(string(summary), "已排除疑似示例或占位值的命中 0 条"), "文档示例 AK 已被排除")

	// 续扫结果必须与完整扫描一致
	a, _ := os.ReadFile(filepath.Join(*full, output.FindingsFile))
	c, _ := os.ReadFile(filepath.Join(*resumed, output.FindingsFile))
	check(string(a) == string(c), "中断续扫的 findings.csv 与完整扫描完全一致")
	check(sortedHits(*full) == sortedHits(*resumed), "中断续扫的 hits.csv 与完整扫描行集合一致（无重复、无遗漏）")
	var st2 output.RunState
	b, _ = os.ReadFile(filepath.Join(*resumed, output.CheckpointFile))
	json.Unmarshal(b, &st2)
	check(st2.Coverage["call_logs"].Rows == cl.Rows && st2.Coverage["call_traces"].Rows == ct.Rows,
		"续扫覆盖行数一致（call_logs %d/%d，call_traces %d/%d）", st2.Coverage["call_logs"].Rows, cl.Rows, st2.Coverage["call_traces"].Rows, ct.Rows)

	// 用识别规则反扫全部输出文件：除占位值外不能再识别出任何凭证
	for _, dir := range []string{*full, *resumed} {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			data, _ := os.ReadFile(filepath.Join(dir, e.Name()))
			var leaks []string
			for _, m := range rules.Scan(string(data)) {
				if m.Confidence != rules.ConfPlaceholder && m.RuleID != "jwt" && m.RuleID != "password_field" {
					leaks = append(leaks, m.RuleID)
				}
			}
			check(len(leaks) == 0, "%s/%s 不含可识别的凭证原文 %v", filepath.Base(dir), e.Name(), leaks)
			info, _ := os.Stat(filepath.Join(dir, e.Name()))
			check(info.Mode().Perm() == 0o600, "%s/%s 权限为 0600（实际 %o）", filepath.Base(dir), e.Name(), info.Mode().Perm())
		}
	}
	probeData, _ := os.ReadFile(*probe)
	var probeLeaks []string
	for _, m := range rules.Scan(string(probeData)) {
		if m.Confidence != rules.ConfPlaceholder {
			probeLeaks = append(probeLeaks, m.RuleID)
		}
	}
	check(len(probeLeaks) == 0, "probe 输出不含凭证原文 %v", probeLeaks)

	if failed {
		os.Exit(1)
	}
}

func sortedHits(dir string) string {
	rows := readCSV(filepath.Join(dir, output.HitsFile))
	var lines []string
	for _, r := range rows {
		lines = append(lines, strings.Join([]string{r["table"], r["request_id"], r["rule_id"], r["fingerprint"], r["roles"], r["occurrences"], r["severity"]}, "|"))
	}
	slices.Sort(lines)
	return strings.Join(lines, "\n")
}
