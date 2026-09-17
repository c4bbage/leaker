package rules

import (
	"regexp"
	"strings"
)

// 结构化凭证（多行块、成对出现）需要在正则之外做少量解析。
// RE2 的重复次数上限为 1000，私钥块这类长内容不能靠一个正则匹配。

const maxBlock = 64 * 1024

var (
	rePEMHeader  = regexp.MustCompile(`-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----`)
	reWhitespace = regexp.MustCompile(`[\s\\]+`)
)

var sshContext = []string{"ssh", "id_rsa", "id_ed25519", "id_ecdsa", "authorized_keys", ".ssh/"}

func scanPEM(text, lower string) []Match {
	if !strings.Contains(text, "PRIVATE KEY") {
		return nil
	}
	var out []Match
	for _, loc := range rePEMHeader.FindAllStringSubmatchIndex(text, -1) {
		label := text[loc[2]:loc[3]]
		bodyStart := loc[1]
		rest := text[bodyStart:]
		if len(rest) > maxBlock {
			rest = rest[:maxBlock]
		}
		complete := false
		body := rest
		if i := strings.Index(rest, "-----END "); i >= 0 {
			body = rest[:i]
			complete = true
		}
		norm := normBlock(body)

		id := "private_key_pem"
		switch {
		case strings.HasPrefix(label, "OPENSSH"):
			id = "ssh_private_key"
		case strings.HasPrefix(label, "PGP"):
			id = "pgp_private_key"
		case containsAny(lower, sshContext):
			id = "ssh_private_key"
		}
		m := Match{RuleID: id, Value: norm, Severity: SevHigh, Confidence: ConfHigh,
			Masked: "BEGIN " + label + "PRIVATE KEY ****(" + itoa(len(norm)) + " 字符)"}
		if !complete {
			m.Severity = SevMedium
			m.Confidence = ConfMedium
			m.Note = "私钥块不完整（可能被截断）"
		}
		if len(norm) < 64 {
			m.Confidence = ConfPlaceholder
			m.Severity = SevLow
			m.Note = "私钥内容过短，疑似示例"
		} else {
			m = finalizeBody(m)
		}
		out = append(out, m)
	}
	return out
}

// finalizeBody 只对私钥主体做占位判断，不做熵检查以外的关键词判断，
// 因为 base64 主体里可能偶然出现类似 "todo" 的子串。
func finalizeBody(m Match) Match {
	if strings.Contains(m.Value, "...") || strings.Contains(strings.ToLower(m.Value), "xxxxxxxx") || entropy(m.Value) < 3.0 {
		m.Confidence = ConfPlaceholder
		m.Severity = SevLow
		m.Note = "疑似占位或示例值"
	}
	return m
}

var escapedNewline = strings.NewReplacer(`\r\n`, "\n", `\n`, "\n", `\r`, "\n", `\t`, " ")

// normBlock 把多行密钥块规整为连续字符串，用于计算指纹。
// 同一把密钥无论以原始多行文本还是 JSON 转义（字面量 \n）出现，结果都相同；
// 头部元数据行（如 Proc-Type、DEK-Info）不参与指纹。
func normBlock(body string) string {
	body = escapedNewline.Replace(body)
	var b strings.Builder
	for _, line := range strings.Split(body, "\n") {
		if strings.Contains(line, ": ") {
			continue
		}
		b.WriteString(line)
	}
	return reWhitespace.ReplaceAllString(b.String(), "")
}

var rePuTTY = regexp.MustCompile(`PuTTY-User-Key-File-\d+:\s*[a-z0-9\-]+`)

func scanPuTTY(text, lower string) []Match {
	if !strings.Contains(text, "PuTTY-User-Key-File-") {
		return nil
	}
	var out []Match
	for _, loc := range rePuTTY.FindAllStringIndex(text, -1) {
		rest := text[loc[1]:]
		if len(rest) > maxBlock {
			rest = rest[:maxBlock]
		}
		i := strings.Index(rest, "Private-Lines:")
		if i < 0 {
			continue
		}
		priv := rest[i:]
		if j := strings.Index(priv, "Private-MAC:"); j >= 0 {
			priv = priv[:j]
		}
		norm := normBlock(priv)
		m := Match{RuleID: "ssh_private_key", Value: norm, Severity: SevHigh, Confidence: ConfHigh,
			Masked: "PuTTY 私钥 ****(" + itoa(len(norm)) + " 字符)"}
		out = append(out, finalizeBody(m))
	}
	return out
}

var (
	reOVPNRemote    = regexp.MustCompile(`(?m)^\s*remote\s+([A-Za-z0-9.\-]+)(?:\s+\d{1,5})?`)
	reOVPNDirective = regexp.MustCompile(`(?m)^\s*(?:client|dev\s+tun|dev\s+tap|proto\s+(?:udp|tcp)[46]?|nobind|remote-cert-tls\s+server)\s*$`)
	reOVPNStatic    = regexp.MustCompile(`-----BEGIN OpenVPN Static key V1-----`)
	reOVPNUserPass  = regexp.MustCompile(`(?s)<auth-user-pass>\s*(\S+)\s+(\S+)\s*</auth-user-pass>`)
)

func scanOpenVPN(text, lower string) []Match {
	var out []Match
	// 静态密钥（tls-auth / tls-crypt）单独出现也算
	for _, loc := range reOVPNStatic.FindAllStringIndex(text, -1) {
		rest := text[loc[1]:]
		if len(rest) > maxBlock {
			rest = rest[:maxBlock]
		}
		complete := false
		if i := strings.Index(rest, "-----END OpenVPN Static key V1-----"); i >= 0 {
			rest = rest[:i]
			complete = true
		}
		norm := normBlock(rest)
		if len(norm) < 64 {
			continue
		}
		m := Match{RuleID: "vpn_openvpn", Value: norm, Severity: SevHigh, Confidence: ConfHigh,
			Masked: "OpenVPN Static key ****(" + itoa(len(norm)) + " 字符)", Note: "tls-auth/tls-crypt 静态密钥"}
		if !complete {
			m.Severity, m.Confidence, m.Note = SevMedium, ConfMedium, "静态密钥不完整（可能被截断）"
		}
		out = append(out, finalizeBody(m))
	}

	if !strings.Contains(lower, "remote") {
		return out
	}
	remotes := reOVPNRemote.FindAllStringSubmatch(text, -1)
	if len(remotes) == 0 || !reOVPNDirective.MatchString(text) {
		return out
	}
	host := remotes[0][1]
	if up := reOVPNUserPass.FindStringSubmatch(text); up != nil {
		out = append(out, finalize(Match{RuleID: "vpn_openvpn", Value: up[1] + ":" + up[2], Severity: SevHigh, Confidence: ConfHigh,
			Masked: "remote " + Mask(host) + " 内嵌账号 " + Mask(up[1]) + " / ****", Note: "配置内嵌 auth-user-pass 账号口令"}))
	}
	embeddedKey := strings.Contains(text, "<key>") && strings.Contains(text, "PRIVATE KEY")
	sev, note := SevMedium, "OpenVPN 客户端配置（未发现内嵌密钥，暴露接入地址）"
	if embeddedKey || len(out) > 0 {
		sev, note = SevHigh, "OpenVPN 客户端配置，含内嵌密钥"
	}
	out = append(out, Match{RuleID: "vpn_openvpn", Value: "remote:" + host, Severity: sev, Confidence: ConfHigh,
		Masked: "remote " + Mask(host), Note: note})
	return out
}

var (
	reWGInterface = regexp.MustCompile(`(?m)^\s*\[(?:Interface|Peer)\]`)
	reWGKey       = regexp.MustCompile(`(?m)^\s*(PrivateKey|PresharedKey)\s*=\s*([A-Za-z0-9+/]{42,43}=)`)
)

func scanWireGuard(text, lower string) []Match {
	if !strings.Contains(lower, "privatekey") && !strings.Contains(lower, "presharedkey") {
		return nil
	}
	if !reWGInterface.MatchString(text) {
		return nil
	}
	var out []Match
	for _, sm := range reWGKey.FindAllStringSubmatch(text, -1) {
		out = append(out, finalize(Match{RuleID: "vpn_wireguard", Value: sm[2], Severity: SevHigh, Confidence: ConfHigh,
			Masked: sm[1] + " = " + Mask(sm[2]), Note: "WireGuard " + sm[1]}))
	}
	return out
}

var (
	reAliyunID     = regexp.MustCompile(`\b((?:LTAI|STS\.)[0-9A-Za-z]{12,30})\b`)
	reAliyunSecret = regexp.MustCompile(`(?i)(?:access[_\-]?key[_\-]?secret|accesskeysecret|ALIBABA_CLOUD_ACCESS_KEY_SECRET|ALICLOUD_SECRET_KEY|ALIYUN_SECRET|oss[_\-]?secret|secret[_\-]?key)["']?\s*[:=]\s*["']?([0-9A-Za-z]{30})\b`)
	aliyunContext  = []string{"aliyun", "alibaba", "alicloud", "oss-cn-", "aliyuncs"}
)

// scanAliyun 按 AK ID 计算指纹；ID 与 Secret 同时出现为高危。
func scanAliyun(text, lower string) []Match {
	hasID := strings.Contains(text, "LTAI") || strings.Contains(text, "STS.")
	if !hasID && !containsAny(lower, aliyunContext) {
		return nil
	}
	ids := reAliyunID.FindAllStringSubmatch(text, -1)
	secrets := reAliyunSecret.FindAllStringSubmatch(text, -1)
	var out []Match
	for _, id := range ids {
		m := Match{RuleID: "aliyun_accesskey", Value: id[1], Masked: Mask(id[1]), Severity: SevMedium, Confidence: ConfHigh, Note: "仅发现 AccessKey ID"}
		if len(secrets) > 0 {
			m.Severity = SevHigh
			m.Masked = Mask(id[1]) + " / " + Mask(secrets[0][1])
			m.Note = "AccessKey ID 与 Secret 同时出现"
			if IsPlaceholder(secrets[0][1]) {
				m.Severity, m.Note = SevMedium, "AccessKey ID 与疑似占位 Secret"
			}
		}
		out = append(out, finalize(m))
	}
	if len(ids) == 0 && containsAny(lower, aliyunContext) {
		for _, s := range secrets {
			out = append(out, finalize(Match{RuleID: "aliyun_accesskey", Value: s[1], Masked: Mask(s[1]),
				Severity: SevHigh, Confidence: ConfMedium, Note: "仅发现 AccessKey Secret（阿里云上下文）"}))
		}
	}
	return out
}

var (
	reAWSID     = regexp.MustCompile(`\b((?:AKIA|ASIA)[0-9A-Z]{16})\b`)
	reAWSSecret = regexp.MustCompile(`(?i)aws.{0,20}?secret.{0,20}?["'=:\s]([A-Za-z0-9/+]{40})(?:[^A-Za-z0-9/+]|$)`)
)

func scanAWS(text, lower string) []Match {
	if !strings.Contains(text, "AKIA") && !strings.Contains(text, "ASIA") {
		return nil
	}
	secrets := reAWSSecret.FindAllStringSubmatch(text, -1)
	var out []Match
	for _, id := range reAWSID.FindAllStringSubmatch(text, -1) {
		m := Match{RuleID: "aws_accesskey", Value: id[1], Masked: Mask(id[1]), Severity: SevMedium, Confidence: ConfHigh, Note: "仅发现 Access Key ID"}
		if len(secrets) > 0 {
			m.Severity, m.Masked, m.Note = SevHigh, Mask(id[1])+" / "+Mask(secrets[0][1]), "Access Key ID 与 Secret 同时出现"
		}
		out = append(out, finalize(m))
	}
	return out
}

var (
	reTencentID     = regexp.MustCompile(`\b(AKID[0-9A-Za-z]{13,40})\b`)
	reTencentSecret = regexp.MustCompile(`(?i)(?:secret_?key|secretkey|TENCENTCLOUD_SECRET_KEY)["']?\s*[:=]\s*["']?([0-9A-Za-z]{32})\b`)
)

// scanTencentSecret 补充 SecretId 与 SecretKey 成对出现的情况，
// 单独的 SecretId 由通用规则识别。
func scanTencentSecret(text, lower string) []Match {
	if !strings.Contains(text, "AKID") {
		return nil
	}
	secrets := reTencentSecret.FindAllStringSubmatch(text, -1)
	if len(secrets) == 0 {
		return nil
	}
	var out []Match
	for _, id := range reTencentID.FindAllStringSubmatch(text, -1) {
		out = append(out, finalize(Match{RuleID: "tencent_accesskey", Value: id[1], Masked: Mask(id[1]) + " / " + Mask(secrets[0][1]),
			Severity: SevHigh, Confidence: ConfHigh, Note: "SecretId 与 SecretKey 同时出现"}))
	}
	return out
}

var (
	reGCPType  = regexp.MustCompile(`"type"\s*:\s*"service_account"`)
	reGCPKeyID = regexp.MustCompile(`"private_key_id"\s*:\s*"([0-9a-f]{40})"`)
)

func scanGCP(text, lower string) []Match {
	if !strings.Contains(lower, "service_account") || !strings.Contains(lower, "private_key") {
		return nil
	}
	if !reGCPType.MatchString(text) {
		return nil
	}
	var out []Match
	for _, sm := range reGCPKeyID.FindAllStringSubmatch(text, -1) {
		out = append(out, finalize(Match{RuleID: "gcp_service_account", Value: sm[1], Masked: "private_key_id " + Mask(sm[1]),
			Severity: SevHigh, Confidence: ConfHigh, Note: "服务账号 JSON 密钥文件"}))
	}
	return out
}

var reURLCred = regexp.MustCompile(`(?i)\b(?:https?|ssh|git)://([^\s/:@"'<>]{1,64}):([^\s/@"'<>]{6,200})@([^\s/"'<>:]+)`)

// scanURLCredential 识别 git remote 等 URL 中内嵌的账号口令，按主机归类。
func scanURLCredential(text, lower string) []Match {
	if !strings.Contains(text, "@") || !strings.Contains(text, "://") {
		return nil
	}
	var out []Match
	for _, sm := range reURLCred.FindAllStringSubmatch(text, -1) {
		user, secret, host := sm[1], sm[2], strings.ToLower(sm[3])
		id, note := "url_credential", "URL 内嵌账号口令"
		switch {
		case strings.HasPrefix(secret, "glpat-") || strings.Contains(host, "gitlab"):
			id, note = "gitlab_token", "git 地址内嵌 GitLab 令牌"
		case strings.HasPrefix(secret, "ghp_") || strings.HasPrefix(secret, "github_pat_") || strings.Contains(host, "github"):
			id, note = "github_token", "git 地址内嵌 GitHub 令牌"
		}
		out = append(out, finalize(Match{RuleID: id, Value: secret, Masked: Mask(user) + ":" + Mask(secret) + "@" + host,
			Severity: SevHigh, Confidence: ConfHigh, Note: note}))
	}
	return out
}
