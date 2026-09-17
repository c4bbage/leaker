package endpoint_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"leakscan/internal/behavior"
	"leakscan/internal/endpoint"
	"leakscan/internal/extract"
	"leakscan/internal/testfixture"
)

// ---- WI-5 Codex 适配器验收（实施方案 §6.3）----

func codexLine(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestCodexRoleMapping：三种内容必须落到正确角色，event_msg 必须去重。
func TestCodexRoleMapping(t *testing.T) {
	g := testfixture.New(7)
	root := t.TempDir()
	shOutput, _ := json.Marshal(map[string]any{"output": "cat /root/.ssh/id_rsa\n" + g.PEM("OPENSSH "), "metadata": map[string]any{"exit_code": 0}})
	lines := []string{
		codexLine(t, map[string]any{"timestamp": "2025-11-02T12:53:12.194Z", "type": "session_meta",
			"payload": map[string]any{"id": "s1", "timestamp": "2025-11-02T12:53:12.163Z", "cwd": "/tmp/proj", "originator": "codex_cli_rs", "cli_version": "0.53.0"}}),
		codexLine(t, map[string]any{"timestamp": "2025-11-02T12:54:00Z", "type": "response_item",
			"payload": map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "please check ssh key"}}}}),
		codexLine(t, map[string]any{"timestamp": "2025-11-02T13:00:00Z", "type": "response_item",
			"payload": map[string]any{"type": "function_call", "name": "shell", "arguments": `{"command":["bash","-lc","cat /root/.ssh/id_rsa"]}`, "call_id": "c1"}}),
		codexLine(t, map[string]any{"timestamp": "2025-11-02T13:00:01Z", "type": "response_item",
			"payload": map[string]any{"type": "function_call_output", "output": string(shOutput), "call_id": "c1"}}),
		codexLine(t, map[string]any{"timestamp": "2025-11-02T12:55:00Z", "type": "response_item",
			"payload": map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "done, the key looks fine"}}}}),
		// event_msg 重复视图：必须被跳过，否则同一内容计两次
		codexLine(t, map[string]any{"timestamp": "2025-11-02T12:55:01Z", "type": "event_msg",
			"payload": map[string]any{"type": "agent_message", "message": "done, the key looks fine"}}),
	}
	p := filepath.Join(root, "2025", "11", "02", "rollout-x.jsonl")
	os.MkdirAll(filepath.Dir(p), 0o700)
	os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o600)
	s := endpoint.Session{Agent: endpoint.AgentCodex, Path: p, Rel: "2025/11/02/rollout-x.jsonl"}
	recs, events, skips, err := endpoint.ParseCodexSession(s, time.Time{}, time.Time{}, 8<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(skips) != 0 {
		t.Fatalf("不应有 skip：%+v", skips)
	}
	// event_msg 去重：5 行内容（meta 不产记录）→ 4 条记录，重复的 agent_message 不再计
	if len(recs) != 4 {
		t.Fatalf("event_msg 去重后期望 4 条记录，得到 %d", len(recs))
	}
	found := map[string]int{}
	for _, r := range recs {
		if len(r.RequestBody) > 0 {
			for role := range extract.Request(r.RequestBody).Segments {
				found[role]++
			}
		}
		if len(r.ResponseBody) > 0 {
			for role := range extract.Response(r.ResponseBody).Segments {
				found[role]++
			}
		}
	}
	for role, want := range map[string]int{"tool_result": 1, "user_input": 1, "tool_call": 1, "model_output": 1} {
		if found[role] != want {
			t.Errorf("角色 %s 期望 %d 处，实际 %v", role, want, found)
		}
	}
	// function_call → 行为事件
	if len(events) != 1 || events[0].Event.Tool != "shell" {
		t.Fatalf("function_call 事件提取不符：%+v", events)
	}
	if events[0].SourceFile != "2025/11/02/rollout-x.jsonl" || events[0].Line != 3 {
		t.Errorf("事件坐标不符：file=%q line=%d", events[0].SourceFile, events[0].Line)
	}
	// cwd 从 session_meta 缓存进记录的归属字段
	if recs[0].UserName != "/tmp/proj" {
		t.Errorf("cwd 未从 session_meta 缓存：%q", recs[0].UserName)
	}
	// 端到端：事件喂行为引擎
	if fs := behavior.Scan(events[0].Event); len(fs) == 0 {
		t.Error("事件未触发任何行为规则")
	}
}

// TestCodexWindowFiltersByRecordTimestamp：窗口按行时间戳过滤。
func TestCodexWindowFiltersByRecordTimestamp(t *testing.T) {
	root := t.TempDir()
	mk := func(ts string) string {
		return codexLine(t, map[string]any{"timestamp": ts, "type": "response_item",
			"payload": map[string]any{"type": "message", "role": "user",
				"content": []any{map[string]any{"type": "input_text", "text": ts}}}})
	}
	p := filepath.Join(root, "rollout-w.jsonl")
	os.WriteFile(p, []byte(strings.Join([]string{
		codexLine(t, map[string]any{"timestamp": "2025-11-02T12:53:12Z", "type": "session_meta", "payload": map[string]any{"cwd": "/tmp/p"}}),
		mk("2025-11-01T00:00:00Z"), mk("2025-11-10T00:00:00Z"), mk("2025-11-25T00:00:00Z"),
	}, "\n")+"\n"), 0o600)
	s := endpoint.Session{Agent: endpoint.AgentCodex, Path: p, Rel: "rollout-w.jsonl"}
	from := time.Date(2025, 11, 5, 0, 0, 0, 0, time.UTC)
	to := time.Date(2025, 11, 20, 0, 0, 0, 0, time.UTC)
	recs, _, _, err := endpoint.ParseCodexSession(s, from, to, 8<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 {
		t.Fatalf("窗口内应剩 1 条，得到 %d", len(recs))
	}
}

// TestCodexIdempotentAndBadLines：幂等、坏行/超限计入缺口。
func TestCodexIdempotentAndBadLines(t *testing.T) {
	root := t.TempDir()
	meta := codexLine(t, map[string]any{"timestamp": "2025-11-02T12:53:12Z", "type": "session_meta",
		"payload": map[string]any{"id": "s", "cwd": "/tmp/p", "cli_version": "0.53.0"}})
	ok := codexLine(t, map[string]any{"timestamp": "2025-11-02T12:54:00Z", "type": "response_item",
		"payload": map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "hi"}}}})
	lines := []string{meta, ok, "{not json", ok}
	p := filepath.Join(root, "rollout-b.jsonl")
	os.MkdirAll(root, 0o700)
	os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o600)
	s := endpoint.Session{Agent: endpoint.AgentCodex, Path: p, Rel: "rollout-b.jsonl"}

	recs, _, skips, err := endpoint.ParseCodexSession(s, time.Time{}, time.Time{}, 8<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 2 {
		t.Errorf("坏行不应中断解析（期望 2 条好行记录）：得到 %d 条", len(recs))
	}
	if len(skips) != 1 || !strings.Contains(skips[0].Reason, "不是合法 JSON") {
		t.Errorf("坏行应计入缺口：%+v", skips)
	}
	// 幂等：同文件再解析结果一致
	recs2, _, _, _ := endpoint.ParseCodexSession(s, time.Time{}, time.Time{}, 8<<20)
	if len(recs2) != len(recs) {
		t.Errorf("幂等性破坏：%d vs %d", len(recs), len(recs2))
	}
	// 超限行计入缺口，不进内存
	big := codexLine(t, map[string]any{"timestamp": "2025-11-02T12:55:00Z", "type": "response_item",
		"payload": map[string]any{"type": "message", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": strings.Repeat("x", 100000)}}}})
	os.WriteFile(p, []byte(meta+"\n"+strings.Repeat(" ", 100)+big+"\n"), 0o600)
	_, _, skips2, _ := endpoint.ParseCodexSession(s, time.Time{}, time.Time{}, 1<<10)
	if len(skips2) == 0 {
		t.Error("超限行应计入缺口")
	}
}
