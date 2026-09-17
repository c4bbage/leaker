// Codex CLI 适配器（WI-5）。
//
// 已实测形态（2026-09-15，~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl，
// cli_version 0.53.0）：
//
//	{"timestamp":"...","type":"...","payload":{...}}
//	  type=session_meta   → payload 含 id/timestamp/cwd/originator/cli_version/model_provider
//	  type=response_item  → payload.type ∈ message|reasoning|function_call|function_call_output|
//	                        custom_tool_call|custom_tool_call_output
//	  type=event_msg      → payload.type ∈ user_message|agent_message|agent_reasoning|token_count
//	  type=turn_context   → payload 含 cwd/model 等（每轮重复）
//
// event_msg 与 response_item 内容重复（已用 md5 配对核实：user_message ↔
// response_item/message(role=user)、agent_message ↔ message(role=assistant)、
// agent_reasoning ↔ reasoning(summary)，同一会话内重复组 173 个）。因此
// 本适配器只取 response_item，完全跳过 event_msg，否则同一凭证计两次。
// token_count 等纯统计事件两边都不含用户内容，同样跳过。
//
// function_call_output 的 output 实测有两种值：JSON 字符串
// {"output":...,"metadata":...}（shell 工具）与纯字符串（"Plan updated"，
// plan 工具）。两种都按字符串内容处理；custom_tool_call_output 同形。
//
// 复用 extract.Request 解析 OpenAI Responses 形状（payload 原样作为
// 请求体交给它），不自行拆字段。角色映射依赖 extract 既有词汇：
// function_call_output/custom_tool_call_output 内容 → tool_result。
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

// AgentCodex 标识 Codex CLI 来源。
const AgentCodex = "codex"

// CodexRoot 返回 Codex CLI 的会话产物根目录。
func CodexRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".codex", "sessions"), nil
}

// codexLine 是 rollout 文件每行的公共外层结构。
type codexLine struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

// codexMeta 是 session_meta 的 payload（整个文件的归属信息）。
type codexMeta struct {
	ID         string `json:"id"`
	CWD        string `json:"cwd"`
	Originator string `json:"originator"`
	CLIVersion string `json:"cli_version"`
}

// codexItem 是 response_item 的 payload 外层。content/arguments/output
// 的内层结构由各分支自行解析。
type codexItem struct {
	Type      string          `json:"type"`
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	Name      string          `json:"name"`      // function_call / custom_tool_call
	Arguments json.RawMessage `json:"arguments"` // function_call：JSON 字符串
	Input     json.RawMessage `json:"input"`     // custom_tool_call：工具输入文本
	Output    json.RawMessage `json:"output"`    // function_call_output / custom_tool_call_output
}

// DiscoverCodex 列出 Codex 会话文件（ECAP-001）。目录结构 YYYY/MM/DD
// 自带时间信息，按 modtime 初筛与 Claude 相同：早于窗口起点的文件跳过。
func DiscoverCodex(root string, from, to time.Time) ([]Session, []Skip, error) {
	var out []Session
	var skips []Skip
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			skips = append(skips, Skip{Path: p, Reason: "目录读取失败：" + err.Error()})
			return nil //nolint:nilerr
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			skips = append(skips, Skip{Path: p, Reason: "取文件信息失败：" + err.Error()})
			return nil
		}
		if !from.IsZero() && info.ModTime().Before(from) {
			skips = append(skips, Skip{Path: p, Reason: "窗口外（文件最后修改早于 -from）"})
			return nil
		}
		rel, relErr := filepath.Rel(root, p)
		if relErr != nil {
			rel = p
		}
		out = append(out, Session{Agent: AgentCodex, Path: p, Rel: rel, Size: info.Size(), ModTime: info.ModTime()})
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

// codexMsgContent 是 response_item/message 的 content 数组元素。
type codexMsgContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// ParseCodexSession 逐行解析一个 Codex 会话文件。
//
// 角色映射（复用 extract 既有 roleOf 词汇，不另立）：
//   - response_item/message: role=user     → 请求体（含 input_text 的用户输入）
//   - response_item/message: role=assistant → 响应体（model_output）
//   - response_item/reasoning               → 响应体（model_reasoning，由 extract 识别）
//   - function_call / custom_tool_call      → 请求体（tool_call 角色：工具调用参数）
//   - *_call_output                         → 请求体（tool_result 角色：工具结果）
//
// cwd 取自 session_meta（文件开头声明一次）；行时间戳做窗口过滤。
func ParseCodexSession(s Session, from, to time.Time, maxLine int) ([]detect.Record, []ToolEvent, []Skip, error) {
	f, err := os.Open(s.Path)
	if err != nil {
		return nil, nil, []Skip{{Path: s.Path, Reason: "打开失败：" + err.Error()}}, nil //nolint:nilerr
	}
	defer f.Close()

	var recs []detect.Record
	var events []ToolEvent
	var skips []Skip
	cwd := ""     // session_meta 的 cwd，整个文件的归属信息
	version := "" // cli_version
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
			} else if rec, ev, ok, perr := codexRecordFromLine(s, b, lineNo, from, to, &cwd, &version); perr != nil {
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

// codexRecordFromLine 处理一行。cwd/version 为可变状态（session_meta 先行声明）。
func codexRecordFromLine(s Session, b []byte, lineNo int, from, to time.Time, cwd, version *string) (detect.Record, *ToolEvent, bool, error) {
	if len(bytes.TrimSpace(b)) == 0 {
		return detect.Record{}, nil, false, nil
	}
	var l codexLine
	if err := json.Unmarshal(b, &l); err != nil {
		return detect.Record{}, nil, false, fmt.Errorf("不是合法 JSON：%v", err)
	}

	var ts time.Time
	if l.Timestamp != "" {
		if t, err := time.Parse(time.RFC3339Nano, l.Timestamp); err == nil {
			ts = t
		}
	}
	if !ts.IsZero() {
		if !from.IsZero() && ts.Before(from) {
			return detect.Record{}, nil, false, nil
		}
		if !to.IsZero() && !ts.Before(to) {
			return detect.Record{}, nil, false, nil
		}
	}

	switch l.Type {
	case "session_meta":
		var m codexMeta
		if err := json.Unmarshal(l.Payload, &m); err == nil {
			if m.CWD != "" {
				*cwd = m.CWD
			}
			if m.CLIVersion != "" {
				*version = m.CLIVersion
			}
		}
		return detect.Record{}, nil, false, nil // 元数据行不产生记录
	case "event_msg", "turn_context":
		// event_msg 与 response_item 内容重复（见包注释），只取 response_item；
		// turn_context 是每轮的环境快照，不含新内容。
		return detect.Record{}, nil, false, nil
	case "response_item":
		// 继续走下面的通用处理
	default:
		// 未知类型：跳过但不报错。Codex 会随版本增删类型，
		// 不能因此让整个文件解析失败。
		return detect.Record{}, nil, false, nil
	}

	var item codexItem
	if err := json.Unmarshal(l.Payload, &item); err != nil {
		return detect.Record{}, nil, false, fmt.Errorf("payload 不是合法 JSON：%v", err)
	}

	rec := detect.Record{
		Table:     AgentCodex,
		RequestID: fmt.Sprintf("%s:%d", s.Rel, lineNo),
		CallTS:    ts,
		KeyID:     s.Rel, // Codex 没有独立 session_id 列，用文件路径（与 claude 的 KeyName 语义一致）
		KeyName:   s.Rel,
		UserName:  *cwd,
		UserAgent: *version,
	}

	var reqParts []json.RawMessage
	var ev *ToolEvent

	switch item.Type {
	case "message":
		if item.Role == "assistant" {
			rec.ResponseBody = l.Payload // OpenAI Responses 形状，extract.Response 直接可拆
		} else {
			reqParts = append(reqParts, l.Payload)
		}
	case "reasoning":
		rec.ResponseBody = l.Payload
	case "function_call":
		// arguments 是 JSON 字符串，内容是工具参数。包成带 type=function_call 的
		// 对象进请求体：extract.roleOf 看到 type=="function_call" 直接给 tool_call 角色。
		var argStr string
		if err := json.Unmarshal(item.Arguments, &argStr); err == nil && argStr != "" {
			body, err := json.Marshal(map[string]string{"type": "function_call", "name": item.Name, "arguments": argStr})
			if err == nil {
				reqParts = append(reqParts, body)
			}
			fields := map[string]string{"arguments": argStr}
			// arguments 是 JSON：解析一层，把常见工具字段（command/file_path/…）
			// 提升为独立字段，行为引擎的规则按字段名匹配才能命中。
			// shell 工具的 command 是数组，文本化后整体作为 command 字段。
			var obj map[string]any
			if json.Unmarshal([]byte(argStr), &obj) == nil {
				for k, v := range obj {
					switch s := v.(type) {
					case string:
						fields[k] = s
					case []any:
						parts := make([]string, 0, len(s))
						for _, e := range s {
							if str, ok := e.(string); ok {
								parts = append(parts, str)
							}
						}
						fields[k] = strings.Join(parts, " ")
					}
				}
			}
			ev = &ToolEvent{SessionID: s.Rel, SourceFile: s.Rel, Line: lineNo, TS: ts,
				Event: behavior.Event{Tool: item.Name, Fields: fields}}
		}
	case "custom_tool_call":
		var inputStr string
		if err := json.Unmarshal(item.Input, &inputStr); err == nil && inputStr != "" {
			body, err := json.Marshal(map[string]string{"type": "custom_tool_call", "name": item.Name, "input": inputStr})
			if err == nil {
				reqParts = append(reqParts, body)
			}
			ev = &ToolEvent{SessionID: s.Rel, SourceFile: s.Rel, Line: lineNo, TS: ts,
				Event: behavior.Event{Tool: item.Name, Fields: map[string]string{"input": inputStr}}}
		}
	case "function_call_output", "custom_tool_call_output":
		// output 实测两种值：JSON 字符串 {"output":...}（shell）与纯字符串。
		// 两种都按文本处理：先尝试解开一层 JSON 字符串，失败则原样。
		var outStr string
		if err := json.Unmarshal(item.Output, &outStr); err != nil {
			outStr = string(item.Output)
		}
		// shell 工具的 output 是 {"output":...,"metadata":...}，再解一层取 output
		var inner struct {
			Output string `json:"output"`
		}
		if json.Unmarshal([]byte(outStr), &inner) == nil && inner.Output != "" {
			outStr = inner.Output
		}
		if outStr != "" {
			// role=="tool" 的 envelope：extract.roleOf 把 role=tool 映射为 tool_result。
			env, err := json.Marshal(toolResultEnvelope{Role: "tool", Content: mustJSON(outStr)})
			if err == nil {
				reqParts = append(reqParts, env)
			}
		}
	default:
		// 未知 payload 类型：跳过
		return detect.Record{}, nil, false, nil
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

// mustJSON 把字符串编成 JSON 字符串字面量；失败返回空串字面量（字符串输入不会失败）。
func mustJSON(s string) json.RawMessage {
	b, err := json.Marshal(s)
	if err != nil {
		return json.RawMessage(`""`)
	}
	return b
}
