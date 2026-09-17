#!/usr/bin/env bash
# 交叉编译 Windows / macOS / Linux 版本到 dist/，并生成 SHA256SUMS。
# 两个二进制：leakscan（网关侧，含 pgx）、leakagent（端上自查，不含任何数据库代码）。
# 纯 Go 实现（CGO_ENABLED=0），产物为无外部依赖的静态可执行文件。
set -euo pipefail
cd "$(dirname "$0")"

RULESET=$(sed -n 's/^const Version = "\(.*\)"/\1/p' internal/rules/rules.go)
BUILD=$(date +%Y%m%d)
OUT=dist
rm -rf "$OUT"; mkdir -p "$OUT"

targets=(
  windows/amd64 windows/arm64
  darwin/amd64 darwin/arm64
  linux/amd64 linux/arm64
)
for t in "${targets[@]}"; do
  os=${t%/*}; arch=${t#*/}
  ext=""; [ "$os" = windows ] && ext=".exe"
  for prog in leakscan leakagent; do
    name="${prog}-${os}-${arch}${ext}"
    CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w" -o "$OUT/$name" ./cmd/$prog
    echo "已生成 $OUT/$name"
  done
done

(cd "$OUT" && shasum -a 256 leakscan-* leakagent-* > SHA256SUMS)
echo "规则集版本 ${RULESET}，构建日期 ${BUILD}"
