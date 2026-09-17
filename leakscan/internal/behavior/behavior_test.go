package behavior_test

import (
	"strings"
	"testing"

	"leakscan/internal/behavior"
	"leakscan/internal/rules"
	"leakscan/internal/testfixture"
)

// ---- 实施方案 §5.5 的验收清单 ----

// TestCredentialFileReadFires：Read 读敏感路径必须命中。
func TestCredentialFileReadFires(t *testing.T) {
	fs := behavior.Scan(behavior.Event{
		Tool:   "Read",
		Fields: map[string]string{"file_path": "/home/u/.ssh/id_rsa"},
	})
	if len(fs) == 0 {
		t.Fatal("读取 ~/.ssh/id_rsa 未产生任何行为命中")
	}
	if fs[0].RuleID != "credential_file_read" {
		t.Errorf("RuleID = %q，期望 credential_file_read", fs[0].RuleID)
	}
	if fs[0].Severity != rules.SevHigh {
		t.Errorf("Severity = %q，期望 high", fs[0].Severity)
	}
}

// TestCredentialFileWriteFires：Write/Edit 写敏感路径命中 medium。
func TestCredentialFileWriteFires(t *testing.T) {
	for _, tool := range []string{"Write", "Edit"} {
		fs := behavior.Scan(behavior.Event{
			Tool:   tool,
			Fields: map[string]string{"file_path": "C:\\Users\\x\\.aws\\credentials"},
		})
		if len(fs) == 0 {
			t.Fatalf("%s 写 .aws\\credentials 未命中", tool)
		}
		if fs[0].RuleID != "credential_file_write" {
			t.Errorf("%s: RuleID = %q", tool, fs[0].RuleID)
		}
		if fs[0].Severity != rules.SevMedium {
			t.Errorf("%s: Severity = %q，期望 medium", tool, fs[0].Severity)
		}
	}
}

// TestCredentialCmdReadFires：Bash 命令行读凭证文件，路径夹在命令中间，
// 必须先切词再过敏感路径表（paths.go 的调用契约）。
func TestCredentialCmdReadFires(t *testing.T) {
	fs := behavior.Scan(behavior.Event{
		Tool:   "Bash",
		Fields: map[string]string{"command": "cat ~/.ssh/id_rsa > /tmp/out && echo done"},
	})
	found := false
	for _, f := range fs {
		if f.RuleID == "credential_cmd_read" {
			found = true
		}
	}
	if !found {
		t.Fatalf("cat ~/.ssh/id_rsa 未命中 credential_cmd_read，命中=%+v", fs)
	}
}

// TestNoFalsePositiveOnSourceCode：普通源码路径不得命中（否则报告被噪音淹没）。
func TestNoFalsePositiveOnSourceCode(t *testing.T) {
	cases := []behavior.Event{
		{Tool: "Read", Fields: map[string]string{"file_path": "src/env.ts"}},
		{Tool: "Read", Fields: map[string]string{"file_path": "test/fixtures/id_rsa.pub.example"}},
		{Tool: "Read", Fields: map[string]string{"file_path": "internal/config/loader.go"}},
		{Tool: "Bash", Fields: map[string]string{"command": "go test ./internal/... && go vet ./..."}},
		{Tool: "Bash", Fields: map[string]string{"command": "grep -rn Environment src/"}},
	}
	for _, e := range cases {
		if fs := behavior.Scan(e); len(fs) > 0 {
			t.Errorf("事件 %+v 不应命中，实际=%+v", e, fs)
		}
	}
}

// TestCredentialToolInvoke：平台凭证工具调用必须命中。
func TestCredentialToolInvoke(t *testing.T) {
	cases := []string{
		"security find-generic-password -s 'leakscan' -w",
		"secret-tool lookup service leakscan",
		"cmdkey /list",
		"kubectl get secrets -n prod",
		"docker login registry.example.com",
	}
	for _, cmd := range cases {
		fs := behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": cmd}})
		found := false
		for _, f := range fs {
			if f.RuleID == "credential_tool_invoke" {
				found = true
			}
		}
		if !found {
			t.Errorf("命令 %q 未命中 credential_tool_invoke，命中=%+v", cmd, fs)
		}
	}
}

// TestEnvDumpFires：整体导出环境变量命中 medium。
func TestEnvDumpFires(t *testing.T) {
	cases := []string{
		"env",
		"printenv",
		"env | grep -i token",
		"cd /app && printenv | sort",
	}
	for _, cmd := range cases {
		fs := behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": cmd}})
		found := false
		for _, f := range fs {
			if f.RuleID == "env_dump" {
				found = true
			}
		}
		if !found {
			t.Errorf("命令 %q 未命中 env_dump，命中=%+v", cmd, fs)
		}
	}
	// PowerShell 形态
	fs := behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": "Get-ChildItem Env:"}})
	if len(fs) == 0 || fs[0].RuleID != "env_dump" {
		t.Errorf("Get-ChildItem Env: 未命中 env_dump：%+v", fs)
	}
	// export -p（POSIX 整体导出）与多行脚本里独立成行的 env
	for _, cmd := range []string{"export -p", "cd /app && export -p > env.bak", "python3 - <<'EOF'\nprintenv\nEOF"} {
		if !hasRule(behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": cmd}}), "env_dump") {
			t.Errorf("命令 %q 应命中 env_dump", cmd)
		}
	}
	// 普通命令不命中：`set -e`、`setenv` 子串、含 "environment" 的词、
	// grep 参数/字符串字面量里的 "printenv"（不在命令位）
	for _, cmd := range []string{"set -e", "go env GOROOT", "echo $HOME", `grep -l "printenv" x.jsonl`, "echo printenv"} {
		if fs := behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": cmd}}); len(fs) > 0 {
			t.Errorf("命令 %q 不应命中，实际=%+v", cmd, fs)
		}
	}
}

// TestExcerptNeverContainsCredential 是 EBR-002 在行为侧的关键验收：
// 构造一个 Bash 事件其命令里含真实格式的私钥/令牌，
// 用 rules.Scan 反扫 Finding.Excerpt，非 placeholder 命中数必须为 0。
func TestExcerptNeverContainsCredential(t *testing.T) {
	g := testfixture.New(42)
	pk := g.PEM("OPENSSH ") // 生成真实格式的私钥块
	token := "glpat-" + strings.Repeat("x", 20)
	cases := []behavior.Event{
		{Tool: "Bash", Fields: map[string]string{
			"command": "echo '" + pk + "' > /tmp/k && cat ~/.ssh/id_rsa",
		}},
		{Tool: "Bash", Fields: map[string]string{
			"command": "security find-generic-password -s " + token + " -w",
		}},
		{Tool: "Bash", Fields: map[string]string{
			"command": "printenv | grep -E '" + token + "'",
		}},
	}
	for i, e := range cases {
		for _, f := range behavior.Scan(e) {
			for _, m := range rules.Scan(f.Excerpt) {
				if m.Confidence != rules.ConfPlaceholder {
					t.Errorf("用例 %d 规则 %s 的 Excerpt 泄漏凭证原文（%s 命中）：%q",
						i, f.RuleID, m.RuleID, f.Excerpt)
				}
			}
		}
	}
}

// TestExcerptTruncated：超长 Excerpt 被截断，报告不刷屏。
func TestExcerptTruncated(t *testing.T) {
	long := strings.Repeat("a", 500) + " ~/.ssh/id_rsa"
	fs := behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": "cat " + long}})
	if len(fs) == 0 {
		t.Fatal("未命中")
	}
	if len(fs[0].Excerpt) > 200 {
		t.Errorf("Excerpt 长度 %d 超过截断上限", len(fs[0].Excerpt))
	}
}

// TestAllRulesCompile：全部 Pattern 必须是合法 RE2（Scan 内部 MustCompile，
// 一条坏正则会让整个二进制 panic——必须在测试期暴露）。
func TestAllRulesCompile(t *testing.T) {
	// Scan 首次调用即编译全部规则；再对每条规则至少跑一次通用事件，
	// 保证 compiledRules 初始化路径被完整执行。
	_ = behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": "true"}})
	_ = behavior.Scan(behavior.Event{Tool: "Read", Fields: map[string]string{"file_path": "main.go"}})
}

// TestRuleIDsUnique：ID 重复会让 behavior.csv 无法按规则聚合。
func TestRuleIDsUnique(t *testing.T) {
	// 通过公开 API 间接检查：每个已知 ID 至少能被一个事件触发且互不串扰。
	ids := map[string]bool{}
	events := []behavior.Event{
		{Tool: "Read", Fields: map[string]string{"file_path": "/root/.ssh/id_rsa"}},
		{Tool: "Edit", Fields: map[string]string{"file_path": "/root/.ssh/id_rsa"}},
		{Tool: "Bash", Fields: map[string]string{"command": "cat ~/.ssh/id_rsa"}},
		{Tool: "Bash", Fields: map[string]string{"command": "security find-generic-password -s x -w"}},
		{Tool: "Bash", Fields: map[string]string{"command": "printenv"}},
		{Tool: "Bash", Fields: map[string]string{"command": "grep -r password ."}},
		{Tool: "Bash", Fields: map[string]string{"command": "cat /proc/1234/environ"}},
	}
	for _, e := range events {
		for _, f := range behavior.Scan(e) {
			if ids[f.RuleID] {
				// 同一事件组合里同 ID 出现两次才可能是重复定义；
				// 单事件内 Scan 已保证去重，这里只验证触发到的 ID 非空。
				t.Fatalf("规则 ID 重复出现：%s", f.RuleID)
			}
			ids[f.RuleID] = true
		}
	}
	for _, want := range []string{"credential_file_read", "credential_file_write", "credential_cmd_read", "credential_tool_invoke", "env_dump", "credential_grep_scan", "proc_env_read"} {
		if !ids[want] {
			t.Errorf("规则 %s 从未被任何事件触发过——规则表可能被误改", want)
		}
	}
}

// ---- 审计修复轮新增：CC-Monitor 借鉴缺口（credential_grep_scan / proc_env_read / export -p）----

// TestCredentialGrepScanFires：递归检索凭证关键词 = 凭证搜刮行为。
func TestCredentialGrepScanFires(t *testing.T) {
	hits := []string{
		"grep -r password .",
		"rg -l 'api_key' ~/projects", // rg 默认递归，无需 -r
		"grep -rn --recursive secret /etc",
		"rg --files | xargs grep -r token",
	}
	misses := []string{
		"grep TODO main.go",   // 无递归
		"rg 'func main' cmd/", // 非凭证词
	}
	// git grep -r token HEAD 也命中：git grep 检索版本库历史，历史里的
	// 凭证同样是本产品关心对象（宁多勿漏，行为观察只是信号）。
	if !hasRule(behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": "git grep -r token HEAD"}}), "credential_grep_scan") {
		t.Error("git grep -r token 应命中（版本库历史同样可含凭证）")
	}
	for _, cmd := range hits {
		if !hasRule(behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": cmd}}), "credential_grep_scan") {
			t.Errorf("命令 %q 应命中 credential_grep_scan", cmd)
		}
	}
	for _, cmd := range misses {
		if hasRule(behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": cmd}}), "credential_grep_scan") {
			t.Errorf("命令 %q 不应命中 credential_grep_scan", cmd)
		}
	}
}

// TestProcEnvReadFires：读取他进程环境变量（Linux /proc、macOS ps eww）。
func TestProcEnvReadFires(t *testing.T) {
	hits := []string{
		"cat /proc/1234/environ",
		"tr '\\0' '\\n' < /proc/self/environ",
		"cat /proc/$(pgrep ssh-agent)/environ", // 命令替换形态
		"cat /proc/${PID}/environ",
		"ps eww 1234",
	}
	misses := []string{"ls /proc", "cat /proc/cpuinfo", "ps aux"}
	for _, cmd := range hits {
		if !hasRule(behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": cmd}}), "proc_env_read") {
			t.Errorf("命令 %q 应命中 proc_env_read", cmd)
		}
	}
	for _, cmd := range misses {
		if hasRule(behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": cmd}}), "proc_env_read") {
			t.Errorf("命令 %q 不应命中 proc_env_read", cmd)
		}
	}
}

// TestEnvDumpExportP：POSIX export -p 也是整体导出形态。
func TestEnvDumpExportP(t *testing.T) {
	for _, cmd := range []string{"export -p", "cd /app && export -p > env.bak"} {
		if !hasRule(behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": cmd}}), "env_dump") {
			t.Errorf("命令 %q 应命中 env_dump", cmd)
		}
	}
	// 带赋值运行别的命令不算整体导出
	if hasRule(behavior.Scan(behavior.Event{Tool: "Bash", Fields: map[string]string{"command": "ENV=prod npm start"}}), "env_dump") {
		t.Error("ENV=prod npm start 不应命中 env_dump")
	}
}

// hasRule 是命中判定的小工具。
func hasRule(fs []behavior.Finding, id string) bool {
	for _, f := range fs {
		if f.RuleID == id {
			return true
		}
	}
	return false
}
