// Package output 负责独立存储：CSV 明细、覆盖统计、断点和汇总报告。
//
// 输出目录和文件权限分别为 0700 / 0600。输出里包含员工姓名和脱敏片段，
// 本身就是敏感数据，不得提交到代码仓库或共享盘。
package output

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"leakscan/internal/detect"
	"leakscan/internal/rules"
)

const (
	HitsFile       = "hits.csv"
	FindingsFile   = "findings.csv"
	CoverageFile   = "coverage.json"
	CheckpointFile = "checkpoint.json"
	SummaryFile    = "summary.md"
)

// HitsHeader 是命中明细的列。每行 = 一条记录 × 一个凭证指纹。
// source_path 是端上产品追加的最后一列（凭证所属文件，ECAP-011）；
// 网关侧该列恒为空。追加在末尾以保证既有列位不变。
var HitsHeader = []string{
	"table", "request_id", "call_ts", "user_id", "user_name", "dept_id", "dept_name",
	"key_id", "key_name", "key_type", "model", "user_agent", "ip",
	"rule_id", "type_name", "tier", "severity", "confidence", "roles", "occurrences",
	"fingerprint", "masked", "note", "gateway_key", "ruleset_version",
	"source_path",
}

// EnsureDir 创建仅本人可读写的输出目录。
func EnsureDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.Chmod(dir, 0o700)
}

// HitWriter 追加写命中明细。
type HitWriter struct {
	f *os.File
	w *csv.Writer
}

// OpenHits 打开命中明细文件；resume 时追加，否则新建并写表头。
func OpenHits(dir string, resume bool) (*HitWriter, error) {
	path := filepath.Join(dir, HitsFile)
	flag := os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	_, statErr := os.Stat(path)
	appendMode := resume && statErr == nil
	if appendMode {
		flag = os.O_WRONLY | os.O_APPEND
	}
	f, err := os.OpenFile(path, flag, 0o600)
	if err != nil {
		return nil, err
	}
	hw := &HitWriter{f: f, w: csv.NewWriter(f)}
	if !appendMode {
		// UTF-8 BOM，便于 Excel 正确显示中文
		if _, err := f.WriteString("\xef\xbb\xbf"); err != nil {
			return nil, err
		}
		if err := hw.w.Write(HitsHeader); err != nil {
			return nil, err
		}
	}
	return hw, nil
}

// Write 写入一条记录的全部命中。
func (hw *HitWriter) Write(o detect.Outcome) error {
	r := o.Record
	for _, h := range o.Hits {
		row := []string{
			r.Table, r.RequestID, r.CallTS.Format(time.RFC3339), r.UserID, r.UserName, r.DeptID, r.DeptName,
			r.KeyID, r.KeyName, r.KeyType, r.Model, r.UserAgent, r.IP,
			h.RuleID, h.TypeName, strconv.Itoa(h.Tier), h.Severity, h.Confidence, strings.Join(h.Roles, ";"), strconv.Itoa(h.Occurrences),
			h.Fingerprint, h.Masked, h.Note, h.GatewayKey, rules.Version,
			r.SourcePath,
		}
		if err := hw.w.Write(sanitize(row)); err != nil {
			return err
		}
	}
	return nil
}

// Flush 落盘。每批处理完再写断点，保证断点之前的命中都已写入。
func (hw *HitWriter) Flush() error {
	hw.w.Flush()
	if err := hw.w.Error(); err != nil {
		return err
	}
	return hw.f.Sync()
}

// Close 关闭文件。
func (hw *HitWriter) Close() error {
	hw.w.Flush()
	return hw.f.Close()
}

// sanitize 防止 CSV 公式注入（员工姓名、UA 等字段可能以 = + - @ 开头）。
func sanitize(row []string) []string {
	for i, c := range row {
		if c != "" && strings.ContainsRune("=+-@\t\r", rune(c[0])) {
			row[i] = "'" + c
		}
	}
	return row
}

// Coverage 是单表覆盖统计。
type Coverage struct {
	Rows              int64 `json:"rows"`
	WithRequestBody   int64 `json:"with_request_body"`
	WithResponseBody  int64 `json:"with_response_body"`
	WithHeaders       int64 `json:"with_headers"`
	NoContent         int64 `json:"no_content"`
	NoContentLogOff   int64 `json:"no_content_log_disabled"`
	NoContentUnknown  int64 `json:"no_content_other"`
	RequestParseFail  int64 `json:"request_parse_failed"`
	ResponseParseFail int64 `json:"response_parse_failed"`
	Oversize          int64 `json:"oversize_skipped"`
	RecordsWithHits   int64 `json:"records_with_hits"`
	AuthHeader        int64 `json:"auth_header_present"`
	AuthUnmasked      int64 `json:"auth_header_unmasked"`

	// 以下为端上产品（ECAP-006）的缺口分类计数，网关侧恒为 0。
	// 端上报告只渲染这些字段，网关专有的字段靠 Profile.CoverageGapLabels 隐藏。
	AgentUnsupported int64 `json:"agent_unsupported"` // agent 不在支持列表
	ParseFailed      int64 `json:"parse_failed"`      // 会话行格式无法解析
	FileVanished     int64 `json:"file_vanished"`     // 读取时文件已消失
}

// Add 累加一条记录。
func (c *Coverage) Add(o detect.Outcome) {
	s := o.Stats
	c.Rows++
	if s.HasRequestBody {
		c.WithRequestBody++
	}
	if s.HasResponseBody {
		c.WithResponseBody++
	}
	if s.HasHeaders {
		c.WithHeaders++
	}
	if s.NoContent {
		c.NoContent++
		if o.Record.LogEnabled != nil && !*o.Record.LogEnabled {
			c.NoContentLogOff++
		} else {
			c.NoContentUnknown++
		}
	}
	if s.RequestParseFail {
		c.RequestParseFail++
	}
	if s.ResponseParseFail {
		c.ResponseParseFail++
	}
	if s.Oversize {
		c.Oversize++
	}
	if len(o.Hits) > 0 {
		c.RecordsWithHits++
	}
	if s.AuthHeader {
		c.AuthHeader++
	}
	if s.AuthUnmasked {
		c.AuthUnmasked++
	}
}

// RunState 是一次扫描的元数据、断点和覆盖统计，每批落盘一次。
type RunState struct {
	RulesetVersion string               `json:"ruleset_version"`
	Source         string               `json:"source,omitempty"` // 文件扫描时的输入文件名；数据库扫描为空
	From           time.Time            `json:"from"`
	To             time.Time            `json:"to"`
	Tables         []string             `json:"tables"`
	StartedAt      time.Time            `json:"started_at"`
	UpdatedAt      time.Time            `json:"updated_at"`
	FinishedAt     *time.Time           `json:"finished_at,omitempty"`
	Cursors        map[string]Cursor    `json:"cursors"`
	Done           map[string]bool      `json:"done"`
	Coverage       map[string]*Coverage `json:"coverage"`
	Errors         []string             `json:"errors,omitempty"`
}

// Cursor 与 store.Cursor 相同结构，避免包循环依赖。
type Cursor struct {
	TS        time.Time `json:"ts"`
	RequestID string    `json:"request_id"`
}

// SaveState 原子写入状态文件。
func SaveState(dir string, st *RunState) error {
	st.UpdatedAt = time.Now()
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, CheckpointFile+".tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, CheckpointFile))
}

// LoadState 读取状态文件。
func LoadState(dir string) (*RunState, error) {
	b, err := os.ReadFile(filepath.Join(dir, CheckpointFile))
	if err != nil {
		return nil, err
	}
	var st RunState
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, fmt.Errorf("解析断点文件：%w", err)
	}
	return &st, nil
}

// WriteCoverage 单独写一份覆盖统计，便于其他工具读取。
func WriteCoverage(dir string, st *RunState) error {
	b, err := json.MarshalIndent(st.Coverage, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, CoverageFile), b, 0o600)
}
