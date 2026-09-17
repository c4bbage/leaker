package output

import (
	"encoding/csv"
	"os"
	"path/filepath"
	"strconv"
)

const BehaviorFile = "behavior.csv"

// BehaviorHeader 是行为命中的列。与 hits.csv 分开：行为命中没有凭证值、
// 没有指纹、没有脱敏片段（detect.Hit 的三个核心字段正是这三样），
// 塞进 hits.csv 要么给 Hit 加可空语义（污染禁改包），要么写一堆空列。
var BehaviorHeader = []string{
	"agent", "session_id", "source_file", "line", "ts",
	"rule_id", "rule_name", "severity", "tool", "field", "excerpt",
}

// BehaviorWriter 追加写行为命中明细。
type BehaviorWriter struct {
	f *os.File
	w *csv.Writer
}

// OpenBehavior 打开行为明细文件；resume 时追加，否则新建并写表头。
func OpenBehavior(dir string, resume bool) (*BehaviorWriter, error) {
	path := filepath.Join(dir, BehaviorFile)
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
	bw := &BehaviorWriter{f: f, w: csv.NewWriter(f)}
	if !appendMode {
		// UTF-8 BOM，便于 Excel 正确显示中文
		if _, err := f.WriteString("\xef\xbb\xbf"); err != nil {
			return nil, err
		}
		if err := bw.w.Write(BehaviorHeader); err != nil {
			return nil, err
		}
	}
	return bw, nil
}

// BehaviorRow 是一条待写盘的行为命中。
type BehaviorRow struct {
	Agent      string
	SessionID  string
	SourceFile string // 会话文件相对路径
	Line       int
	TS         string // RFC3339，无时间戳时为空
	RuleID     string
	RuleName   string
	Severity   string
	Tool       string
	Field      string
	Excerpt    string
}

// Write 追加一条行为命中。
func (bw *BehaviorWriter) Write(r BehaviorRow) error {
	return bw.w.Write(sanitize([]string{
		r.Agent, r.SessionID, r.SourceFile, strconv.Itoa(r.Line), r.TS,
		r.RuleID, r.RuleName, r.Severity, r.Tool, r.Field, r.Excerpt,
	}))
}

// Flush 落盘。
func (bw *BehaviorWriter) Flush() error {
	bw.w.Flush()
	if err := bw.w.Error(); err != nil {
		return err
	}
	return bw.f.Sync()
}

// Close 关闭文件。
func (bw *BehaviorWriter) Close() error {
	bw.w.Flush()
	return bw.f.Close()
}
