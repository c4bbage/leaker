package privacy

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"net/http"
	"testing"
)

func TestSession_ProtectAndRestoreText(t *testing.T) {
	ctx := context.Background()
	p, err := New(Config{RulesOnly: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	s := p.NewSession()
	defer s.Close()

	input := "请帮我排查 access_key_id: LTAI5t7abcdeFGHIJKLMNOPQ 和 access_key_secret: 8sduyfg78sdgf87sdgf87sdgf87sdgf87，还有张三的邮箱 user@mycompany.cn 和手机 13812345678"
	masked, detections, err := s.ProtectText(ctx, input)
	if err != nil {
		t.Fatalf("ProtectText: %v", err)
	}
	if len(detections) == 0 {
		t.Fatalf("expected detections, got 0")
	}
	if strings.Contains(masked, "LTAI5t7abcdeFGHIJKLMNOPQ") {
		t.Fatalf("AK leaked in masked text: %s", masked)
	}
	if strings.Contains(masked, "8sduyfg78sdgf87sdgf87sdgf87sdgf87") {
		t.Fatalf("SK leaked in masked text: %s", masked)
	}
	if strings.Contains(masked, "user@mycompany.cn") {
		t.Fatalf("email leaked in masked text: %s", masked)
	}

	restored, err := s.RestoreText(ctx, masked)
	if err != nil {
		t.Fatalf("RestoreText: %v", err)
	}
	if restored != input {
		t.Fatalf("restored text mismatch:\nwant: %s\ngot:  %s", input, restored)
	}
}

func TestSession_OpenAIChatRoundTrip(t *testing.T) {
	ctx := context.Background()
	p, err := New(Config{RulesOnly: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	s := p.NewSession()
	defer s.Close()

	reqBody := []byte(`{
		"model": "gpt-4o",
		"messages": [
			{"role": "user", "content": "我的邮箱是 alice@company.com，Token 是 eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"}
		]
	}`)

	res, err := s.ProtectJSON(ctx, reqBody)
	if err != nil {
		t.Fatalf("ProtectJSON: %v", err)
	}
	if len(res.Detections) == 0 {
		t.Fatalf("expected detections in request JSON")
	}
	if bytes.Contains(res.Body, []byte("alice@company.com")) {
		t.Fatalf("email still in request JSON: %s", string(res.Body))
	}

	var reqObj struct {
		Messages []struct {
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(res.Body, &reqObj); err != nil {
		t.Fatalf("unmarshal masked request: %v", err)
	}
	maskedContent := reqObj.Messages[0].Content

	// 模拟模型回复把占位符原样带回
	respBody := []byte(`{
		"id": "chatcmpl-1",
		"choices": [
			{
				"message": {
					"role": "assistant",
					"content": "收到，你的内容是: ` + strings.ReplaceAll(maskedContent, `"`, `\"`) + `"
				}
			}
		]
	}`)

	restoredResp, err := s.RestoreJSON(ctx, respBody)
	if err != nil {
		t.Fatalf("RestoreJSON: %v", err)
	}
	if !bytes.Contains(restoredResp, []byte("alice@company.com")) {
		t.Fatalf("expected restored response to contain original email, got: %s", string(restoredResp))
	}
}

func TestSession_CredentialsAndPersonalCoverage(t *testing.T) {
	ctx := context.Background()
	p, err := New(Config{RulesOnly: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	s := p.NewSession()
	defer s.Close()

	text := "access_key_id: LTAI5t7abcdeFGHIJKLMNOPQ\naccess_key_secret: 8sduyfg78sdgf87sdgf87sdgf87sdgf87\nGitLab: glpat-abcdefghijklmnopqrst\nEmail: ops@company.internal\nIP: 8.8.8.8"
	hits, err := s.Detect(ctx, text)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(hits) < 4 {
		t.Fatalf("expected at least 4 hits, got %d", len(hits))
	}
}

func TestCornerCases_JSONEscapingAndTools(t *testing.T) {
	ctx := context.Background()
	p, err := New(Config{RulesOnly: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	s := p.NewSession()
	defer s.Close()

	// 模拟嵌套转义的 Tool Calls 参数: JSON 字符串内部包裹 JSON
	reqBody := []byte(`{
		"model": "gpt-4o",
		"messages": [
			{
				"role": "assistant",
				"tool_calls": [
					{
						"id": "call_123",
						"type": "function",
						"function": {
							"name": "send_email",
							"arguments": "{\"to\": \"target_user@corp.cn\", \"auth\": \"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c\"}"
						}
					}
				]
			}
		]
	}`)

	masked, err := s.ProtectJSON(ctx, reqBody)
	if err != nil {
		t.Fatalf("ProtectJSON: %v", err)
	}
	if bytes.Contains(masked.Body, []byte("target_user@corp.cn")) {
		t.Fatalf("email leaked in tool arguments: %s", string(masked.Body))
	}

	restored, err := s.RestoreJSON(ctx, masked.Body)
	if err != nil {
		t.Fatalf("RestoreJSON: %v", err)
	}
	if !bytes.Contains(restored, []byte("target_user@corp.cn")) {
		t.Fatalf("failed to restore escaped tool argument: %s", string(restored))
	}
}

func TestCornerCases_StreamSplitRestore(t *testing.T) {
	ctx := context.Background()
	p, err := New(Config{RulesOnly: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	s := p.NewSession()
	defer s.Close()

	text := "用户联系方式是 admin@mycompany.cn"
	masked, hits, err := s.ProtectText(ctx, text)
	if err != nil || len(hits) == 0 {
		t.Fatalf("ProtectText: %v, hits=%d", err, len(hits))
	}

	placeholder := hits[0].Placeholder
	if placeholder == "" || !strings.Contains(masked, placeholder) {
		t.Fatalf("placeholder not found in masked text: %s", masked)
	}

	// 模拟流式大模型把占位符切成两半返回
	idx := strings.Index(masked, placeholder)
	part1 := masked[:idx+len(placeholder)/2]
	part2 := masked[idx+len(placeholder)/2:]

	var outBuf bytes.Buffer
	writer := s.NewRestoringWriter(&nopResponseWriter{buf: &outBuf})

	if _, err := writer.Write([]byte(part1)); err != nil {
		t.Fatalf("write part1: %v", err)
	}
	if _, err := writer.Write([]byte(part2)); err != nil {
		t.Fatalf("write part2: %v", err)
	}
	writer.Finish()

	if outBuf.String() != text {
		t.Fatalf("stream split restore failed:\nwant: %s\ngot:  %s", text, outBuf.String())
	}
}

type nopResponseWriter struct {
	buf *bytes.Buffer
}

func (n *nopResponseWriter) Header() http.Header       { return http.Header{} }
func (n *nopResponseWriter) Write(b []byte) (int, error) { return n.buf.Write(b) }
func (n *nopResponseWriter) WriteHeader(statusCode int) {}
