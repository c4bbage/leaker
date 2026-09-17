#!/usr/bin/env bash
# 端到端测试：本机 Docker 起 Postgres，加载网关表结构，写入合成数据，
# 用只读账号执行 probe / scan / 中断续扫，并核对结果。
set -euo pipefail

SCHEMA=${1:?用法：e2e/run.sh <网关表结构 SQL 文件>}
IMAGE=${IMAGE:-postgres:17-alpine}
NAME=leakscan-e2e
PORT=${PORT:-55432}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
export LEAKSCAN_KEY="$WORK/hmac.key"
trap 'docker rm -f $NAME >/dev/null 2>&1 || true; if [ -z "${KEEP:-}" ]; then rm -rf "$WORK"; else echo "输出保留在 $WORK"; fi' EXIT

docker rm -f $NAME >/dev/null 2>&1 || true
docker run -d --name $NAME -e POSTGRES_PASSWORD=admin -p 127.0.0.1:$PORT:5432 "$IMAGE" >/dev/null
for _ in $(seq 60); do docker exec $NAME pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2

# pg_dump 18 的 \restrict 元命令和 PG18 专有参数在 17 上不可用，去掉后加载
grep -v -E '^\\(un)?restrict|^SET transaction_timeout' "$SCHEMA" > "$WORK/schema.sql"
docker exec -i $NAME psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$WORK/schema.sql"

docker exec -i $NAME psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
CREATE ROLE leakscan_ro LOGIN PASSWORD 'ro';
GRANT USAGE ON SCHEMA public TO leakscan_ro;
GRANT SELECT ON call_logs, call_traces, api_keys TO leakscan_ro;
SQL

ADMIN="postgres://postgres:admin@127.0.0.1:$PORT/postgres?sslmode=disable"
RO="postgres://leakscan_ro:ro@127.0.0.1:$PORT/postgres?sslmode=disable"

cd "$ROOT"
go build -o "$WORK/leakscan" ./cmd/leakscan
go run ./e2e/seed -dsn "$ADMIN" -benign 3000

echo "== probe"
"$WORK/leakscan" probe -dsn "$RO" -from 2026-09-01 -to 2026-09-02 -out "$WORK/probe.md" >/dev/null
grep -q "认证头疑似未脱敏" "$WORK/probe.md"

echo "== 完整扫描"
"$WORK/leakscan" scan -dsn "$RO" -from 2026-09-01 -to 2026-09-02 -batch 200 -sleep 0 -out "$WORK/full" -hmac-key "$LEAKSCAN_KEY"
FULL=$(ls -d "$WORK"/full/*)

echo "== 中断后续扫"
"$WORK/leakscan" scan -dsn "$RO" -from 2026-09-01 -to 2026-09-02 -batch 100 -sleep 150ms -out "$WORK/part" -hmac-key "$LEAKSCAN_KEY" &
PID=$!
sleep 2
kill -INT $PID
wait $PID || true
PART=$(ls -d "$WORK"/part/*)
"$WORK/leakscan" scan -dsn "$RO" -resume "$PART" -batch 100 -sleep 0 -hmac-key "$LEAKSCAN_KEY"

echo "== 大小上限（超限记录必须在报告中醒目提示）"
"$WORK/leakscan" scan -dsn "$RO" -from 2026-09-01 -to 2026-09-02 -sleep 0 -max-body 1024 -out "$WORK/small" -hmac-key "$LEAKSCAN_KEY" >/dev/null
grep -q "因内容超过大小上限未扫描" "$(ls -d "$WORK"/small/*)/summary.md"

echo "== 校验"
go run ./e2e/verify -full "$FULL" -resumed "$PART" -probe "$WORK/probe.md"

# 只读账号不能写
if docker exec $NAME psql -U leakscan_ro -d postgres -c "DELETE FROM call_logs" >/dev/null 2>&1; then
  echo "只读账号竟然能写入" >&2; exit 1
fi
echo "E2E 通过"
