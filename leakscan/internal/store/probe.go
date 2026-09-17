package store

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Probe 只做聚合统计和结构探查（字段名、类型、数量、大小分位），不输出任何内容值。
// 用于正式扫描前确认网关实际保存了什么（PRODUCT Q-002、Q-013）。
func Probe(ctx context.Context, conn *pgx.Conn, from, to time.Time, w io.Writer) {
	fmt.Fprintf(w, "# leakscan 探查报告\n\n窗口：%s ~ %s\n\n", from.Format(time.RFC3339), to.Format(time.RFC3339))
	fmt.Fprintln(w, "本报告只含数量、字段名和大小统计，不含任何请求或响应内容。")

	section(w, "1. call_logs 内容是否落库")
	table(ctx, conn, w, []string{"总行数", "有 request_body", "有 response_body", "最早 ts", "最晚 ts"}, `
SELECT count(*), count(request_body), count(response_body), min(ts)::text, max(ts)::text
FROM call_logs WHERE ts >= $1 AND ts < $2`, from, to)

	section(w, "2. 日志开关与内容（按 Key 的 log_enabled）")
	table(ctx, conn, w, []string{"log_enabled", "行数", "有 request_body"}, `
SELECT coalesce(ak.log_enabled::text, '无对应 Key'), count(*), count(cl.request_body)
FROM call_logs cl LEFT JOIN api_keys ak ON ak.id::text = cl.key_id
WHERE cl.ts >= $1 AND cl.ts < $2
GROUP BY 1 ORDER BY 2 DESC`, from, to)

	section(w, "3. request_body 顶层结构（字段名组合）")
	table(ctx, conn, w, []string{"JSON 类型", "顶层字段", "行数"}, `
SELECT jsonb_typeof(request_body),
       coalesce((SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(request_body)='object' THEN request_body END) AS t(k)), ''),
       count(*)
FROM call_logs WHERE ts >= $1 AND ts < $2 AND request_body IS NOT NULL
GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15`, from, to)

	section(w, "4. response_body 顶层结构（按是否流式）")
	table(ctx, conn, w, []string{"stream", "JSON 类型", "顶层字段", "行数"}, `
SELECT stream::text, jsonb_typeof(response_body),
       coalesce((SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(response_body)='object' THEN response_body END) AS t(k)), ''),
       count(*)
FROM call_logs WHERE ts >= $1 AND ts < $2 AND response_body IS NOT NULL
GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 15`, from, to)

	section(w, "5. messages 中的角色与 content 类型")
	table(ctx, conn, w, []string{"role", "content 类型", "消息数"}, `
SELECT coalesce(m->>'role',''), coalesce(jsonb_typeof(m->'content'),''), count(*)
FROM call_logs,
     jsonb_array_elements(CASE WHEN jsonb_typeof(request_body->'messages')='array' THEN request_body->'messages' ELSE '[]'::jsonb END) m
WHERE ts >= $1 AND ts < $2
GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20`, from, to)

	section(w, "6. 内容块 type 分布（识别 tool_result / tool_use 等）")
	table(ctx, conn, w, []string{"块 type", "块数"}, `
SELECT coalesce(b->>'type',''), count(*)
FROM call_logs,
     jsonb_array_elements(CASE WHEN jsonb_typeof(request_body->'messages')='array' THEN request_body->'messages' ELSE '[]'::jsonb END) m,
     jsonb_array_elements(CASE WHEN jsonb_typeof(m->'content')='array' THEN m->'content' ELSE '[]'::jsonb END) b
WHERE ts >= $1 AND ts < $2
GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, from, to)

	section(w, "7. 内容大小分位（pg_column_size，字节，P50/P90/P99/最大）")
	table(ctx, conn, w, []string{"字段", "分位"}, `
SELECT 'request_body', (percentile_disc(ARRAY[0.5,0.9,0.99,1.0]) WITHIN GROUP (ORDER BY pg_column_size(request_body)))::text
FROM call_logs WHERE ts >= $1 AND ts < $2 AND request_body IS NOT NULL
UNION ALL
SELECT 'response_body', (percentile_disc(ARRAY[0.5,0.9,0.99,1.0]) WITHIN GROUP (ORDER BY pg_column_size(response_body)))::text
FROM call_logs WHERE ts >= $1 AND ts < $2 AND response_body IS NOT NULL`, from, to)

	section(w, "8. call_traces 内容与请求头")
	table(ctx, conn, w, []string{"总行数", "有 request_body", "有 response_body", "有 request_headers", "含认证头", "认证头疑似未脱敏"}, `
WITH h AS (
  SELECT request_body, response_body, request_headers,
         (SELECT string_agg(v, ' ') FROM jsonb_each_text(CASE WHEN jsonb_typeof(request_headers)='object' THEN request_headers END) AS e(k, v)
          WHERE lower(k) IN ('authorization','x-api-key','api-key','proxy-authorization','x-goog-api-key')) AS auth
  FROM call_traces WHERE ts >= $1 AND ts < $2
)
SELECT count(*), count(request_body), count(response_body), count(request_headers),
       count(*) FILTER (WHERE auth IS NOT NULL AND auth <> ''),
       count(*) FILTER (WHERE length(auth) > 20 AND auth !~* '[*]|\.\.\.|redact|mask|xxxx')
FROM h`, from, to)

	section(w, "9. call_traces 请求头字段名（只列名字）")
	table(ctx, conn, w, []string{"header", "出现次数"}, `
SELECT k, count(*)
FROM call_traces, jsonb_object_keys(CASE WHEN jsonb_typeof(request_headers)='object' THEN request_headers END) AS t(k)
WHERE ts >= $1 AND ts < $2
GROUP BY 1 ORDER BY 2 DESC LIMIT 40`, from, to)

	section(w, "10. 写入时机：call_traces.ts（写入时刻）减 call_logs.ts 的秒数分位（P50/P90/P99/最大）")
	fmt.Fprintln(w, "如果差值明显大于 0 且接近请求耗时，说明 call_logs.ts 是请求开始时间、记录在请求结束后才写入，持续扫描时需要重叠补扫（Q-013）。")
	table(ctx, conn, w, []string{"秒数分位", "样本数"}, `
SELECT (percentile_disc(ARRAY[0.5,0.9,0.99,1.0]) WITHIN GROUP (ORDER BY extract(epoch FROM ct.ts - cl.ts)))::text, count(*)
FROM call_traces ct JOIN call_logs cl USING (request_id)
WHERE cl.ts >= $1 AND cl.ts < $2`, from, to)

	section(w, "11. 两处内容是否重复保存")
	table(ctx, conn, w, []string{"两表都有 request_body", "内容完全相同"}, `
SELECT count(*), count(*) FILTER (WHERE ct.request_body = cl.request_body)
FROM call_traces ct JOIN call_logs cl USING (request_id)
WHERE cl.ts >= $1 AND cl.ts < $2 AND ct.request_body IS NOT NULL AND cl.request_body IS NOT NULL`, from, to)

	section(w, "12. 保留期：库中最早的调用记录与最早仍有内容的记录")
	table(ctx, conn, w, []string{"最早 ts"}, `SELECT min(ts)::text FROM call_logs`)
	table(ctx, conn, w, []string{"最早有 request_body 的 ts"}, `SELECT ts::text FROM call_logs WHERE request_body IS NOT NULL ORDER BY ts LIMIT 1`)

	section(w, "13. api_keys 哈希格式（判断能否确认本网关 Key）")
	table(ctx, conn, w, []string{"key_hash 长度", "是否 64 位十六进制", "Key 数"}, `
SELECT length(key_hash), (key_hash ~ '^[0-9a-f]{64}$')::text, count(*) FROM api_keys GROUP BY 1,2 ORDER BY 3 DESC`)
}

func section(w io.Writer, title string) {
	fmt.Fprintf(w, "\n## %s\n\n", title)
}

func table(ctx context.Context, conn *pgx.Conn, w io.Writer, headers []string, sql string, args ...any) {
	rows, err := conn.Query(ctx, sql, args...)
	if err != nil {
		fmt.Fprintf(w, "> 查询失败：%v\n", err)
		return
	}
	defer rows.Close()
	fmt.Fprintf(w, "| %s |\n|%s\n", strings.Join(headers, " | "), strings.Repeat(" --- |", len(headers)))
	n := 0
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			fmt.Fprintf(w, "> 读取失败：%v\n", err)
			return
		}
		cells := make([]string, len(vals))
		for i, v := range vals {
			if v == nil {
				cells[i] = "—"
				continue
			}
			cells[i] = strings.ReplaceAll(fmt.Sprint(v), "|", "\\|")
		}
		fmt.Fprintf(w, "| %s |\n", strings.Join(cells, " | "))
		n++
	}
	if err := rows.Err(); err != nil {
		fmt.Fprintf(w, "> 查询失败：%v\n", err)
		return
	}
	if n == 0 {
		fmt.Fprintln(w, "| （无数据） |")
	}
}
