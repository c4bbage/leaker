// Package endpoint 把编码 agent 落盘的会话产物转换成 detect.Record，
// 复用与网关扫描完全相同的识别规则（端上产品 ECAP-002、EBR-006）。
//
// 本包只读，绝不修改、移动或删除任何 agent 的会话文件（EBR-007）。
package endpoint

import (
	"bufio"
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"leakscan/internal/behavior"
	"leakscan/internal/detect"
)

// Agent 标识来源工具，写入明细的 table 列。
const AgentClaude = "claude"

// Session 是一个待扫描的会话产物。
type Session struct {
	Agent   string    // 来源 agent
	Path    string    // 会话文件绝对路径
	Rel     string    // 相对 root 的路径，用于报告展示
	Size    int64     //
	ModTime time.Time //
}

// Skip 记录一个没能扫描的对象及原因，用于覆盖缺口（ECAP-006）。
// "扫不到"必须可解释，不能静默丢弃（EBR-009）。
type Skip struct {
	Path   string
	Reason string
}

// ClaudeRoot 返回 Claude Code 的会话产物根目录。
// macOS / Linux 为 ~/.claude/projects；Windows 上 os.UserHomeDir 返回
// %USERPROFILE%，同样拼出 .claude\projects（端上产品 EQ-002：Windows 路径尚未实测）。
func ClaudeRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "projects"), nil
}

// DiscoverClaude 列出根目录下的会话文件（ECAP-001）。
// 只按 modtime 做窗口初筛：文件内每条记录还会按各自的 timestamp 精确过滤，
// 因为一个会话文件可能横跨窗口边界。
func DiscoverClaude(root string, from, to time.Time) ([]Session, []Skip, error) {
	var out []Session
	var skips []Skip
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			skips = append(skips, Skip{Path: p, Reason: "目录读取失败：" + err.Error()})
			return nil //nolint:nilerr // 单个目录不可读不应中断整次扫描
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			skips = append(skips, Skip{Path: p, Reason: "取文件信息失败：" + err.Error()})
			return nil
		}
		// modtime 早于窗口起点的整个文件都不可能有窗口内记录；
		// 晚于终点的仍要读，因为文件会被持续追加。
		if !from.IsZero() && info.ModTime().Before(from) {
			skips = append(skips, Skip{Path: p, Reason: "窗口外（文件最后修改早于 -from）"})
			return nil
		}
		rel, relErr := filepath.Rel(root, p)
		if relErr != nil {
			rel = p
		}
		out = append(out, Session{Agent: AgentClaude, Path: p, Rel: rel, Size: info.Size(), ModTime: info.ModTime()})
		return nil
	})
	if err != nil {
		return nil, skips, err
	}
	slices.SortFunc(out, func(a, b Session) int {
		if n := a.ModTime.Compare(b.ModTime); n != 0 {
			return n
		}
		return cmp.Compare(a.Rel, b.Rel)
	})
	return out, skips, nil
}

// claudeLine 是 transcript 每行的公共外层结构。只声明用得到的字段，
// 未知字段由 json 忽略——Claude Code 会随版本增删字段，不能因此解析失败。
type claudeLine struct {
	Type      string          `json:"type"`
	UUID      string          `json:"uuid"`
	SessionID string          `json:"sessionId"`
	Timestamp string          `json:"timestamp"`
	CWD       string          `json:"cwd"`
	Version   string          `json:"version"`
	GitBranch string          `json:"gitBranch"`
	Sidechain bool            `json:"isSidechain"`
	Message   json.RawMessage `json:"message"`
	// toolUseResult 是顶层字段，不在 message 里。agent 读文件、执行命令的
	// 结果落在这里，是端上凭证检测最关键的位置（ESCN-001）。
	ToolUseResult json.RawMessage `json:"toolUseResult"`
	Attachment    json.RawMessage `json:"attachment"`
}

// toolResultEnvelope 把 toolUseResult 包成 extract 能识别角色的形状。
// extract.roleOf 把 role=="tool" 映射为 RoleToolResult，因此不需要改动
// extract 包就能让这部分内容带上正确的来源角色。
type toolResultEnvelope struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type messagesEnvelope struct {
	Messages []json.RawMessage `json:"messages"`
}

// ToolEvent 是一次工具调用及其在会话文件中的坐标，供行为引擎（ECAP-008）
// 与 behavior.csv 的定位列使用。Event 之外的字段不属于行为引擎的输入，
// 单独携带，避免 behavior.Event 混入产物无关的元数据。
type ToolEvent struct {
	SessionID  string
	SourceFile string // 会话文件相对路径
	Line       int
	TS         time.Time
	Event      behavior.Event
}

// toolUseBlock 是 assistant message 里 content 数组的 tool_use 块。
type toolUseBlock struct {
	Type  string          `json:"type"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// inputFields 把 tool_use 的 input 对象摊平成 string→string。
// 值不是字符串时（对象/数组/数字）转为 JSON 文本——行为规则只做
// 字符串匹配，文本化不损失信息；input 缺失或非对象时返回空 map。
func inputFields(raw json.RawMessage) map[string]string {
	out := map[string]string{}
	if len(raw) == 0 {
		return out
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return out
	}
	for k, v := range obj {
		var s string
		if err := json.Unmarshal(v, &s); err == nil {
			out[k] = s
			continue
		}
		out[k] = string(v)
	}
	return out
}

// ParseSession 逐行解析一个 Claude Code 会话文件，产出 detect.Record 与
// behavior.Event（ECAP-008）。
//
// 角色映射（依赖 extract 既有的 roleOf/childRole，不另立词汇）：
//   - type=user      → message 进请求体，内含的 tool_result 块由 extract 识别
//   - type=assistant → message 进响应体，得到 model_output
//   - toolUseResult  → 包成 {"role":"tool",...} 进请求体，得到 tool_result
//   - type=attachment→ 原样进请求体，走通用遍历（request_other），不猜角色
//
// 超过 maxLine 的行计入 Skip 而不是静默丢弃。返回的 skips 进入覆盖缺口。
// events 含所有能归一化出工具调用事件的行（assistant 的 tool_use 块、
// user 的 toolUseResult），即使该行不产生凭证检测记录。
func ParseSession(s Session, from, to time.Time, maxLine int) ([]detect.Record, []ToolEvent, []Skip, error) {
	f, err := os.Open(s.Path)
	if err != nil {
		return nil, nil, []Skip{{Path: s.Path, Reason: "打开失败：" + err.Error()}}, nil //nolint:nilerr
	}
	defer f.Close()

	var recs []detect.Record
	var events []ToolEvent
	var skips []Skip
	br := bufio.NewReaderSize(f, 1<<20)
	lineNo := 0
	for {
		b, tooLong, err := readLine(br, maxLine)
		if len(b) > 0 || tooLong {
			lineNo++
			if tooLong {
				skips = append(skips, Skip{
					Path:   fmt.Sprintf("%s:%d", s.Rel, lineNo),
					Reason: fmt.Sprintf("单行超过上限 %d 字节，未扫描", maxLine),
				})
			} else if rec, ev, ok, perr := recordFromLine(s, b, lineNo, from, to); perr != nil {
				skips = append(skips, Skip{Path: fmt.Sprintf("%s:%d", s.Rel, lineNo), Reason: perr.Error()})
			} else {
				if ok {
					recs = append(recs, rec)
				}
				if ev != nil {
					events = append(events, *ev)
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return recs, events, skips, nil
			}
			skips = append(skips, Skip{
				Path:   fmt.Sprintf("%s:%d", s.Rel, lineNo),
				Reason: "读取出错，该行之后未扫描：" + err.Error(),
			})
			return recs, events, skips, nil
		}
	}
}

// extractFilePath 从 toolUseResult 中取出凭证原本所属的文件路径（ECAP-011）。
// 按已实测的四种形态依次尝试：
//
//	{file:{filePath, content}, type}                          Read
//	{content, filePath, originalFile, structuredPatch, type}  Edit/Write
//	{stdout, stderr, interrupted, ...}                        Bash（无路径，返回空）
//	"<字符串>"                                                  字符串结果（无路径，返回空）
//
// 绝不猜测：拿不到就是空字符串（ECAP-011 明确要求不得猜测成会话路径）。
func extractFilePath(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	// 对象形态：先试 file.filePath（Read），再试顶层 filePath（Edit/Write）。
	// 字符串形态 Unmarshal 会失败，Bash 形态字段为空，两种情况都返回空。
	var withFile struct {
		File struct {
			FilePath string `json:"filePath"`
		} `json:"file"`
		FilePath string `json:"filePath"`
	}
	if err := json.Unmarshal(raw, &withFile); err == nil {
		if p := withFile.File.FilePath; p != "" {
			return p
		}
		if p := withFile.FilePath; p != "" {
			return p
		}
	}
	return ""
}

func recordFromLine(s Session, b []byte, lineNo int, from, to time.Time) (detect.Record, *ToolEvent, bool, error) {
	if len(bytes.TrimSpace(b)) == 0 {
		return detect.Record{}, nil, false, nil
	}
	var l claudeLine
	if err := json.Unmarshal(b, &l); err != nil {
		return detect.Record{}, nil, false, fmt.Errorf("不是合法 JSON：%v", err)
	}

	var ts time.Time
	if l.Timestamp != "" {
		if t, err := time.Parse(time.RFC3339Nano, l.Timestamp); err == nil {
			ts = t
		}
	}
	// 窗口按每条记录的时间过滤；无时间戳的记录保留，避免漏检。
	if !ts.IsZero() {
		if !from.IsZero() && ts.Before(from) {
			return detect.Record{}, nil, false, nil
		}
		if !to.IsZero() && !ts.Before(to) {
			return detect.Record{}, nil, false, nil
		}
	}

	rec := detect.Record{
		Table:     s.Agent,
		RequestID: fmt.Sprintf("%s:%d", s.Rel, lineNo),
		CallTS:    ts,
		// 列语义按端上重新映射，见 cmd/leakagent 的说明。
		KeyID:     l.SessionID,
		KeyName:   s.Rel,
		UserName:  l.CWD,
		Model:     l.GitBranch,
		UserAgent: l.Version,
	}
	if l.Sidechain {
		rec.KeyType = "sidechain" // 子 agent 会话，整改对象不同
	}

	var reqParts []json.RawMessage
	var ev *ToolEvent
	switch l.Type {
	case "user":
		if len(l.Message) > 0 {
			reqParts = append(reqParts, l.Message)
		}
	case "assistant":
		if len(l.Message) > 0 {
			rec.ResponseBody = l.Message
			// assistant 记录的 tool_use 块 = agent 发起的工具调用（ECAP-008 的事件源）。
			var msg struct {
				Content []toolUseBlock `json:"content"`
			}
			if err := json.Unmarshal(l.Message, &msg); err == nil {
				for _, blk := range msg.Content {
					if blk.Type != "tool_use" || blk.Name == "" {
						continue
					}
					// 同一行多个 tool_use 块各自成事件；事件没有独立行号，
					// 共用本行的坐标（behavior.csv 的 line 列语义 = transcript 行）。
					ev = &ToolEvent{
						SessionID:  l.SessionID,
						SourceFile: s.Rel,
						Line:       lineNo,
						TS:         ts,
						Event:      behavior.Event{Tool: blk.Name, Fields: inputFields(blk.Input)},
					}
				}
			}
		}
	case "attachment":
		if len(l.Attachment) > 0 {
			reqParts = append(reqParts, l.Attachment)
		}
	default:
		// system / queue-operation 等：没有 message 的类型不产生记录，
		// 但若将来新增带内容的类型，下面的 toolUseResult 仍会被扫到。
	}

	if len(l.ToolUseResult) > 0 && !bytes.Equal(bytes.TrimSpace(l.ToolUseResult), []byte("null")) {
		// ECAP-011：工具结果里携带的文件路径 = 凭证原本所属位置的候选。
		// Read/Edit/Write 结果中的 filePath 直接说明该条记录的内容来自哪个文件。
		rec.SourcePath = extractFilePath(l.ToolUseResult)

		env, err := json.Marshal(toolResultEnvelope{Role: "tool", Content: l.ToolUseResult})
		if err == nil {
			reqParts = append(reqParts, env)
		}
	}

	if len(reqParts) > 0 {
		body, err := json.Marshal(messagesEnvelope{Messages: reqParts})
		if err != nil {
			return detect.Record{}, ev, false, fmt.Errorf("重新编码失败：%v", err)
		}
		rec.RequestBody = body
	}
	if len(rec.RequestBody) == 0 && len(rec.ResponseBody) == 0 {
		return detect.Record{}, ev, false, nil
	}
	return rec, ev, true, nil
}

// readLine 读取一行；超过 limit 的行被丢弃并标记 tooLong，不会把超大行读进内存。
func readLine(br *bufio.Reader, limit int) (line []byte, tooLong bool, err error) {
	var buf []byte
	for {
		chunk, e := br.ReadSlice('\n')
		if len(buf)+len(chunk) > limit {
			tooLong = true
			buf = nil
		}
		if !tooLong {
			buf = append(buf, chunk...)
		}
		if e == nil {
			return bytes.TrimRight(buf, "\r\n"), tooLong, nil
		}
		if errors.Is(e, bufio.ErrBufferFull) {
			continue
		}
		return bytes.TrimRight(buf, "\r\n"), tooLong, e
	}
}
