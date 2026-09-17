package detect_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"leakscan/internal/detect"
	"leakscan/internal/testfixture"
)

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func hitByRule(o detect.Outcome, rule string) *detect.Hit {
	for i := range o.Hits {
		if o.Hits[i].RuleID == rule {
			return &o.Hits[i]
		}
	}
	return nil
}

func newDetector() *detect.Detector {
	return detect.New([]byte(strings.Repeat("k", 32)), nil)
}

// Anthropic 格式：agent 读取私钥作为 tool_result 回传，且同一私钥出现在多轮历史中。
func TestAnthropicToolResultAndDedupe(t *testing.T) {
	g := testfixture.New(10)
	key := g.PEM("OPENSSH ")
	body := mustJSON(t, map[string]any{
		"model":  "claude-x",
		"system": "You are a coding agent.",
		"messages": []any{
			map[string]any{"role": "user", "content": "帮我看看为什么连不上服务器"},
			map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "tool_use", "id": "t1", "name": "Bash", "input": map[string]any{"command": "cat ~/.ssh/id_ed25519"}},
			}},
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "tool_result", "tool_use_id": "t1", "content": key},
			}},
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "tool_result", "tool_use_id": "t2", "content": "again:\n" + key},
			}},
		},
	})
	o := newDetector().Scan(detect.Record{Table: "call_logs", RequestID: "r1", CallTS: time.Now(), UserID: "u1", RequestBody: body})
	h := hitByRule(o, "ssh_private_key")
	if h == nil {
		t.Fatalf("未识别 SSH 私钥：%+v", o.Hits)
	}
	if strings.Join(h.Roles, ",") != "tool_result" {
		t.Errorf("来源角色=%v，期望 tool_result", h.Roles)
	}
	if h.Occurrences != 2 {
		t.Errorf("出现次数=%d，期望 2（同一私钥只算一条命中）", h.Occurrences)
	}
	n := 0
	for _, x := range o.Hits {
		if x.RuleID == "ssh_private_key" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("同一私钥产生了 %d 条命中", n)
	}
}

// OpenAI Chat 格式：用户输入里 AK 与 Secret 分在两个 content part 中，仍应成对识别。
func TestOpenAIUserInputPairAcrossParts(t *testing.T) {
	g := testfixture.New(11)
	id, secret := g.AliyunID(), g.AliyunSecret()
	body := mustJSON(t, map[string]any{
		"model": "gpt-x",
		"messages": []any{
			map[string]any{"role": "system", "content": "helpful"},
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "text", "text": "OSS 上传报错，配置如下 access_key_id: " + id},
				map[string]any{"type": "text", "text": "access_key_secret: " + secret},
				map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64," + g.Base64(3000)}},
			}},
		},
	})
	o := newDetector().Scan(detect.Record{Table: "call_logs", RequestID: "r2", RequestBody: body})
	h := hitByRule(o, "aliyun_accesskey")
	if h == nil || h.Severity != "high" {
		t.Fatalf("未按高危识别成对 AK/SK：%+v", o.Hits)
	}
	if strings.Join(h.Roles, ",") != "user_input" {
		t.Errorf("来源角色=%v，期望 user_input", h.Roles)
	}
	if strings.Contains(h.Masked, secret) || strings.Contains(h.Masked, id) {
		t.Errorf("脱敏片段含原文：%s", h.Masked)
	}
}

// 响应中出现凭证（模型把密钥吐出来），以及流式保存的 SSE 被拆开的凭证。
func TestResponseModelOutputAndSSE(t *testing.T) {
	g := testfixture.New(12)
	pat := g.GitLabPAT()
	resp := mustJSON(t, map[string]any{
		"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": "你的令牌是 " + pat}}},
	})
	o := newDetector().Scan(detect.Record{RequestID: "r3", ResponseBody: resp})
	if h := hitByRule(o, "gitlab_token"); h == nil || strings.Join(h.Roles, ",") != "model_output" {
		t.Fatalf("响应中的令牌未按模型输出识别：%+v", o.Hits)
	}

	half := len(pat) / 2
	chunk := func(s string) string {
		b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": s}}}})
		return "data: " + string(b)
	}
	sse := strings.Join([]string{chunk("token="), chunk(pat[:half]), chunk(pat[half:]), "data: [DONE]"}, "\n\n")
	stored, _ := json.Marshal(sse) // jsonb 中保存为字符串
	o = newDetector().Scan(detect.Record{RequestID: "r4", ResponseBody: stored})
	if hitByRule(o, "gitlab_token") == nil {
		t.Fatalf("SSE 分块中的令牌未被拼接识别：%+v", o.Hits)
	}
}

// Responses API 格式与 function_call_output。
func TestResponsesAPI(t *testing.T) {
	g := testfixture.New(13)
	wg := g.WireGuardKey()
	body := mustJSON(t, map[string]any{
		"model":        "gpt-x",
		"instructions": "agent",
		"input": []any{
			map[string]any{"type": "function_call_output", "call_id": "c1", "output": "[Interface]\nPrivateKey = " + wg + "\nAddress = 10.0.0.2/32"},
		},
	})
	o := newDetector().Scan(detect.Record{RequestID: "r5", RequestBody: body})
	h := hitByRule(o, "vpn_wireguard")
	if h == nil || strings.Join(h.Roles, ",") != "tool_result" {
		t.Fatalf("function_call_output 中的 WireGuard 密钥未识别为工具结果：%+v", o.Hits)
	}
}

// 本网关 Key：按 SHA-256 哈希确认，区分本人与他人的 Key。
func TestGatewayKeyConfirmation(t *testing.T) {
	g := testfixture.New(14)
	key := g.SK()
	sum := sha256.Sum256([]byte(key))
	d := detect.New([]byte(strings.Repeat("k", 32)), map[string]detect.GatewayKey{
		hex.EncodeToString(sum[:]): {ID: "k1", UserID: "owner", Name: "张三的 Key", Enabled: true},
	})
	body := mustJSON(t, map[string]any{"messages": []any{map[string]any{"role": "user", "content": "OPENAI_API_KEY=" + key}}})
	o := d.Scan(detect.Record{RequestID: "r6", UserID: "someone-else", RequestBody: body})
	h := hitByRule(o, "gateway_api_key")
	if h == nil {
		t.Fatalf("本网关 Key 未被确认：%+v", o.Hits)
	}
	if !strings.Contains(h.Note, "他人") {
		t.Errorf("未标出贴的是他人 Key：%s", h.Note)
	}
}

// 请求头认证信息属于系统性问题，只统计，不产生员工命中。
func TestAuthHeaderIsSystemicNotHit(t *testing.T) {
	g := testfixture.New(15)
	hdr := mustJSON(t, map[string]any{"Authorization": []any{"Bearer " + g.SK()}, "User-Agent": []any{"claude-cli/1.0"}})
	o := newDetector().Scan(detect.Record{Table: "call_traces", RequestID: "r7", HasHeaderCol: true, RequestHeaders: hdr})
	if !o.Stats.AuthHeader || !o.Stats.AuthUnmasked {
		t.Errorf("认证头统计不正确：%+v", o.Stats)
	}
	if len(o.Hits) != 0 {
		t.Errorf("认证头不应产生员工命中：%+v", o.Hits)
	}
}

// 指纹稳定：同一凭证在不同记录、不同格式（原始换行 / JSON 转义）下指纹相同；不同密钥下指纹不同。
func TestFingerprintStability(t *testing.T) {
	g := testfixture.New(16)
	key := g.PEM("OPENSSH ")
	d := newDetector()
	a := d.Scan(detect.Record{RequestID: "a", RequestBody: mustJSON(t, map[string]any{"prompt": "~/.ssh/id_rsa\n" + key})})
	b := d.Scan(detect.Record{RequestID: "b", RequestBody: []byte("not json ssh " + strings.ReplaceAll(key, "\n", `\n`))})
	ha, hb := hitByRule(a, "ssh_private_key"), hitByRule(b, "ssh_private_key")
	if ha == nil || hb == nil {
		t.Fatalf("未识别：a=%+v b=%+v", a.Hits, b.Hits)
	}
	if ha.Fingerprint != hb.Fingerprint {
		t.Errorf("同一私钥指纹不同：%s vs %s", ha.Fingerprint, hb.Fingerprint)
	}
	if !b.Stats.RequestParseFail {
		t.Error("非 JSON 内容应计入解析失败")
	}
	other := detect.New([]byte(strings.Repeat("z", 32)), nil).Scan(detect.Record{RequestID: "c", RequestBody: mustJSON(t, map[string]any{"prompt": "ssh " + key})})
	if hc := hitByRule(other, "ssh_private_key"); hc == nil || hc.Fingerprint == ha.Fingerprint {
		t.Error("不同 HMAC 密钥应得到不同指纹")
	}
}

// 没有内容的记录计入覆盖缺口，不产生命中。
func TestNoContent(t *testing.T) {
	off := false
	o := newDetector().Scan(detect.Record{RequestID: "r8", LogEnabled: &off})
	if !o.Stats.NoContent || len(o.Hits) != 0 {
		t.Errorf("无内容记录处理不正确：%+v", o)
	}
}
