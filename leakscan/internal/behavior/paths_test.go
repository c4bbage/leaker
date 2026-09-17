package behavior_test

import (
	"regexp"
	"strings"
	"testing"

	"leakscan/internal/behavior"
)

// TestEveryPathCompiles 确认表里全部模式都能被 regexp.MustCompile（RE2，
// 线性时间）编译。behavior.Paths 在包初始化时已经用 MustCompile 编译过一遍
// （编译失败会直接 panic），这里再显式跑一遍 regexp.Compile，
// 既覆盖"能编译"这条验收标准，又不依赖包初始化时的 panic 行为。
func TestEveryPathCompiles(t *testing.T) {
	if len(behavior.Paths) == 0 {
		t.Fatal("behavior.Paths 为空")
	}
	for _, p := range behavior.Paths {
		if len(p.Patterns) == 0 {
			t.Errorf("%s: 没有任何 Pattern", p.ID)
		}
		for _, pat := range p.Patterns {
			if _, err := regexp.Compile(pat); err != nil {
				t.Errorf("%s: 模式 %q 编译失败: %v", p.ID, pat, err)
			}
		}
	}
}

// TestPathIDsUnique 确认 ID 不重复——ID 是 ECAP-011/ECAP-008 引用条目的
// 稳定标识，重复会让引用方无法区分具体命中的是哪一条。
func TestPathIDsUnique(t *testing.T) {
	seen := make(map[string]bool, len(behavior.Paths))
	for _, p := range behavior.Paths {
		if p.ID == "" {
			t.Errorf("存在空 ID 的条目：%+v", p)
			continue
		}
		if seen[p.ID] {
			t.Errorf("ID 重复：%s", p.ID)
		}
		seen[p.ID] = true
	}
}

// hasID 报告 got 中是否存在指定 ID 的条目。
func hasID(got []behavior.SensitivePath, id string) bool {
	for _, p := range got {
		if p.ID == id {
			return true
		}
	}
	return false
}

// TestKnownPathsMatch 是表驱动测试：一批已知的真实凭证路径（覆盖全平台 /
// macOS / Linux / Windows / 国内云）必须命中预期条目。
func TestKnownPathsMatch(t *testing.T) {
	cases := []struct {
		name string
		path string
		id   string
	}{
		{"unix ssh 私钥", "~/.ssh/id_rsa", "ssh_private_key_file"},
		{"unix ssh 目录", "~/.ssh/id_rsa", "ssh_private_key_dir"},
		{"绝对路径 ed25519 私钥", "/home/user/.ssh/id_ed25519", "ssh_private_key_file"},
		{"windows aws 凭证", `C:\Users\x\.aws\credentials`, "aws_credentials_file"},
		{"aws sso 缓存", "~/.aws/sso/cache/abcd1234.json", "aws_sso_cache_dir"},
		{"linux shadow", "/etc/shadow", "linux_etc_shadow"},
		{"macos 钥匙串", "/Users/dev/Library/Keychains/login.keychain-db", "macos_keychain_file"},
		{"kube config 固定文件名", "~/.kube/config", "kube_config_file"},
		{"kubeconfig 通用文件名", "/tmp/kubeconfig.yaml", "kube_config_file"},
		{"docker 凭证", "/root/.docker/config.json", "docker_config_file"},
		{"netrc", "~/.netrc", "netrc_file"},
		{"windows _netrc", `C:\Users\x\_netrc`, "netrc_file"},
		{"dotenv", "project/.env", "dotenv_file"},
		{"dotenv production local", "project/.env.production.local", "dotenv_file"},
		{"git 明文凭证", "~/.git-credentials", "git_credentials_file"},
		{"npmrc", "~/.npmrc", "npmrc_file"},
		{"pypirc", "~/.pypirc", "pypirc_file"},
		{"gnupg", "~/.gnupg/private-keys-v1.d/ABCDEF.key", "gnupg_dir"},
		{"pem 证书", "server.pem", "pem_pkcs12_cert"},
		{"p12 证书", "client.p12", "pem_pkcs12_cert"},
		{"pfx 证书", "client.pfx", "pem_pkcs12_cert"},
		{"gcloud unix 配置", "~/.config/gcloud/legacy_credentials/user@x.com/adc.json", "gcloud_config_dir"},
		{"gcloud windows 配置", `C:\Users\x\AppData\Roaming\gcloud\credentials.db`, "gcloud_config_dir"},
		{"阿里云配置", "~/.aliyun/config.json", "aliyun_config_file"},
		{"腾讯云目录", "~/.tencentcloud/default.credential", "tencentcloud_dir"},
		{"华为云目录", "~/.huaweicloud/credentials.csv", "huaweicloud_dir"},
		{"obsutil 配置", "~/.obsutilconfig", "obsutil_config_file"},
		{"linux 密钥环", "~/.local/share/keyrings/login.keyring", "linux_keyring_dir"},
		{"windows reg 导出", `C:\Users\x\Desktop\backup.reg`, "windows_reg_export"},
		{"windows 凭据管理器", `C:\Users\x\AppData\Local\Microsoft\Credentials\C287..`, "windows_credential_locker"},
		{"macos 浏览器密码库", "/Users/dev/Library/Application Support/Google/Chrome/Default/Login Data", "browser_credential_store"},
		{"windows 浏览器 cookie", `C:\Users\x\AppData\Local\Google\Chrome\User Data\Default\Cookies`, "browser_credential_store"},
		{"linux 浏览器密码库", "~/.config/google-chrome/Default/Login Data", "browser_credential_store"},
		{"firefox logins.json", "~/.mozilla/firefox/abc123.default/logins.json", "firefox_credential_store"},
		{"firefox key4.db", "/home/u/snap/firefox/common/.mozilla/firefox/x.default-release/key4.db", "firefox_credential_store"},
		{"firefox cookies.sqlite", "/Users/dev/Library/Application Support/Firefox/Profiles/y.default/cookies.sqlite", "firefox_credential_store"},
		{"openvpn 配置", "/etc/openvpn/client/company.ovpn", "vpn_config_file"},
		{"wireguard 接口配置", "/etc/wireguard/wg0.conf", "vpn_config_file"},
		{"wireguard 目录", "~/wireguard/tunnel1.conf", "vpn_config_file"},
		{"bash 历史", "/root/.bash_history", "shell_history_file"},
		{"zsh 历史", "/home/u/.zsh_history", "shell_history_file"},
		{"zsh 会话历史别名", "/home/u/.zhistory", "shell_history_file"},
		{"claude 历史文件", "/Users/dev/.claude/history.jsonl", "shell_history_file"},
		{"psql 历史", "/home/u/.psql_history", "shell_history_file"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := behavior.MatchPath(c.path)
			if !hasID(got, c.id) {
				t.Errorf("路径 %q 未命中 %s；实际命中=%+v", c.path, c.id, got)
			}
		})
	}
}

// TestNoFalseMatchOnCommonPaths 是这张表最重要的护栏：真实代码库里常见的
// 路径绝不能误命中，否则报告会被噪音淹没。
func TestNoFalseMatchOnCommonPaths(t *testing.T) {
	paths := []string{
		"src/environment.ts",
		"README.env.md",
		".github/",
		".github/workflows/ci.yml",
		".gitignore",
		"package.json",
		"go.mod",
		"go.sum",
		"docs/README.md",
		"internal/rules/rules.go",
		"config/kubeconfig-example.yaml",
		"test/fixtures/id_rsa.pub.example",
		"id_rsa.pub",
		".env.example",
		"src/aws/credentials.go",
		"node_modules/aws-sdk/credentials.js",
		".ssh-agent-launcher.sh",
		"environment.py",
		"kubeconfig_generator.py",
		"my-npmrc-parser.go",
		"assets/aws.pem.png",
		".dockerignore",
		".gnupg-backup.tar.gz",
		"scripts/obsutilconfig_template.md",
		"cmd/leakagent/main.go",
		"internal/behavior/paths.go",
		"README.md",
		"CHANGELOG.md",
		".env-sample",
		"docs/wireguard-setup.md",           // wireguard 子串在文件名里，非目录/配置
		"internal/config/openvpn.go",        // openvpn 子串，.go 文件
		"src/history.ts",                    // history 子串
		"test/fixtures/logins.json.example", // 后缀非 .json
		"web/src/key4.db.bak",               // key4.db.bak 非 key4.db 结尾
	}
	for _, p := range paths {
		t.Run(p, func(t *testing.T) {
			if got := behavior.MatchPath(p); len(got) != 0 {
				t.Errorf("路径 %q 不应命中任何敏感路径条目，实际命中=%+v", p, got)
			}
		})
	}
}

// TestMatchPathRequiresPathToken 钉住 MatchPath 的调用契约：它只接受单个
// 路径 token，不做命令行解析。调用方（尤其 WI-3 的 credential_cmd_read）
// 必须先按空格/管道/重定向把命令切成候选路径 token 再逐个传进来。
//
// 文件名/扩展名型模式（以裸 `$` 收尾，如 id_rsa$、credentials$、.env$）严格
// 要求路径出现在字符串末尾——未切词的命令字符串里路径后面还跟着重定向、
// 管道等内容时，这类模式不会命中，必须先切词。
//
// 目录型模式（以 `([/\\]|$)` 收尾，如 .ssh/、.aws/sso/cache/）判断的是
// "字符串中是否出现这个目录片段"，即使不做切词也可能顺带命中未切词的命令
// 字符串——但这只是实现细节，不是本表承诺的行为，调用方不能依赖它，必须
// 统一按"传入单个路径 token"处理，否则文件名型模式的漏判会被掩盖。
func TestMatchPathRequiresPathToken(t *testing.T) {
	// 整条路径独占字符串时，文件名型模式可以命中。
	if got := behavior.MatchPath("cat ~/.ssh/id_rsa"); !hasID(got, "ssh_private_key_file") {
		t.Errorf("末尾即路径的字符串应命中 ssh_private_key_file：%+v", got)
	}
	// 路径后面还跟着别的内容（重定向、管道）时，文件名型模式必须不命中——
	// 这是调用方必须先切词的直接证据。
	cases := []struct {
		cmd string
		id  string
	}{
		{"cat ~/.ssh/id_rsa > /tmp/out", "ssh_private_key_file"},
		{"cat ~/.aws/credentials | grep key", "aws_credentials_file"},
		{"cp ~/.ssh/id_rsa /tmp/", "ssh_private_key_file"},
		{"cat ~/.git-credentials 2>/dev/null", "git_credentials_file"},
	}
	for _, c := range cases {
		if got := behavior.MatchPath(c.cmd); hasID(got, c.id) {
			t.Errorf("未切词的命令字符串 %q 不应命中文件名型模式 %s（应由调用方先切出路径 token）：%+v", c.cmd, c.id, got)
		}
	}
}

// TestAllPatternsCaseInsensitive 确认每条 Pattern 都带 (?i) 前缀——
// SensitivePath.OS/Patterns 的字段文档承诺"大小写不敏感"，这条测试防止
// 之后有人往表里加新条目时漏写这个前缀，导致 Windows/macOS 默认不区分
// 大小写的文件系统上出现漏判。
func TestAllPatternsCaseInsensitive(t *testing.T) {
	for _, p := range behavior.Paths {
		for _, pat := range p.Patterns {
			if !strings.HasPrefix(pat, "(?i)") {
				t.Errorf("%s: 模式 %q 缺少 (?i) 前缀", p.ID, pat)
			}
		}
	}
}

// TestMatchPathForOSFiltersByPlatform 确认 OS 字段真的会过滤——平台限定的
// 条目在其他平台下不应通过 MatchPathForOS 命中，即便路径字符串本身仍满足
// 正则（例如把 /etc/shadow 这种写法错误地放进别的平台场景）。
func TestMatchPathForOSFiltersByPlatform(t *testing.T) {
	got := behavior.MatchPathForOS("/etc/shadow", "darwin")
	if hasID(got, "linux_etc_shadow") {
		t.Errorf("linux_etc_shadow 是 Linux 限定条目，不应在 darwin 下命中：%+v", got)
	}
	got = behavior.MatchPathForOS("/etc/shadow", "linux")
	if !hasID(got, "linux_etc_shadow") {
		t.Errorf("linux_etc_shadow 应在 linux 下命中：%+v", got)
	}
	// 全平台条目不受 OS 过滤影响。
	got = behavior.MatchPathForOS("~/.ssh/id_rsa", "windows")
	if !hasID(got, "ssh_private_key_file") {
		t.Errorf("全平台条目 ssh_private_key_file 不应被 OS 过滤掉：%+v", got)
	}
}
