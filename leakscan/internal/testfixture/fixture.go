// Package testfixture 在运行时生成合成测试凭证（格式合法、内容随机），
// 源码中不出现任何真实或固定的凭证字符串（BR-001：样本集只能使用合成凭证）。
package testfixture

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"strings"
)

const alnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const upperNum = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const hexChars = "0123456789abcdef"

// Gen 是确定性的合成凭证生成器：以 SHA-256(种子‖计数器) 产生字节流，
// 同一种子每次生成相同的测试数据，便于复现。仅用于测试，不用于任何安全用途。
type Gen struct {
	seed    [8]byte
	counter uint64
	buf     []byte
}

// New 创建生成器。
func New(seed int64) *Gen {
	g := &Gen{}
	binary.BigEndian.PutUint64(g.seed[:], uint64(seed))
	return g
}

func (g *Gen) byte() byte {
	if len(g.buf) == 0 {
		var block [16]byte
		copy(block[:8], g.seed[:])
		binary.BigEndian.PutUint64(block[8:], g.counter)
		g.counter++
		sum := sha256.Sum256(block[:])
		g.buf = sum[:]
	}
	b := g.buf[0]
	g.buf = g.buf[1:]
	return b
}

func (g *Gen) pick(set string, n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = set[int(g.byte())%len(set)]
	}
	return string(b)
}

// Alnum 随机字母数字串。
func (g *Gen) Alnum(n int) string { return g.pick(alnum, n) }

// Hex 随机十六进制串。
func (g *Gen) Hex(n int) string { return g.pick(hexChars, n) }

// AliyunID 阿里云 AccessKey ID。
func (g *Gen) AliyunID() string { return "LT" + "AI" + g.Alnum(20) }

// AliyunSecret 阿里云 AccessKey Secret。
func (g *Gen) AliyunSecret() string { return g.Alnum(30) }

// GitLabPAT GitLab 个人访问令牌。
func (g *Gen) GitLabPAT() string { return "gl" + "pat-" + g.pick(alnum+"_-", 20) }

// AWSID AWS Access Key ID。
func (g *Gen) AWSID() string { return "AK" + "IA" + g.pick(upperNum, 16) }

// GitHubPAT GitHub 经典令牌。
func (g *Gen) GitHubPAT() string { return "gh" + "p_" + g.Alnum(36) }

// SK 通用 sk- 格式 Key。
func (g *Gen) SK() string { return "s" + "k-" + g.Alnum(48) }

// Base64 随机 base64。
func (g *Gen) Base64(nbytes int) string {
	b := make([]byte, nbytes)
	for i := range b {
		b[i] = g.byte()
	}
	return base64.StdEncoding.EncodeToString(b)
}

// PEM 生成指定标签的私钥块，按 70 列折行。
func (g *Gen) PEM(label string) string {
	body := g.Base64(1200)
	var lines []string
	for len(body) > 70 {
		lines = append(lines, body[:70])
		body = body[70:]
	}
	lines = append(lines, body)
	dash := strings.Repeat("-", 5)
	return dash + "BEGIN " + label + "PRIVATE KEY" + dash + "\n" + strings.Join(lines, "\n") + "\n" + dash + "END " + label + "PRIVATE KEY" + dash
}

// WireGuardKey WireGuard 32 字节密钥的 base64。
func (g *Gen) WireGuardKey() string { return g.Base64(32) }

// OpenVPNStatic OpenVPN 静态密钥块。
func (g *Gen) OpenVPNStatic() string {
	var lines []string
	for range 16 {
		lines = append(lines, g.Hex(32))
	}
	dash := strings.Repeat("-", 5)
	return dash + "BEGIN OpenVPN Static key V1" + dash + "\n" + strings.Join(lines, "\n") + "\n" + dash + "END OpenVPN Static key V1" + dash
}
