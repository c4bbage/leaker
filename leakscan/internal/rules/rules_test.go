package rules_test

import (
	"strings"
	"testing"
	"time"

	"leakscan/internal/rules"
	"leakscan/internal/testfixture"
)

func find(ms []rules.Match, id string) *rules.Match {
	for i := range ms {
		if ms[i].RuleID == id && ms[i].Confidence != rules.ConfPlaceholder {
			return &ms[i]
		}
	}
	return nil
}

func TestTier1Types(t *testing.T) {
	g := testfixture.New(1)
	akID, akSecret := g.AliyunID(), g.AliyunSecret()
	pat := g.GitLabPAT()
	wg := g.WireGuardKey()
	psk := g.Alnum(24)

	cases := []struct {
		name     string
		text     string
		rule     string
		severity string
		secret   string // 原文不得出现在脱敏片段中
	}{
		{"openssh 私钥", "我的 ~/.ssh/id_ed25519 内容：\n" + g.PEM("OPENSSH "), "ssh_private_key", rules.SevHigh, ""},
		{"RSA 私钥 + ssh 上下文", "cat ~/.ssh/id_rsa\n" + g.PEM("RSA "), "ssh_private_key", rules.SevHigh, ""},
		{"JSON 转义的私钥", strings.ReplaceAll("ssh key: "+g.PEM("OPENSSH "), "\n", `\n`), "ssh_private_key", rules.SevHigh, ""},
		{"截断的私钥", g.PEM("OPENSSH ")[:600], "ssh_private_key", rules.SevMedium, ""},
		{"WireGuard", "[Interface]\nAddress = 10.8.0.2/24\nPrivateKey = " + wg + "\n\n[Peer]\nEndpoint = vpn.corp.local:51820", "vpn_wireguard", rules.SevHigh, wg},
		{"OpenVPN 静态密钥", "client\ndev tun\nremote vpn.corp.local 1194\n<tls-crypt>\n" + g.OpenVPNStatic() + "\n</tls-crypt>", "vpn_openvpn", rules.SevHigh, ""},
		{"OpenVPN 无密钥配置", "client\ndev tun\nproto udp\nremote vpn.corp.local 1194\nremote-cert-tls server", "vpn_openvpn", rules.SevMedium, ""},
		{"IPsec PSK", `vpn 配置 ipsec.secrets: ` + "\n" + `: PSK "` + psk + `"`, "vpn_ipsec_psk", rules.SevHigh, psk},
		{"阿里云 AK/SK 成对", "ALIBABA_CLOUD_ACCESS_KEY_ID=" + akID + "\nALIBABA_CLOUD_ACCESS_KEY_SECRET=" + akSecret, "aliyun_accesskey", rules.SevHigh, akSecret},
		{"阿里云仅 ID", "accessKeyId: " + akID, "aliyun_accesskey", rules.SevMedium, ""},
		{"GitLab PAT", "export GITLAB_TOKEN=" + pat, "gitlab_token", rules.SevHigh, pat},
		{"git remote 内嵌 GitLab 令牌", "git remote add origin https://oauth2:" + pat + "@gitlab.corp.local/team/app.git", "gitlab_token", rules.SevHigh, pat},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := find(rules.Scan(c.text), c.rule)
			if m == nil {
				t.Fatalf("未识别出 %s；结果=%+v", c.rule, rules.Scan(c.text))
			}
			if m.Severity != c.severity {
				t.Errorf("严重程度=%s，期望 %s（note=%s）", m.Severity, c.severity, m.Note)
			}
			if c.secret != "" && strings.Contains(m.Masked, c.secret) {
				t.Errorf("脱敏片段包含原文：%s", m.Masked)
			}
		})
	}
}

func TestTier2Types(t *testing.T) {
	g := testfixture.New(2)
	cases := map[string]string{
		"aws_accesskey":          "aws_access_key_id = " + g.AWSID(),
		"github_token":           "token " + g.GitHubPAT(),
		"db_connection":          "DATABASE_URL=postgres://app:" + g.Alnum(16) + "@db.corp.local:5432/app",
		"k8s_credential":         "users:\n- name: admin\n  user:\n    client-key-data: " + g.Base64(90),
		"im_webhook":             "curl https://oapi.dingtalk.com/robot/send?access_token=" + g.Hex(64),
		"app_secret":             `{"app_id":"cli_x","app_secret":"` + g.Alnum(32) + `"}`,
		"llm_api_key_generic":    "OPENAI_API_KEY=" + g.SK(),
		"gcp_service_account":    `{"type": "service_account", "private_key_id": "` + g.Hex(40) + `", "private_key": "x"}`,
		"telegram_bot_token":     "bot " + "12345678" + "9:AA" + g.Alnum(33),
		"crypto_private_key":     "wallet private_key: 0x" + g.Hex(64),
		"package_registry_token": "//registry.npmjs.org/:_authToken=npm_" + g.Alnum(36),
		"huggingface_token":      "HF_TOKEN=hf_" + g.Alnum(34),
		"sendgrid_key":           "SENDGRID_API_KEY=SG." + g.Alnum(22) + "." + g.Alnum(43),
		"stripe_secret":          "STRIPE_SECRET_KEY=sk_live_" + g.Alnum(24),
	}
	for id, text := range cases {
		t.Run(id, func(t *testing.T) {
			if find(rules.Scan(text), id) == nil {
				t.Fatalf("未识别出 %s；结果=%+v", id, rules.Scan(text))
			}
		})
	}
}

func TestRepeatedWalletFixtureIsPlaceholder(t *testing.T) {
	g := testfixture.New(21)
	unit := g.Hex(16)
	fixture := strings.Repeat(unit, 4)
	text := "it('redacts wallet keys', () => { const privateKey = '" + fixture + "'; expect(redact(privateKey)).not.toContain(privateKey) })"

	ms := rules.Scan(text)
	var got *rules.Match
	for i := range ms {
		if ms[i].RuleID == "crypto_private_key" {
			got = &ms[i]
			break
		}
	}
	if got == nil {
		t.Fatal("周期性钱包测试夹具应保留一条可审计的 crypto_private_key 命中")
	}
	if got.Confidence != rules.ConfPlaceholder || got.Severity != rules.SevLow {
		t.Fatalf("周期性钱包测试夹具未降级：rule=%s confidence=%s severity=%s masked=%s",
			got.RuleID, got.Confidence, got.Severity, got.Masked)
	}

	realistic := g.Hex(64)
	if rules.IsPlaceholder(realistic) {
		t.Fatal("非周期性的合成钱包私钥不应被视为占位值")
	}
	if m := find(rules.Scan("wallet private_key: 0x"+realistic), "crypto_private_key"); m == nil {
		t.Fatal("非周期性的合成钱包私钥仍应被识别")
	}

	partial := strings.Repeat(unit, 3) + g.Hex(16)
	if rules.IsPlaceholder(partial) {
		t.Fatal("仅部分重复的值不应被视为精确周期占位值")
	}
}

func TestPlaceholdersDowngraded(t *testing.T) {
	texts := []string{
		"ALIBABA_CLOUD_ACCESS_KEY_ID=LTAIxxxxxxxxxxxxxxxx",
		"aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
		"GITLAB_TOKEN=glpat-your_token_here_xxxxxx",
		"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----",
	}
	for _, text := range texts {
		for _, m := range rules.Scan(text) {
			if m.Confidence != rules.ConfPlaceholder && m.Severity == rules.SevHigh {
				t.Errorf("占位值未降级：%q → %+v", text, m)
			}
		}
	}
}

// TestImportedRulePlaceholders 针对从 agentsview 移植的三条规则：它们原本各带一个
// 专用 validate 占位符判定，本包改用全局 IsPlaceholder + 熵值下限。这里验证换用后
// 仍能挡住占位值，而不是假定如此。
func TestImportedRulePlaceholders(t *testing.T) {
	cases := map[string]string{
		"huggingface_token 低熵": "HF_TOKEN=hf_" + strings.Repeat("a", 34),
		"huggingface_token 占位": "HF_TOKEN=hf_EXAMPLE" + strings.Repeat("a", 30),
		"sendgrid_key 低熵":      "SENDGRID_API_KEY=SG." + strings.Repeat("a", 22) + "." + strings.Repeat("b", 43),
		"sendgrid_key 占位":      "SENDGRID_API_KEY=SG.example_aaaaaaaaaaaaaa." + strings.Repeat("c", 43),
		"stripe_secret 低熵":     "STRIPE_SECRET_KEY=sk_live_" + strings.Repeat("a", 24),
		"stripe_secret 占位":     "STRIPE_SECRET_KEY=sk_live_EXAMPLEaaaaaaaaaaaaaaaa",
	}
	for name, text := range cases {
		t.Run(name, func(t *testing.T) {
			ms := rules.Scan(text)
			if len(ms) == 0 {
				t.Fatalf("正则未匹配到，占位测试无意义：%q", text)
			}
			for _, m := range ms {
				if m.Confidence != rules.ConfPlaceholder {
					t.Errorf("占位值未标记为 placeholder：%q → id=%s conf=%s", text, m.RuleID, m.Confidence)
				}
			}
		})
	}
}

func TestPublicKeyIsNotPrivateKey(t *testing.T) {
	g := testfixture.New(3)
	text := "ssh-ed25519 " + g.Base64(51) + " dev@laptop"
	for _, m := range rules.Scan(text) {
		if m.RuleID == "ssh_private_key" {
			t.Fatalf("公钥被识别为私钥：%+v", m)
		}
	}
}

// 构造的超长内容不能让识别耗时失控（RE2 线性时间）。
func TestAdversarialInputLinear(t *testing.T) {
	text := strings.Repeat("a=", 200000) + strings.Repeat("-----BEGIN ", 20000) + strings.Repeat("postgres://", 20000)
	done := make(chan struct{})
	go func() {
		rules.Scan(text)
		close(done)
	}()
	select {
	case <-done:
	case <-timeoutAfter():
		t.Fatal("识别超时，可能存在回溯")
	}
}

func timeoutAfter() <-chan time.Time { return time.After(10 * time.Second) }

// TestFillerOnlyValuesArePlaceholders 来自首次真实数据扫描：README 里的
// postgres://user:***@host 被报成高危数据库连接凭证。全遮盖字符的值与长度无关，
// 一定是占位。
func TestFillerOnlyValuesArePlaceholders(t *testing.T) {
	texts := []string{
		"DATABASE_URL=postgres://leakscan_ro:***@replica-host:5432/gateway",
		"mysql://root:xxxx@db.local:3306/app",
		"export DB_URL=postgres://u:......@h:5432/d",
	}
	for _, text := range texts {
		for _, m := range rules.Scan(text) {
			if m.Confidence != rules.ConfPlaceholder {
				t.Errorf("遮盖值未标记为 placeholder：%q → id=%s conf=%s masked=%s",
					text, m.RuleID, m.Confidence, m.Masked)
			}
		}
	}
}
