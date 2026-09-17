package main

import (
	"bufio"
	"compress/gzip"
	"context"
	"encoding/csv"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"leakscan/internal/output"
	"leakscan/internal/rules"
	"leakscan/internal/testfixture"
)

func TestFileScan(t *testing.T) {
	dir := t.TempDir()
	g := testfixture.New(7)
	pem := g.PEM("OPENSSH ")
	session := func(extra ...map[string]any) string {
		msgs := []map[string]any{
			{"role": "system", "content": "agent"},
			{"role": "user", "content": "服务器连不上"},
			{"role": "assistant", "content": nil, "reasoning_content": "先看密钥", "tool_calls": []any{map[string]any{"id": "c1", "type": "function", "function": map[string]any{"name": "bash", "arguments": `{"cmd":"cat ~/.ssh/id_ed25519"}`}}}},
			{"role": "tool", "tool_call_id": "c1", "content": pem},
		}
		msgs = append(msgs, extra...)
		b, _ := json.Marshal(map[string]any{"messages": msgs})
		return string(b)
	}
	lines := []string{
		session(),
		session(map[string]any{"role": "user", "content": "OSS 403：\naccess_key_id: " + g.AliyunID() + "\naccess_key_secret: " + g.AliyunSecret()}),
		"",
		`{"messages": [ this is not json`,
		`{"messages":[{"role":"user","content":"` + strings.Repeat("a", 10000) + `"}]}`,
	}
	in := filepath.Join(dir, "sessions.jsonl.gz")
	f, _ := os.Create(in)
	gz := gzip.NewWriter(f)
	gz.Write([]byte(strings.Join(lines, "\n")))
	gz.Close()
	f.Close()

	out := filepath.Join(dir, "out")
	key := filepath.Join(dir, "k.key")
	if err := runFile(context.Background(), []string{"-in", in, "-out", out, "-hmac-key", key, "-max-body", "8192", "-batch", "2", "-workers", "2"}); err != nil {
		t.Fatal(err)
	}
	runs, _ := filepath.Glob(filepath.Join(out, "*"))
	if len(runs) != 1 {
		t.Fatalf("输出目录数 %d", len(runs))
	}
	run := runs[0]

	st, err := output.LoadState(run)
	if err != nil {
		t.Fatal(err)
	}
	c := st.Coverage[FileTable]
	if st.FinishedAt == nil || c.Rows != 4 || c.Oversize != 1 || c.RequestParseFail != 1 {
		t.Fatalf("覆盖统计不符：finished=%v rows=%d oversize=%d parseFail=%d", st.FinishedAt != nil, c.Rows, c.Oversize, c.RequestParseFail)
	}

	rows := readCSVFile(t, filepath.Join(run, output.FindingsFile))
	var ssh, ali int
	for _, r := range rows {
		switch r["rule_id"] {
		case "ssh_private_key":
			ssh++
			if r["request_count"] != "2" || r["roles"] != "tool_result" || r["severity"] != "high" {
				t.Errorf("SSH 私钥发现不符：%v", r)
			}
		case "aliyun_accesskey":
			ali++
			if r["severity"] != "high" || r["roles"] != "user_input" {
				t.Errorf("阿里云发现不符：%v", r)
			}
		}
	}
	if ssh != 1 || ali != 1 {
		t.Fatalf("发现数不符：ssh=%d aliyun=%d，全部：%v", ssh, ali, rows)
	}

	summary, _ := os.ReadFile(filepath.Join(run, output.SummaryFile))
	if !strings.Contains(string(summary), "输入文件") || strings.Contains(string(summary), "按部门") {
		t.Error("文件扫描的报告头部或章节不符")
	}
	entries, _ := os.ReadDir(run)
	for _, e := range entries {
		data, _ := os.ReadFile(filepath.Join(run, e.Name()))
		for _, m := range rules.Scan(string(data)) {
			if m.Confidence != rules.ConfPlaceholder && m.RuleID != "jwt" && m.RuleID != "password_field" {
				t.Errorf("%s 含可识别的凭证原文：%s", e.Name(), m.RuleID)
			}
		}
	}
}

func readCSVFile(t *testing.T, path string) []map[string]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	br := bufio.NewReader(f)
	if b, _ := br.Peek(3); string(b) == "\xef\xbb\xbf" {
		br.Discard(3)
	}
	recs, err := csv.NewReader(br).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]string
	for _, r := range recs[1:] {
		m := map[string]string{}
		for i, h := range recs[0] {
			m[h] = r[i]
		}
		out = append(out, m)
	}
	return out
}
