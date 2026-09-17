// seed 向测试库写入合成调用记录，只用于端到端测试，禁止连接生产库。
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"leakscan/internal/testfixture"
)

type user struct{ id, name, dept string }

func main() {
	dsn := flag.String("dsn", "", "测试库连接串（管理员）")
	benign := flag.Int("benign", 3000, "无泄漏的普通调用条数")
	flag.Parse()
	if !strings.Contains(*dsn, "localhost") && !strings.Contains(*dsn, "127.0.0.1") {
		fmt.Fprintln(os.Stderr, "seed 只允许连接本机测试库")
		os.Exit(2)
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, *dsn)
	must(err)
	defer conn.Close(ctx)

	g := testfixture.New(2026)
	users := map[string]user{
		"zhang": {"11111111-1111-1111-1111-111111111111", "张三", "平台研发部"},
		"li":    {"22222222-2222-2222-2222-222222222222", "李四", "数据部"},
		"wang":  {"33333333-3333-3333-3333-333333333333", "王五", "平台研发部"},
		"zhao":  {"44444444-4444-4444-4444-444444444444", "赵六", "运维部"},
		"sun":   {"55555555-5555-5555-5555-555555555555", "孙七", "市场部"},
		"quiet": {"66666666-6666-6666-6666-666666666666", "周八", "财务部"},
	}
	keyIDs := map[string]string{}
	gatewayKeyOfZhang := g.SK()
	for short, u := range users {
		id := fmt.Sprintf("aaaaaaaa-0000-0000-0000-%012d", len(keyIDs)+1)
		keyIDs[short] = id
		raw := g.SK()
		if short == "zhang" {
			raw = gatewayKeyOfZhang
		}
		sum := sha256.Sum256([]byte(raw))
		logEnabled := short != "quiet"
		_, err := conn.Exec(ctx, `INSERT INTO api_keys (id, user_id, name, key_hash, encrypted_key, key_hint, user_name, dept_name, log_enabled)
			VALUES ($1,$2,$3,$4,'enc',$5,$6,$7,$8)`, id, u.id, u.name+" 的 Key", hex.EncodeToString(sum[:]), raw[len(raw)-4:], u.name, u.dept, logEnabled)
		must(err)
	}

	base := time.Date(2026, 9, 1, 9, 0, 0, 0, time.Local)
	n := 0
	insert := func(short string, at time.Time, ua string, req, resp any, withTrace bool) {
		n++
		u := users[short]
		rid := fmt.Sprintf("req-%06d", n)
		var reqB, respB []byte
		if req != nil {
			reqB, _ = json.Marshal(req)
		}
		if resp != nil {
			respB, _ = json.Marshal(resp)
		}
		_, err := conn.Exec(ctx, `INSERT INTO call_logs (request_id, ts, key_id, user_id, dept_id, model, user_name, dept_name, key_name, user_agent, ip_address, request_body, response_body)
			VALUES ($1,$2,$3,$4,$5,'claude-sonnet',$6,$7,$8,$9,'10.1.2.3',$10,$11)`,
			rid, at, keyIDs[short], u.id, "dept-"+short, u.name, u.dept, u.name+" 的 Key", ua, nullJSON(reqB), nullJSON(respB))
		must(err)
		if withTrace {
			hdr, _ := json.Marshal(map[string]any{"Authorization": []string{"Bearer " + g.SK()}, "User-Agent": []string{ua}, "Content-Type": []string{"application/json"}})
			_, err := conn.Exec(ctx, `INSERT INTO call_traces (request_id, ts, request_headers, request_body, response_body) VALUES ($1,$2,$3,$4,$5)`,
				rid, at.Add(40*time.Second), hdr, nullJSON(reqB), nullJSON(respB))
			must(err)
		}
	}
	msgs := func(parts ...any) map[string]any { return map[string]any{"model": "claude-sonnet", "messages": parts} }
	userText := func(s string) any { return map[string]any{"role": "user", "content": s} }
	toolResult := func(s string) any {
		return map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "t", "content": s}}}
	}
	okResp := map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "text", "text": "好的，我来看看。"}}}

	// 张三：Claude Code 读取 SSH 私钥，连续 3 轮对话都带着
	sshKey := g.PEM("OPENSSH ")
	for i := range 3 {
		hist := []any{userText("服务器连不上，帮我排查"), toolResult("$ cat ~/.ssh/id_ed25519\n" + sshKey)}
		for j := range i {
			hist = append(hist, userText(fmt.Sprintf("继续第 %d 步", j+1)))
		}
		insert("zhang", base.Add(time.Duration(i)*time.Minute), "claude-cli/2.1.0 (external, cli)", msgs(hist...), okResp, true)
	}
	// 李四：直接粘贴阿里云 AK/SK（OpenAI 格式）
	insert("li", base.Add(time.Hour), "python-requests/2.32", map[string]any{"model": "gpt-x", "messages": []any{
		map[string]any{"role": "user", "content": "OSS 上传 403，配置：\naccess_key_id: " + g.AliyunID() + "\naccess_key_secret: " + g.AliyunSecret()},
	}}, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": "请检查权限"}}}}, true)
	// 王五：git remote 带 GitLab 令牌；OpenVPN 配置含静态密钥
	insert("wang", base.Add(2*time.Hour), "opencode/0.9", msgs(userText("push 失败：\nremote: https://oauth2:"+g.GitLabPAT()+"@gitlab.corp.local/infra/deploy.git")), okResp, false)
	insert("wang", base.Add(2*time.Hour+time.Minute), "opencode/0.9", msgs(toolResult("client\ndev tun\nproto udp\nremote vpn.corp.local 1194\n<tls-crypt>\n"+g.OpenVPNStatic()+"\n</tls-crypt>")), okResp, false)
	// 赵六：Responses API，工具结果里有 WireGuard 配置
	insert("zhao", base.Add(3*time.Hour), "codex_cli_rs/0.40", map[string]any{"model": "gpt-x", "instructions": "agent", "input": []any{
		map[string]any{"type": "function_call_output", "call_id": "c1", "output": "[Interface]\nAddress = 10.8.0.9/32\nPrivateKey = " + g.WireGuardKey() + "\n[Peer]\nEndpoint = wg.corp.local:51820"},
	}}, nil, false)
	// 孙七：贴了张三的网关 Key
	insert("sun", base.Add(4*time.Hour), "Mozilla/5.0", msgs(userText("同事给我的 key 能用吗 "+gatewayKeyOfZhang)), okResp, false)
	// 文档示例（应被排除）
	insert("li", base.Add(5*time.Hour), "python-requests/2.32", msgs(userText("官方示例 access_key_id: LTAIxxxxxxxxxxxxxxxx")), okResp, false)
	// 模型输出里吐出密钥
	insert("wang", base.Add(6*time.Hour), "opencode/0.9", msgs(userText("打印一下环境变量")),
		map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "text", "text": "GITHUB_TOKEN=" + g.GitHubPAT()}}}, false)
	// 周八：Key 关闭日志，内容为空
	for i := range 20 {
		insert("quiet", base.Add(7*time.Hour+time.Duration(i)*time.Second), "curl/8", nil, nil, false)
	}
	// 普通调用
	for i := range *benign {
		short := []string{"zhang", "li", "wang", "zhao", "sun"}[i%5]
		insert(short, base.Add(8*time.Hour+time.Duration(i)*time.Second), "claude-cli/2.1.0", msgs(userText(fmt.Sprintf("帮我重构函数 f%d，保持接口不变", i))), okResp, i%10 == 0)
	}
	fmt.Printf("已写入 %d 条调用记录\n", n)
}

func nullJSON(b []byte) any {
	if b == nil {
		return nil
	}
	return string(b)
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
