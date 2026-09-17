// Package extract 把网关保存的请求体、响应体、请求头拆成带来源角色的文本。
//
// 网关实际保存的结构没有取到样本（见 PRODUCT Q-002），这里按 OpenAI Chat
// Completions、OpenAI Responses、Anthropic Messages 三种常见格式做通用遍历：
// 遇到带 role / type 的对象就切换角色，未识别的结构退回按字符串叶子扫描，
// 保证不会因为格式不认识而漏扫。
package extract

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"
)

// 来源角色。
const (
	RoleSystem         = "system"
	RoleUserInput      = "user_input"
	RoleToolResult     = "tool_result"
	RoleToolCall       = "tool_call"
	RoleAssistantHist  = "assistant_history"
	RoleToolDefinition = "tool_definition"
	RoleRequestOther   = "request_other"
	RoleModelOutput    = "model_output"
	RoleReasoning      = "model_reasoning"
	RoleRequestHeader  = "request_header"
	RoleRawUnparsed    = "raw_unparsed"
)

// Segments 是一条记录按角色合并后的文本。同一角色的多段文本用换行拼接，
// 这样分在两个内容块里的 AK 与 Secret 仍能成对识别。
type Segments map[string]string

// Result 描述一次拆分。
type Result struct {
	Segments Segments
	Parsed   bool // JSON 是否成功解析
}

// Request 拆分请求体。
func Request(raw []byte) Result { return fromJSON(raw, false) }

// Response 拆分响应体（含流式保存的 SSE 文本）。
func Response(raw []byte) Result { return fromJSON(raw, true) }

func fromJSON(raw []byte, isResponse bool) Result {
	res := Result{Segments: Segments{}, Parsed: true}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return res
	}
	var v any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		res.Parsed = false
		res.add(RoleRawUnparsed, string(raw))
		return res
	}
	defaultRole := RoleRequestOther
	if isResponse {
		defaultRole = RoleModelOutput
	}
	if s, ok := v.(string); ok {
		// jsonb 里存的是字符串：可能是 SSE 原文
		if isResponse && strings.Contains(s, "data:") {
			res.add(RoleModelOutput, reassembleSSE(s))
		}
		res.add(defaultRole, s)
		return res
	}
	w := walker{res: &res, isResponse: isResponse}
	w.walk(v, defaultRole, 0)
	return res
}

func (r *Result) add(role, s string) {
	if len(s) < 8 {
		return
	}
	if prev, ok := r.Segments[role]; ok {
		r.Segments[role] = prev + "\n" + s
		return
	}
	r.Segments[role] = s
}

type walker struct {
	res        *Result
	isResponse bool
}

// 这些键的值不含员工文本，或者是大块 base64（图片、推理签名），跳过以节省算力并避免误报。
var skipKeys = map[string]bool{
	"signature": true, "encrypted_content": true, "b64_json": true, "image_url": true,
	"logprobs": true, "usage": true, "model": true, "id": true, "object": true, "created": true,
	"system_fingerprint": true, "stop_reason": true, "finish_reason": true, "index": true,
}

var binaryTypes = map[string]bool{
	"image": true, "input_image": true, "image_url": true, "input_audio": true, "audio": true,
	"document": true, "input_file": true, "file": true,
}

const maxDepth = 64

func (w *walker) walk(v any, role string, depth int) {
	if depth > maxDepth {
		return
	}
	switch t := v.(type) {
	case map[string]any:
		if typ, ok := t["type"].(string); ok && binaryTypes[typ] {
			return
		}
		role = w.roleOf(t, role)
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if skipKeys[k] {
				continue
			}
			w.walk(t[k], w.childRole(k, role), depth+1)
		}
	case []any:
		for _, e := range t {
			w.walk(e, role, depth+1)
		}
	case string:
		w.res.add(role, t)
	}
}

// roleOf 根据对象自身的 role / type 字段决定角色。
func (w *walker) roleOf(m map[string]any, inherited string) string {
	if typ, ok := m["type"].(string); ok {
		switch typ {
		case "tool_result", "function_call_output", "tool_output", "mcp_tool_result", "computer_call_output":
			return RoleToolResult
		case "tool_use", "function_call", "server_tool_use", "mcp_call", "custom_tool_call":
			return RoleToolCall
		case "thinking", "reasoning", "redacted_thinking":
			return RoleReasoning
		}
	}
	if r, ok := m["role"].(string); ok {
		switch strings.ToLower(r) {
		case "system", "developer":
			return RoleSystem
		case "user", "human":
			return RoleUserInput
		case "tool", "function", "ipython":
			return RoleToolResult
		case "assistant", "model":
			if w.isResponse {
				return RoleModelOutput
			}
			return RoleAssistantHist
		}
	}
	return inherited
}

// childRole 根据字段名调整角色。
func (w *walker) childRole(key, role string) string {
	switch key {
	case "system", "instructions":
		return RoleSystem
	case "tools", "functions", "tool_choice":
		return RoleToolDefinition
	case "tool_calls", "function_call":
		return RoleToolCall
	case "reasoning_content", "thinking", "reasoning":
		return RoleReasoning
	case "input":
		// Responses API 的顶层 input 是用户输入；tool_use 块里的 input 是工具参数
		if role == RoleRequestOther {
			return RoleUserInput
		}
	case "prompt":
		if role == RoleRequestOther {
			return RoleUserInput
		}
	case "output":
		if role == RoleRequestOther && w.isResponse {
			return RoleModelOutput
		}
	}
	return role
}

// reassembleSSE 把流式响应的增量内容按顺序拼回完整文本，
// 避免一段凭证被切在两个分块里而漏检。
func reassembleSSE(s string) string {
	var b strings.Builder
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var v any
		if json.Unmarshal([]byte(payload), &v) != nil {
			continue
		}
		collectDeltas(v, &b, 0)
	}
	return b.String()
}

var deltaKeys = map[string]bool{"content": true, "text": true, "partial_json": true, "arguments": true, "delta": true, "thinking": true}

func collectDeltas(v any, b *strings.Builder, depth int) {
	if depth > maxDepth {
		return
	}
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			child := t[k]
			if s, ok := child.(string); ok {
				if deltaKeys[k] {
					b.WriteString(s)
				}
				continue
			}
			collectDeltas(child, b, depth+1)
		}
	case []any:
		for _, e := range t {
			collectDeltas(e, b, depth+1)
		}
	}
}

// 认证类请求头：网关自己保存了这些值，属于系统性问题，单独统计，不当作员工泄漏。
var authHeaders = map[string]bool{
	"authorization": true, "proxy-authorization": true, "x-api-key": true, "api-key": true,
	"x-goog-api-key": true, "anthropic-api-key": true, "cookie": true,
}

// HeaderResult 是请求头拆分结果。
type HeaderResult struct {
	Segments          Segments
	AuthPresent       bool
	AuthLooksUnmasked bool
}

// Headers 拆分请求头 JSON（兼容 map[string]string 与 map[string][]string）。
func Headers(raw []byte) HeaderResult {
	hr := HeaderResult{Segments: Segments{}}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return hr
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return hr
	}
	res := Result{Segments: hr.Segments}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		vals := headerValues(m[k])
		if authHeaders[strings.ToLower(k)] {
			for _, v := range vals {
				if v == "" {
					continue
				}
				hr.AuthPresent = true
				if looksUnmasked(v) {
					hr.AuthLooksUnmasked = true
				}
			}
			continue
		}
		for _, v := range vals {
			res.add(RoleRequestHeader, k+": "+v)
		}
	}
	return hr
}

func headerValues(v any) []string {
	switch t := v.(type) {
	case string:
		return []string{t}
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func looksUnmasked(v string) bool {
	l := strings.ToLower(v)
	if len(v) <= 20 {
		return false
	}
	for _, w := range []string{"*", "...", "redact", "mask", "xxxx"} {
		if strings.Contains(l, w) {
			return false
		}
	}
	return true
}
