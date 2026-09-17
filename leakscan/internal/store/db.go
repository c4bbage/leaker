// Package store 只读访问网关数据库。
//
// 防护措施不依赖"代码里没写 UPDATE"：连接级强制只读事务、语句超时、空闲事务超时，
// 按时间窗口 + (ts, request_id) 键集分页，每批条数有限，批间可休眠让路。
package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"leakscan/internal/detect"
)

// Options 是连接参数。
type Options struct {
	DSN              string
	StatementTimeout time.Duration
}

// Connect 建立只读会话，并确认会话确实处于只读模式。
func Connect(ctx context.Context, o Options) (*pgx.Conn, error) {
	cfg, err := pgx.ParseConfig(o.DSN)
	if err != nil {
		return nil, fmt.Errorf("解析 DSN：%w", err)
	}
	if cfg.RuntimeParams == nil {
		cfg.RuntimeParams = map[string]string{}
	}
	cfg.RuntimeParams["default_transaction_read_only"] = "on"
	cfg.RuntimeParams["statement_timeout"] = strconv.FormatInt(o.StatementTimeout.Milliseconds(), 10)
	cfg.RuntimeParams["idle_in_transaction_session_timeout"] = "60000"
	cfg.RuntimeParams["application_name"] = "leakscan"
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("连接数据库：%w", err)
	}
	var ro string
	if err := conn.QueryRow(ctx, "SHOW default_transaction_read_only").Scan(&ro); err != nil {
		conn.Close(ctx)
		return nil, fmt.Errorf("确认只读模式：%w", err)
	}
	if ro != "on" {
		conn.Close(ctx)
		return nil, errors.New("会话未处于只读模式，已中止")
	}
	return conn, nil
}

// Cursor 是键集分页位置。
type Cursor struct {
	TS        time.Time `json:"ts"`
	RequestID string    `json:"request_id"`
}

// Tables 是支持扫描的表。
var Tables = map[string]bool{"call_logs": true, "call_traces": true}

const callLogsSQL = `
SELECT cl.request_id, cl.ts,
       coalesce(cl.key_id,''), coalesce(cl.user_id,''), coalesce(cl.user_name,''),
       coalesce(cl.dept_id,''), coalesce(cl.dept_name,''), coalesce(cl.key_name,''),
       coalesce(cl.key_type,''), coalesce(cl.model,''), coalesce(cl.user_agent,''), coalesce(cl.ip_address,''),
       CASE WHEN pg_column_size(cl.request_body)  <= $6 THEN cl.request_body::text  END,
       CASE WHEN pg_column_size(cl.response_body) <= $6 THEN cl.response_body::text END,
       coalesce(pg_column_size(cl.request_body), 0)  > $6,
       coalesce(pg_column_size(cl.response_body), 0) > $6,
       NULL::text,
       cl.ts
FROM call_logs cl
WHERE cl.ts >= $1 AND cl.ts < $2
  AND cl.ts >= $3 AND (cl.ts, cl.request_id) > ($3, $4)
ORDER BY cl.ts, cl.request_id
LIMIT $5`

// call_traces 没有调用人信息，关联 call_logs 取归属。call_traces.ts 默认取写入时刻，
// 与 call_logs.ts 口径可能不同，报告中注明。
const callTracesSQL = `
SELECT ct.request_id, coalesce(cl.ts, ct.ts),
       coalesce(cl.key_id,''), coalesce(cl.user_id,''), coalesce(cl.user_name,''),
       coalesce(cl.dept_id,''), coalesce(cl.dept_name,''), coalesce(cl.key_name,''),
       coalesce(cl.key_type,''), coalesce(cl.model,''), coalesce(cl.user_agent,''), coalesce(cl.ip_address,''),
       CASE WHEN pg_column_size(ct.request_body)  <= $6 THEN ct.request_body::text  END,
       CASE WHEN pg_column_size(ct.response_body) <= $6 THEN ct.response_body::text END,
       coalesce(pg_column_size(ct.request_body), 0)  > $6,
       coalesce(pg_column_size(ct.response_body), 0) > $6,
       CASE WHEN pg_column_size(ct.request_headers) <= $6 THEN ct.request_headers::text END,
       ct.ts
FROM call_traces ct
LEFT JOIN call_logs cl ON cl.request_id = ct.request_id
WHERE ct.ts >= $1 AND ct.ts < $2
  AND ct.ts >= $3 AND (ct.ts, ct.request_id) > ($3, $4)
ORDER BY ct.ts, ct.request_id
LIMIT $5`

// FetchBatch 读取一批记录，返回记录和下一页游标（按表自身的 ts 推进）。
func FetchBatch(ctx context.Context, conn *pgx.Conn, table string, from, to time.Time, cur Cursor, limit int, maxBody int, keys map[string]KeyInfo) ([]detect.Record, Cursor, error) {
	q := callLogsSQL
	if table == "call_traces" {
		q = callTracesSQL
	}
	// 最后一列是表自身的 ts，用作分页游标；call_traces 的第二列是归属到调用的时间。
	rows, err := conn.Query(ctx, q, from, to, cur.TS, cur.RequestID, limit, maxBody)
	if err != nil {
		return nil, cur, err
	}
	defer rows.Close()
	var out []detect.Record
	next := cur
	for rows.Next() {
		var (
			r                 detect.Record
			req, resp, hdr    *string
			reqOver, respOver bool
			ownTS             time.Time
		)
		if err := rows.Scan(&r.RequestID, &r.CallTS, &r.KeyID, &r.UserID, &r.UserName, &r.DeptID, &r.DeptName,
			&r.KeyName, &r.KeyType, &r.Model, &r.UserAgent, &r.IP, &req, &resp, &reqOver, &respOver, &hdr, &ownTS); err != nil {
			return nil, cur, err
		}
		r.Table = table
		if req != nil {
			r.RequestBody = []byte(*req)
		}
		if resp != nil {
			r.ResponseBody = []byte(*resp)
		}
		if hdr != nil {
			r.RequestHeaders = []byte(*hdr)
		}
		r.HasHeaderCol = table == "call_traces"
		r.RequestOversize, r.ResponseOversize = reqOver, respOver
		if ki, ok := keys[r.KeyID]; ok {
			r.LogEnabled = new(ki.LogEnabled)
		}
		out = append(out, r)
		next = Cursor{TS: ownTS, RequestID: r.RequestID}
	}
	return out, next, rows.Err()
}

// KeyInfo 是 api_keys 中确认与覆盖统计所需的字段。
type KeyInfo struct {
	ID         string
	UserID     string
	Name       string
	Hash       string
	Enabled    bool
	LogEnabled bool
}

// LoadKeys 读取 api_keys（只取哈希，不取加密后的 Key）。
func LoadKeys(ctx context.Context, conn *pgx.Conn) (map[string]KeyInfo, error) {
	rows, err := conn.Query(ctx, `SELECT id::text, user_id::text, name, key_hash, enabled, log_enabled FROM api_keys`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]KeyInfo{}
	for rows.Next() {
		var k KeyInfo
		if err := rows.Scan(&k.ID, &k.UserID, &k.Name, &k.Hash, &k.Enabled, &k.LogEnabled); err != nil {
			return nil, err
		}
		out[k.ID] = k
	}
	return out, rows.Err()
}
