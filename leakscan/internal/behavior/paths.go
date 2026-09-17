// Package behavior 定义端上自查（leakagent）用到的行为侧数据：凭证在文件系统
// 中的常见位置（本文件），以及在其之上构建的行为规则引擎（另见 behavior.go）。
//
// 本文件是敏感路径的唯一数据源。ECAP-011（凭证所属文件路径的敏感标记）与
// ECAP-008（行为规则引擎里 credential_file_read/write、credential_cmd_read
// 三条规则的路径判定）必须共用这份表，不得各自维护一份，否则两处清单迟早
// 漂移——这正是 EBR-006 对 internal/rules 强调的同一类问题在行为侧的重演。
//
// 数据以 Go 源码内嵌常量/字面量表达，不读外部 JSON/YAML：保证
// CGO_ENABLED=0 编译出的单文件二进制可以脱离任何配置目录独立运行（EBR-008）。
//
// 所有正则使用 Go 标准库 regexp（RE2，线性时间），不使用需要回溯的语法
// （前瞻/后顾、反向引用等一律不用，RE2 本就不支持）。
//
// 误报是这张表最大的风险：真实代码仓库里 src/environment.ts、
// README.env.md、.github/、id_rsa.pub 这类路径必须不命中任何条目，否则
// 报告会被噪音淹没，参见 paths_test.go 的 TestNoFalseMatchOnCommonPaths。
// 为此每条模式都锚定在路径分隔符（正斜杠或反斜杠）或文件名边界上，只匹配
// 精确的目录名/文件名/扩展名，不做子串匹配。
//
// 来源声明（ESRC-014）：CC-Monitor（/Users/cgy/wkgit/111-monitor，
// cc_monitor/default_rules.json）没有 LICENSE 文件，代码不可复用；本文件
// 未读取、未参考其正则字面量，所有模式均按下列公开文档/规范独立编写：
//   - OpenSSH ssh-keygen(1)：默认私钥文件名 id_rsa/id_dsa/id_ecdsa/id_ed25519
//   - AWS CLI 官方文档：~/.aws/credentials、~/.aws/sso/cache
//   - kubectl/kubeconfig 官方文档：$HOME/.kube/config，KUBECONFIG 环境变量
//     惯用文件名 kubeconfig(.yaml)
//   - Docker 官方文档：~/.docker/config.json 存储 registry 认证
//   - curl 官方手册：~/.netrc；Windows 下 curl 额外识别 _netrc
//   - npm/pip 官方文档：~/.npmrc、~/.pypirc
//   - Git 官方文档（credential.helper=store）：~/.git-credentials 明文存储
//   - GnuPG 官方手册：~/.gnupg 存放私钥环
//   - Google Cloud SDK 官方文档（gcloud topic configurations）：配置目录在
//     Windows 上为 %APPDATA%\gcloud，在 macOS/Linux 上为 ~/.config/gcloud
//   - 阿里云 CLI（aliyun-cli）官方文档：~/.aliyun/config.json
//   - 腾讯云 CLI（tccli）官方文档：~/.tencentcloud/ 下的 credential 文件
//   - 华为云 CLI/SDK 官方文档：~/.huaweicloud/ 配置目录
//   - 华为云 OBS obsutil 用户指南：默认配置文件 ~/.obsutilconfig
//   - Chromium 项目文档 / 常见数字取证资料：Chromium 系浏览器（Chrome/Edge/
//     Brave/Chromium）保存密码与 Cookie 的 "Login Data"/"Cookies" 文件，
//     常见于 Windows AppData\Local、macOS Library/Application Support、
//     Linux ~/.config 下各浏览器 profile 目录
//   - Apple 官方文档：macOS 钥匙串文件位于 ~/Library/Keychains/
//   - Linux 发行版通用惯例（shadow(5)）：/etc/shadow 存放口令哈希
//   - freedesktop.org Secret Service / GNOME Keyring 文档：
//     ~/.local/share/keyrings/ 存放本地密钥环文件
//   - Microsoft 官方文档：Windows 凭据管理器（Credential Manager）使用 DPAPI
//     在 %LOCALAPPDATA%\Microsoft\Credentials\ 下保存加密凭据；注册表可导出
//     为 .reg 文件
package behavior

import (
	"regexp"

	"leakscan/internal/rules"
)

// SensitivePath 描述一个凭证所在位置。
type SensitivePath struct {
	ID       string   // 稳定标识，如 "ssh_private_key_dir"
	Name     string   // 中文名，进报告
	OS       []string // "darwin" / "linux" / "windows"；空表示全平台
	Patterns []string // 路径匹配模式（大小写不敏感，Go regexp/RE2）
	Severity string   // 复用 rules.SevHigh/SevMedium/SevLow
}

// Paths 是全部已知的敏感路径条目。ECAP-011 与 ECAP-008 都从这张表读取，
// 不得各自维护副本。
//
// 每条 Patterns 都用 `(^|[/\\])` 锚定在路径分隔符或字符串起始处、用 `$`
// 锚定在文件名/扩展名结尾，只做精确的目录名/文件名/扩展名匹配，不做任意
// 子串匹配——这是控制误报的核心手段（见文件头注释）。
//
// 初始化后只读：compiledPaths 在包加载时对 Paths 编译一次并缓存，运行期再
// 追加/修改 Paths 不会反映到 MatchPath/MatchPathForOS。WI-2/WI-3 若要新增
// 条目，改这份源码后重新编译，不要在运行时 append 到 Paths。
var Paths = []SensitivePath{
	// ---------------- 全平台 ----------------
	{
		ID:   "ssh_private_key_dir",
		Name: "SSH 私钥目录（.ssh/）",
		Patterns: []string{
			`(?i)(^|[/\\])\.ssh([/\\]|$)`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "ssh_private_key_file",
		Name: "SSH 私钥文件（id_rsa/id_ed25519/id_ecdsa/id_dsa）",
		// OpenSSH ssh-keygen(1) 默认私钥文件名；只匹配精确文件名，
		// 因此 id_rsa.pub（公钥）、xxx_id_rsa_backup 均不命中。
		Patterns: []string{
			`(?i)(^|[/\\])id_rsa$`,
			`(?i)(^|[/\\])id_ed25519$`,
			`(?i)(^|[/\\])id_ecdsa$`,
			`(?i)(^|[/\\])id_dsa$`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "pem_pkcs12_cert",
		Name: "PEM/PKCS12 证书或私钥文件",
		// 已知的误报来源：.pem 也可能只是公开证书（不含私钥），且测试夹具、
		// node_modules 里的第三方测试证书（如 testdata/server.pem、
		// node_modules/**/fixtures/*.pem）也会命中。接受这个代价而不加更多
		// 限定，因为仅凭路径无法区分"公开证书"与"私钥"，且 .pem/.p12/.pfx
		// 命中率整体远低于误判成本——真正的凭证内容判定仍由 internal/rules
		// 的正文扫描兜底，这张表只是"位置"信号，不是唯一判据。
		Patterns: []string{
			`(?i)\.pem$`,
			`(?i)\.p12$`,
			`(?i)\.pfx$`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "dotenv_file",
		Name: "环境变量文件（.env）",
		// 只匹配精确的 .env 及其官方约定的环境后缀变体（dotenv/Next.js 惯用
		// 命名：.env.local/.env.development/.env.production/.env.test，
		// 可选再加 .local）。README.env.md、src/environment.ts、
		// .env.example 均不满足结尾锚定，不命中。
		Patterns: []string{
			`(?i)(^|[/\\])\.env$`,
			`(?i)(^|[/\\])\.env\.(local|development|dev|production|prod|test|staging|stage)(\.local)?$`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "aws_credentials_file",
		Name: "AWS CLI 凭证文件（.aws/credentials）",
		Patterns: []string{
			`(?i)(^|[/\\])\.aws[/\\]credentials$`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "aws_sso_cache_dir",
		Name: "AWS SSO 令牌缓存目录（.aws/sso/cache）",
		Patterns: []string{
			`(?i)(^|[/\\])\.aws[/\\]sso[/\\]cache([/\\]|$)`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "kube_config_file",
		Name: "Kubernetes kubeconfig 文件",
		Patterns: []string{
			`(?i)(^|[/\\])\.kube[/\\]config$`,
			`(?i)(^|[/\\])kubeconfig(\.ya?ml)?$`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "docker_config_file",
		Name: "Docker 凭证文件（.docker/config.json）",
		Patterns: []string{
			`(?i)(^|[/\\])\.docker[/\\]config\.json$`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "netrc_file",
		Name: "netrc 凭证文件（.netrc）",
		// curl 官方手册：Windows 上若找不到 .netrc 会退而查找 _netrc。
		Patterns: []string{
			`(?i)(^|[/\\])\.netrc$`,
			`(?i)(^|[/\\])_netrc$`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "npmrc_file",
		Name: "npm 令牌配置（.npmrc）",
		// .npmrc 不一定含凭证（可能只是镜像源配置），置信度定为 medium。
		Patterns: []string{
			`(?i)(^|[/\\])\.npmrc$`,
		},
		Severity: rules.SevMedium,
	},
	{
		ID:   "pypirc_file",
		Name: "PyPI 凭证配置（.pypirc）",
		Patterns: []string{
			`(?i)(^|[/\\])\.pypirc$`,
		},
		Severity: rules.SevMedium,
	},
	{
		ID:   "git_credentials_file",
		Name: "Git 明文凭证存储（.git-credentials）",
		// git credential.helper=store 明文写入 user:token@host 形式，
		// 一旦存在该文件基本必含凭证。
		Patterns: []string{
			`(?i)(^|[/\\])\.git-credentials$`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "gnupg_dir",
		Name: "GnuPG 私钥目录（.gnupg/）",
		// GnuPG 手册：默认 GNUPGHOME 在 macOS/Linux 均为 ~/.gnupg；
		// 平台限定见下方 OS 字段。
		OS: []string{"darwin", "linux"},
		Patterns: []string{
			`(?i)(^|[/\\])\.gnupg([/\\]|$)`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "gcloud_config_dir",
		Name: "Google Cloud SDK 凭证目录（gcloud）",
		// gcloud 官方文档：配置目录 Windows 为 %APPDATA%\gcloud，
		// macOS/Linux 为 ~/.config/gcloud；目录下 credentials.db、
		// legacy_credentials/、access_tokens.db 均含 OAuth 凭证。
		Patterns: []string{
			`(?i)(^|[/\\])\.config[/\\]gcloud([/\\]|$)`,
			`(?i)(^|[/\\])AppData[/\\]Roaming[/\\]gcloud([/\\]|$)`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "browser_credential_store",
		Name: "浏览器保存的密码/Cookie 数据库",
		// Chromium 系浏览器（Chrome/Edge/Brave/Chromium）固定文件名
		// "Login Data"（保存的密码）与 "Cookies"（会话态），路径随平台
		// 不同但同属一个 profile 目录家族，是常见的凭证窃取目标。
		Patterns: []string{
			`(?i)Library[/\\]Application Support[/\\](Google[/\\]Chrome|Microsoft Edge|BraveSoftware|Chromium)[/\\].*[/\\](Login Data|Cookies)$`,
			`(?i)AppData[/\\]Local[/\\](Google[/\\]Chrome|Microsoft[/\\]Edge|BraveSoftware|Chromium)[/\\].*[/\\](Login Data|Cookies)$`,
			`(?i)\.config[/\\](google-chrome|chromium|microsoft-edge|BraveSoftware)[/\\].*[/\\](Login Data|Cookies)$`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "firefox_credential_store",
		Name: "Firefox 保存的密码/Cookie 数据库",
		// Mozilla 官方文档（Password Manager、Profile 目录结构）：Firefox 把
		// 保存的密码放在 profile 目录的 logins.json（AES 加密，密钥在
		// key4.db），Cookie 在 cookies.sqlite。profile 目录名不固定
		// （xxxxxxxx.default / .default-release），因此按"任意目录下的
		// 精确文件名"匹配；mozilla/ 目录家族是各发行版的常规位置。
		Patterns: []string{
			`(?i)(^|[/\\])logins\.json$`,
			`(?i)(^|[/\\])key4\.db$`,
			`(?i)(^|[/\\])cookies\.sqlite$`,
			`(?i)(^|[/\\])mozilla[/\\].*[/\\](logins\.json|key4\.db|cookies\.sqlite)$`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "vpn_config_file",
		Name: "VPN 客户端配置文件（OpenVPN/WireGuard）",
		// OpenVPN 官方 howto：客户端配置惯例为 .ovpn 文件（内嵌证书、
		// 私钥块或 auth-user-pass 凭证行）；WireGuard 官方文档：配置为
		// wg0.conf 等接口名.conf，[Interface] 段含 PrivateKey。
		// 内容层判定由 internal/rules 的 vpn_openvpn / vpn_wireguard 承担
		// （tier1），这里补上对应的"位置"信号，两表类别对齐。
		Patterns: []string{
			`(?i)\.ovpn$`,
			`(?i)(^|[/\\])wg[0-9]+\.conf$`,
			`(?i)(^|[/\\])wireguard([/\\]|$)`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "shell_history_file",
		Name: "Shell/REPL 历史文件",
		// shell 与各类 REPL 的历史文件：命令行里粘贴过的 token、
		// export KEY=... 形态的凭证都会留在历史里，是"凭证原本所属文件"
		// 的真实类别（对 ECAP-011 归因有直接价值）。只匹配精确文件名，
		// 不做子串匹配。
		Patterns: []string{
			`(?i)(^|[/\\])\.(bash|zsh|python|mysql|psql|node_repl|sqlite|irb)_history$`,
			`(?i)(^|[/\\])\.zhistory$`,
			`(?i)(^|[/\\])\.claude[/\\]history\.jsonl$`,
		},
		Severity: rules.SevLow,
	},
	{
		ID:   "aliyun_config_file",
		Name: "阿里云 CLI 凭证配置（.aliyun/config.json）",
		// 阿里云 CLI（aliyun-cli）官方文档：aliyun configure 写入
		// ~/.aliyun/config.json，明文含 AccessKeyId/AccessKeySecret。
		Patterns: []string{
			`(?i)(^|[/\\])\.aliyun[/\\]config\.json$`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "tencentcloud_dir",
		Name: "腾讯云 CLI 凭证目录（.tencentcloud/）",
		// 腾讯云 CLI（tccli）官方文档：~/.tencentcloud/ 下按 profile 保存
		// SecretId/SecretKey。
		Patterns: []string{
			`(?i)(^|[/\\])\.tencentcloud([/\\]|$)`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "huaweicloud_dir",
		Name: "华为云 CLI/SDK 凭证目录（.huaweicloud/）",
		Patterns: []string{
			`(?i)(^|[/\\])\.huaweicloud([/\\]|$)`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "obsutil_config_file",
		Name: "华为云 OBS obsutil 配置文件（.obsutilconfig）",
		// 华为云 OBS obsutil 用户指南：默认配置文件为用户主目录下的
		// .obsutilconfig，含 AK/SK。
		Patterns: []string{
			`(?i)(^|[/\\])\.obsutilconfig$`,
		},
		Severity: rules.SevHigh,
	},

	// ---------------- macOS ----------------
	{
		ID:       "macos_keychain_file",
		Name:     "macOS 钥匙串文件（Library/Keychains/）",
		OS:       []string{"darwin"},
		Patterns: []string{`(?i)Library[/\\]Keychains([/\\]|$)`},
		Severity: rules.SevHigh,
	},

	// ---------------- Linux ----------------
	{
		ID:   "linux_etc_shadow",
		Name: "Linux 口令哈希文件（/etc/shadow）",
		OS:   []string{"linux"},
		Patterns: []string{
			`(?i)(^|[/\\])etc[/\\]shadow$`,
		},
		Severity: rules.SevHigh,
	},
	{
		ID:   "linux_keyring_dir",
		Name: "Linux 密钥环存储目录（.local/share/keyrings/）",
		// freedesktop.org Secret Service / GNOME Keyring 文档。
		OS: []string{"linux"},
		Patterns: []string{
			`(?i)(^|[/\\])\.local[/\\]share[/\\]keyrings([/\\]|$)`,
		},
		Severity: rules.SevHigh,
	},

	// ---------------- Windows ----------------
	// 注：§3.2 把 "%APPDATA% 下凭证路径" / "AppData\Roaming\" 列为 Windows
	// 必含项，但这里没有一条泛化的 `AppData[/\\]Roaming([/\\]|$)` 规则——
	// 那样几乎会命中 Windows 上每一个普通应用的配置目录（如
	// AppData\Roaming\Code\、AppData\Roaming\npm\），噪音远大于信号。
	// 改为按已知会在其中存放凭证的具体子路径落地：gcloud_config_dir 的
	// `AppData\Roaming\gcloud\` 分支，以及下面的 windows_reg_export、
	// windows_credential_locker、browser_credential_store 的 Windows 分支。
	{
		ID:   "windows_reg_export",
		Name: "Windows 注册表导出文件（.reg）",
		// 内容不一定含凭证，但常被用来导出含凭证的注册表项，置信度 medium。
		OS: []string{"windows"},
		Patterns: []string{
			`(?i)\.reg$`,
		},
		Severity: rules.SevMedium,
	},
	{
		ID:   "windows_credential_locker",
		Name: "Windows 凭据管理器加密存储（DPAPI）",
		// Microsoft 官方文档：Credential Manager 通过 DPAPI 将凭据加密
		// 保存在 %LOCALAPPDATA%\Microsoft\Credentials\。内容被 DPAPI 加密，
		// 但路径本身即是明确的凭证存储信号，置信度 medium。
		OS: []string{"windows"},
		Patterns: []string{
			`(?i)AppData[/\\]Local[/\\]Microsoft[/\\]Credentials([/\\]|$)`,
		},
		Severity: rules.SevMedium,
	},
}

// compiledPath 是 SensitivePath 编译后的正则形式，供 MatchPath 复用，避免
// 每次调用都重新编译。
type compiledPath struct {
	path    SensitivePath
	regexes []*regexp.Regexp
}

// compiledPaths 在包初始化时一次性编译全部模式；任何模式编译失败都会在
// 程序启动时 panic（regexp.MustCompile 语义），而不是在运行时悄悄漏检。
var compiledPaths = compileAll(Paths)

func compileAll(ps []SensitivePath) []compiledPath {
	out := make([]compiledPath, 0, len(ps))
	for _, p := range ps {
		res := make([]*regexp.Regexp, 0, len(p.Patterns))
		for _, pat := range p.Patterns {
			res = append(res, regexp.MustCompile(pat))
		}
		out = append(out, compiledPath{path: p, regexes: res})
	}
	return out
}

// MatchPath 返回 path 命中的全部敏感路径条目（可能为多条，例如
// ~/.ssh/id_rsa 同时命中"目录"与"具体文件名"两条规则）；未命中返回 nil。
//
// path 必须是单个路径 token，不能是整条命令行或带参数的字符串。文件名/
// 扩展名型模式（以裸 `$` 收尾，如 id_rsa$、credentials$、.env$）要求路径
// 出现在字符串末尾，因此 "cat ~/.ssh/id_rsa" 能命中（恰好以路径结尾），但
// "cat ~/.ssh/id_rsa > /tmp/out" 或 "cat ~/.aws/credentials | grep key" 不会
// ——按空格/管道/重定向切分出候选路径 token 是调用方（WI-3 的
// credential_cmd_read 等规则）的责任，这张表只负责判定"这个 token 像不像
// 一个敏感路径"。目录型模式（以 `([/\\]|$)` 收尾，如 .ssh/）判断的是"字符串
// 中是否出现这个目录片段"，未切词时可能顺带命中，但这只是实现细节，不是
// 承诺的行为，不能依赖；一律按"调用方先切出单个路径 token"处理。见
// TestMatchPathRequiresPathToken。
//
// path 按原样匹配，调用方不需要预先转换分隔符——所有模式已同时兼容
// "/" 与 "\\"。
//
// 是否按平台收窄取决于路径的来源，不能一概而论：
//   - 若路径来自本机文件系统操作（如 WI-2 从 Read/Edit 的 filePath 取到的
//     路径），调用方明确知道当前运行平台，可以改用 MatchPathForOS 进一步
//     收窄，减少与当前平台无关的条目参与匹配。
//   - 若路径来自命令文本（如 WI-3 的 Bash 事件），命令里出现的路径不一定
//     指向本机当前平台——例如 macOS 上执行 `docker exec ... cat
//     /etc/shadow` 或 `ssh host 'cat ~/.ssh/id_rsa'`，此时目标其实是容器
//     或远程主机。这种场景必须用 MatchPath（不做 OS 过滤），否则会把
//     "本机是 darwin，所以 /etc/shadow 这条 Linux 专属规则不算" 这种误判
//     当成"没有命中"，漏掉真正的信号。
func MatchPath(path string) []SensitivePath {
	if path == "" {
		return nil
	}
	var out []SensitivePath
	for _, cp := range compiledPaths {
		for _, re := range cp.regexes {
			if re.MatchString(path) {
				out = append(out, cp.path)
				break
			}
		}
	}
	return out
}

// MatchPathForOS 与 MatchPath 相同，但跳过 OS 字段非空且不包含 goos 的条目
// （goos 取值同 runtime.GOOS，如 "darwin"/"linux"/"windows"）。
func MatchPathForOS(path, goos string) []SensitivePath {
	if path == "" {
		return nil
	}
	var out []SensitivePath
	for _, cp := range compiledPaths {
		if len(cp.path.OS) > 0 && !containsOS(cp.path.OS, goos) {
			continue
		}
		for _, re := range cp.regexes {
			if re.MatchString(path) {
				out = append(out, cp.path)
				break
			}
		}
	}
	return out
}

func containsOS(list []string, goos string) bool {
	for _, s := range list {
		if s == goos {
			return true
		}
	}
	return false
}
