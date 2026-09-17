package endpoint_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"leakscan/internal/behavior"
	"leakscan/internal/detect"
	"leakscan/internal/endpoint"
	"leakscan/internal/extract"
	"leakscan/internal/testfixture"
)

// writeSession 写一个合成的 transcript 文件。
func writeSession(t *testing.T, root, rel string, lines []string) endpoint.Session {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return endpoint.Session{Agent: endpoint.AgentClaude, Path: p, Rel: rel}
}

func parse(t *testing.T, s endpoint.Session) []detect.Record {
	t.Helper()
	recs, _, skips, err := endpoint.ParseSession(s, time.Time{}, time.Time{}, 8<<20)
	if err != nil {
		t.Fatalf("ParseSession: %v", err)
	}
	for _, sk := range skips {
		t.Logf("skip: %s — %s", sk.Path, sk.Reason)
	}
	return recs
}

// rolesOf 把一条记录按 extract 拆出的角色集合返回。
func rolesOf(r detect.Record) map[string]string {
	out := map[string]string{}
	if len(r.RequestBody) > 0 {
		for k, v := range extract.Request(r.RequestBody).Segments {
			out[k] += v
		}
	}
	if len(r.ResponseBody) > 0 {
		for k, v := range extract.Response(r.ResponseBody).Segments {
			out[k] += v
		}
	}
	return out
}

// TestToolUseResultBecomesToolResult 是本适配器最关键的一条：
// agent 读取 ~/.ssh/id_rsa 的结果落在顶层 toolUseResult 字段（不在 message 里），
// 必须被识别为 tool_result 角色——整改对象是"agent 的读取范围"，
// 而不是"员工主动粘贴"（ESCN-001）。
func TestToolUseResultBecomesToolResult(t *testing.T) {
	g := testfixture.New(1)
	key := g.PEM("OPENSSH ")
	line := mustJSON(t, map[string]any{
		"type": "user", "uuid": "u1", "sessionId": "s1",
		"timestamp": "2026-09-14T10:00:00.000Z", "cwd": "/repo",
		"message":       map[string]any{"role": "user", "content": "看看我的 ssh key"},
		"toolUseResult": map[string]any{"type": "text", "file": map[string]any{"filePath": "/root/.ssh/id_rsa", "content": key}},
	})
	s := writeSession(t, t.TempDir(), "proj/a.jsonl", []string{line})
	recs := parse(t, s)
	if len(recs) != 1 {
		t.Fatalf("期望 1 条记录，得到 %d", len(recs))
	}
	roles := rolesOf(recs[0])
	if !strings.Contains(roles[extract.RoleToolResult], "PRIVATE KEY") {
		t.Errorf("私钥未落在 tool_result 角色；实际角色=%v", keysOf(roles))
	}
	if strings.Contains(roles[extract.RoleUserInput], "PRIVATE KEY") {
		t.Errorf("私钥被误归为 user_input，会指向错误的整改对象")
	}
	// 端到端：识别引擎要真的报出 ssh_private_key
	det := detect.New([]byte("0123456789abcdef0123456789abcdef"), nil)
	var found bool
	for _, h := range det.Scan(recs[0]).Hits {
		if h.RuleID == "ssh_private_key" {
			found = true
			if !strings.Contains(strings.Join(h.Roles, ","), extract.RoleToolResult) {
				t.Errorf("命中的来源角色不含 tool_result：%v", h.Roles)
			}
		}
	}
	if !found {
		t.Error("未识别出 ssh_private_key")
	}
}

// TestAssistantIsModelOutput：模型把密钥吐出来时，来源角色必须是 model_output，
// 指向的是网关/上游侧密钥被套出，责任人不是员工（网关产品 SCN-005 同理）。
func TestAssistantIsModelOutput(t *testing.T) {
	g := testfixture.New(2)
	line := mustJSON(t, map[string]any{
		"type": "assistant", "uuid": "a1", "sessionId": "s1",
		"timestamp": "2026-09-14T10:00:01.000Z",
		"message": map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "text", "text": "密钥是 " + g.AWSID()},
		}},
	})
	s := writeSession(t, t.TempDir(), "proj/b.jsonl", []string{line})
	recs := parse(t, s)
	if len(recs) != 1 {
		t.Fatalf("期望 1 条记录，得到 %d", len(recs))
	}
	roles := rolesOf(recs[0])
	if roles[extract.RoleModelOutput] == "" {
		t.Errorf("assistant 内容未归为 model_output；实际=%v", keysOf(roles))
	}
}

// TestWindowFiltersByRecordTimestamp：一个会话文件会横跨窗口边界，
// 过滤必须按每条记录自己的时间戳，而不是文件的 modtime。
func TestWindowFiltersByRecordTimestamp(t *testing.T) {
	mk := func(uuid, ts string) string {
		return mustJSON(t, map[string]any{
			"type": "user", "uuid": uuid, "sessionId": "s1", "timestamp": ts,
			"message": map[string]any{"role": "user", "content": "x"},
		})
	}
	s := writeSession(t, t.TempDir(), "proj/c.jsonl", []string{
		mk("old", "2026-09-01T00:00:00.000Z"),
		mk("in", "2026-09-10T00:00:00.000Z"),
		mk("late", "2026-09-20T00:00:00.000Z"),
	})
	from := time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC)
	recs, _, _, err := endpoint.ParseSession(s, from, to, 8<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 {
		t.Fatalf("期望窗口内只剩 1 条，得到 %d", len(recs))
	}
	if !recs[0].CallTS.Equal(time.Date(2026, 9, 10, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("留下的不是窗口内那条：%v", recs[0].CallTS)
	}
}

// TestIdempotentReplay：同一文件重复扫描必须得到完全一致的结果（ECAP-007 / ESCN-007）。
func TestIdempotentReplay(t *testing.T) {
	g := testfixture.New(3)
	line := mustJSON(t, map[string]any{
		"type": "user", "uuid": "u1", "sessionId": "s1",
		"timestamp":     "2026-09-14T10:00:00.000Z",
		"toolUseResult": map[string]any{"stdout": "AK=" + g.AWSID(), "stderr": ""},
	})
	s := writeSession(t, t.TempDir(), "proj/d.jsonl", []string{line})
	det := detect.New([]byte("0123456789abcdef0123456789abcdef"), nil)
	fp := func() string {
		recs := parse(t, s)
		var b strings.Builder
		for _, r := range recs {
			for _, h := range det.Scan(r).Hits {
				b.WriteString(r.RequestID + "|" + h.RuleID + "|" + h.Fingerprint + ";")
			}
		}
		return b.String()
	}
	first, second := fp(), fp()
	if first == "" {
		t.Fatal("第一次扫描就没有命中，用例无效")
	}
	if first != second {
		t.Errorf("重复扫描结果不一致：\n1: %s\n2: %s", first, second)
	}
}

// TestMalformedLineIsSkippedNotFatal：格式坏掉的行计入缺口，不能中断整个文件，
// 也不能静默丢弃（EBR-009）。
func TestMalformedLineIsSkippedNotFatal(t *testing.T) {
	g := testfixture.New(4)
	good := mustJSON(t, map[string]any{
		"type": "user", "uuid": "u2", "sessionId": "s1",
		"timestamp":     "2026-09-14T10:00:00.000Z",
		"toolUseResult": map[string]any{"stdout": g.PEM("OPENSSH ")},
	})
	s := writeSession(t, t.TempDir(), "proj/e.jsonl", []string{"{ 这不是 JSON", good})
	recs, _, skips, err := endpoint.ParseSession(s, time.Time{}, time.Time{}, 8<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 1 {
		t.Errorf("坏行之后的好行应继续扫描，得到 %d 条", len(recs))
	}
	if len(skips) != 1 || !strings.Contains(skips[0].Reason, "JSON") {
		t.Errorf("坏行未计入缺口：%+v", skips)
	}
}

// TestOversizeLineCountedAsGap：超大行计入缺口而不是被当作没有内容。
func TestOversizeLineCountedAsGap(t *testing.T) {
	huge := mustJSON(t, map[string]any{
		"type": "user", "uuid": "u3", "sessionId": "s1",
		"toolUseResult": map[string]any{"stdout": strings.Repeat("A", 4096)},
	})
	s := writeSession(t, t.TempDir(), "proj/f.jsonl", []string{huge})
	recs, _, skips, err := endpoint.ParseSession(s, time.Time{}, time.Time{}, 512)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 0 {
		t.Errorf("超限行不应产生记录，得到 %d", len(recs))
	}
	if len(skips) != 1 || !strings.Contains(skips[0].Reason, "超过上限") {
		t.Errorf("超限行未计入缺口：%+v", skips)
	}
}

// TestDiscoverSkipsNonJSONL 确认发现阶段只取 .jsonl，且缺口有原因。
func TestDiscoverSkipsNonJSONL(t *testing.T) {
	root := t.TempDir()
	writeSession(t, root, "p1/a.jsonl", []string{`{"type":"user","uuid":"1"}`})
	if err := os.WriteFile(filepath.Join(root, "p1", "notes.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, _, err := endpoint.DiscoverClaude(root, time.Time{}, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !strings.HasSuffix(got[0].Rel, "a.jsonl") {
		t.Fatalf("发现结果不对：%+v", got)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		if v != "" {
			out = append(out, k)
		}
	}
	return out
}

// ---- WI-2 凭证所属文件路径（ECAP-011）----

// sourceLines 构造一行带 toolUseResult 的 user 记录。
func sourceLine(t *testing.T, toolUseResult any) string {
	t.Helper()
	tur, err := json.Marshal(toolUseResult)
	if err != nil {
		t.Fatal(err)
	}
	line := map[string]any{
		"type":          "user",
		"sessionId":     "s-wi2",
		"timestamp":     "2026-09-14T08:00:00Z",
		"cwd":           "/tmp/proj",
		"message":       map[string]any{"role": "user", "content": "x"},
		"toolUseResult": json.RawMessage(tur),
	}
	b, err := json.Marshal(line)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestSourcePathFromReadResult：Read 形态 {file:{filePath,content}} 取到路径。
func TestSourcePathFromReadResult(t *testing.T) {
	root := t.TempDir()
	s := writeSession(t, root, "p/read.jsonl", []string{
		sourceLine(t, map[string]any{
			"type": "tool_result",
			"file": map[string]any{"filePath": "/root/.ssh/id_rsa", "content": "-----BEGIN OPENSSH PRIVATE KEY-----"},
		}),
	})
	recs := parse(t, s)
	if len(recs) != 1 {
		t.Fatalf("期望 1 条记录，得到 %d", len(recs))
	}
	if recs[0].SourcePath != "/root/.ssh/id_rsa" {
		t.Errorf("SourcePath = %q，期望 /root/.ssh/id_rsa", recs[0].SourcePath)
	}
}

// TestSourcePathFromEditResult：Edit/Write 形态的顶层 filePath 同样取到。
func TestSourcePathFromEditResult(t *testing.T) {
	root := t.TempDir()
	s := writeSession(t, root, "p/edit.jsonl", []string{
		sourceLine(t, map[string]any{
			"type": "tool_result", "filePath": "/home/u/deploy/.env.production",
			"content": "", "structuredPatch": []any{},
		}),
	})
	recs := parse(t, s)
	if len(recs) != 1 {
		t.Fatalf("期望 1 条记录，得到 %d", len(recs))
	}
	if recs[0].SourcePath != "/home/u/deploy/.env.production" {
		t.Errorf("SourcePath = %q，期望 /home/u/deploy/.env.production", recs[0].SourcePath)
	}
}

// TestSourcePathEmptyWhenUnknown：Bash 的 stdout 形态与字符串形态没有路径
// 字段，必须为空——不得猜测成会话文件路径（ECAP-011）。
func TestSourcePathEmptyWhenUnknown(t *testing.T) {
	root := t.TempDir()
	s := writeSession(t, root, "p/bash.jsonl", []string{
		sourceLine(t, map[string]any{"stdout": "file content here", "interrupted": false, "isImage": false}),
		sourceLine(t, "just a plain string result"),
	})
	recs := parse(t, s)
	if len(recs) != 2 {
		t.Fatalf("期望 2 条记录，得到 %d", len(recs))
	}
	for i, r := range recs {
		if r.SourcePath != "" {
			t.Errorf("第 %d 条 SourcePath = %q，期望空（不得猜测）", i, r.SourcePath)
		}
	}
}

// ---- WI-3 事件提取（ECAP-008 §5.4）----

// TestEventsExtractedFromToolUse：assistant 行的 tool_use 块必须归一化成
// behavior.Event，工具名与字段值不丢失。
func TestEventsExtractedFromToolUse(t *testing.T) {
	root := t.TempDir()
	assistantLine := func(tool string, input map[string]any) string {
		line := map[string]any{
			"type":      "assistant",
			"sessionId": "s-ev",
			"timestamp": "2026-09-14T08:00:00Z",
			"message": map[string]any{
				"role":    "assistant",
				"content": []any{map[string]any{"type": "tool_use", "id": "t1", "name": tool, "input": input}},
			},
		}
		b, _ := json.Marshal(line)
		return string(b)
	}
	s := writeSession(t, root, "p/ev.jsonl", []string{
		assistantLine("Bash", map[string]any{"command": "cat ~/.ssh/id_rsa > /tmp/o"}),
		assistantLine("Read", map[string]any{"file_path": "/home/u/.aws/credentials", "limit": 100}),
	})
	_, events, skips, err := endpoint.ParseSession(s, time.Time{}, time.Time{}, 8<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(skips) != 0 {
		t.Fatalf("不应有 skip：%+v", skips)
	}
	if len(events) != 2 {
		t.Fatalf("期望 2 个事件，得到 %d", len(events))
	}
	bashEv := events[0]
	if bashEv.Event.Tool != "Bash" || bashEv.Event.Fields["command"] != "cat ~/.ssh/id_rsa > /tmp/o" {
		t.Errorf("Bash 事件不符：%+v", bashEv.Event)
	}
	if bashEv.SourceFile != "p/ev.jsonl" || bashEv.Line != 1 {
		t.Errorf("事件坐标不符：file=%q line=%d", bashEv.SourceFile, bashEv.Line)
	}
	readEv := events[1]
	if readEv.Event.Tool != "Read" {
		t.Errorf("Read 事件工具名不符：%q", readEv.Event.Tool)
	}
	// 非字符串字段（limit:100）文本化后仍可读，不丢失信息。
	if readEv.Event.Fields["file_path"] != "/home/u/.aws/credentials" {
		t.Errorf("file_path 丢失：%+v", readEv.Event.Fields)
	}
	if _, ok := readEv.Event.Fields["limit"]; !ok {
		t.Errorf("非字符串字段 limit 不应被丢弃：%+v", readEv.Event.Fields)
	}
}

// TestEventFeedsBehaviorScan：端到端——adapter 产出的事件直接喂行为引擎
// 能产生命中，且 user 行的 toolUseResult 不产生重复事件（事件只来自
// assistant 的 tool_use 块，避免同一次调用计两次）。
func TestEventFeedsBehaviorScan(t *testing.T) {
	root := t.TempDir()
	userLine := map[string]any{
		"type":      "user",
		"sessionId": "s-e2e",
		"timestamp": "2026-09-14T08:00:01Z",
		"message":   map[string]any{"role": "user", "content": "ok"},
	}
	assistantLine := map[string]any{
		"type":      "assistant",
		"sessionId": "s-e2e",
		"timestamp": "2026-09-14T08:00:00Z",
		"message": map[string]any{
			"role":    "assistant",
			"content": []any{map[string]any{"type": "tool_use", "id": "t2", "name": "Read", "input": map[string]any{"file_path": "/root/.ssh/id_rsa"}}},
		},
	}
	ub, _ := json.Marshal(userLine)
	ab, _ := json.Marshal(assistantLine)
	s := writeSession(t, root, "p/e2e.jsonl", []string{string(ab), string(ub)})
	_, events, _, err := endpoint.ParseSession(s, time.Time{}, time.Time{}, 8<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("同一次工具调用只应产生 1 个事件（assistant 侧），得到 %d", len(events))
	}
	fs := behavior.Scan(events[0].Event)
	if len(fs) == 0 || fs[0].RuleID != "credential_file_read" {
		t.Errorf("事件未触发 credential_file_read：%+v", fs)
	}
}
