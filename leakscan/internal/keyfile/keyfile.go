// Package keyfile 管理指纹 HMAC 密钥文件。
//
// 网关扫描（leakscan）与端上自查（leakagent）都需要这把密钥，但**不共用同一把**：
// 端上二进制分发到大量不受控机器，共用密钥会让持有者可以穷举猜测值比对指纹，
// 破坏指纹的不可还原性（端上产品 EBR-005）。两者用不同的默认路径与文件名。
package keyfile

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// DefaultPath 返回 ~/.<dir>/<name>，取不到家目录时退回当前目录下的隐藏文件。
func DefaultPath(dir, name string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "." + dir + "-" + name
	}
	return filepath.Join(home, "."+dir, name)
}

// LoadOrCreate 读取指纹密钥，不存在则生成。多次扫描必须使用同一把密钥，
// 指纹才能跨次比对。生成的文件权限为 0600，目录为 0700。
func LoadOrCreate(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err == nil {
		k, err := hex.DecodeString(strings.TrimSpace(string(b)))
		if err != nil || len(k) < 32 {
			return nil, fmt.Errorf("%s 格式不正确（需要至少 32 字节的十六进制）", path)
		}
		return k, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(hex.EncodeToString(k)+"\n"), 0o600); err != nil {
		return nil, err
	}
	fmt.Fprintf(os.Stderr, "已生成指纹密钥：%s（请妥善保管，丢失后新旧扫描的指纹无法比对）\n", path)
	return k, nil
}

// MustAbs 返回绝对路径，失败时原样返回。
func MustAbs(p string) string {
	a, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	return a
}
