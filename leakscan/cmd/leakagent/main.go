// leakagent：端上编码 agent 凭证泄漏自查（只读，结果只落本机）。
//
//	leakagent scan -from 2026-09-01 -to 2026-09-14
//
// 读取本机编码 agent 落盘的会话产物，用与网关扫描完全相同的规则识别凭证，
// 在本地生成报告。产品定义见 ../../../xspec/xf/v2-endpoint/PRODUCT.md。
//
// 三条必须守住的规则：
//   - EBR-001 零外发：本程序不做任何网络请求，没有遥测、上报、版本检查。
//   - EBR-002 产物不含原文：输出里只有类型、指纹和脱敏片段。
//   - EBR-007 只读不干扰：不修改、移动或删除任何 agent 的会话文件。
package main

import (
	"cmp"
	"context"
	"errors"
	"flag"
	"fmt"
	"maps"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"leakscan/internal/behavior"
	"leakscan/internal/detect"
	"leakscan/internal/endpoint"
	"leakscan/internal/keyfile"
	"leakscan/internal/output"
	"leakscan/internal/rules"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "scan":
		err = runScan(ctx, os.Args[2:])
	case "-h", "--help", "help":
		usage()
		return
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "错误：%v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `leakagent：端上编码 agent 凭证泄漏自查（只读，不联网，结果只落本机）

子命令：
  scan    扫描本机 agent 会话产物，生成本地报告

常用：
  leakagent scan -from 2026-09-01                 扫描 9/1 之后的 Claude 会话
  leakagent scan -agent codex -from 2026-09-01    扫描 Codex 会话
  leakagent scan -from 2026-09-01 -to 2026-09-14  指定窗口

注意：报告含凭证脱敏片段和本机路径，属敏感数据；不要提交仓库或放共享盘。
`)
}

// EndpointTable 是端上扫描写入明细 table 列的值前缀，实际值为 agent 名。
func runScan(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("scan", flag.ExitOnError)
	fromS := fs.String("from", "", "窗口起点，如 2026-09-01 或 2026-09-01 08:00（必填，避免默认全量）")
	toS := fs.String("to", "", "窗口终点，默认现在")
	agent := fs.String("agent", "claude", "要扫描的 agent：claude / codex")
	outDir := fs.String("out", "out", "输出根目录，每次扫描新建子目录")
	root := fs.String("root", "", "会话产物根目录，默认按 agent 取各自默认目录")
	workers := fs.Int("workers", runtime.NumCPU(), "识别并发数")
	maxLine := fs.Int("max-line", 8<<20, "单行大小上限（字节），超过则跳过并计入缺口")
	keyPath := fs.String("hmac-key", keyfile.DefaultPath("leakagent", "hmac.key"),
		"指纹密钥文件（不存在会自动生成）；与网关扫描不共用，见 EBR-005")
	fs.Parse(args)

	// 必须指定窗口：本机历史会话可能有数 GB（ECAP-007 明确不得默认全量）。
	if *fromS == "" {
		return errors.New("缺少 -from。本机历史会话可能很大，必须指定窗口；要扫全部请用一个足够早的日期")
	}
	from, err := parseTime(*fromS)
	if err != nil {
		return fmt.Errorf("-from：%w", err)
	}
	to := time.Now()
	if *toS != "" {
		if to, err = parseTime(*toS); err != nil {
			return fmt.Errorf("-to：%w", err)
		}
	}
	if !from.Before(to) {
		return errors.New("-from 必须早于 -to")
	}

	// 按 agent 选择适配器（ECAP-001）。目前两种会话格式已实测；
	// 其余 agent 进入 v0.1 缺口（ECAP-006 的 agent_unsupported）。
	var agentName string
	var sessionRoot string
	var discover func(root string, from, to time.Time) ([]endpoint.Session, []endpoint.Skip, error)
	var parse func(s endpoint.Session, from, to time.Time, maxLine int) ([]detect.Record, []endpoint.ToolEvent, []endpoint.Skip, error)
	switch strings.ToLower(*agent) {
	case endpoint.AgentClaude:
		agentName = endpoint.AgentClaude
		discover, parse = endpoint.DiscoverClaude, endpoint.ParseSession
		r := *root
		if r == "" {
			if r, err = endpoint.ClaudeRoot(); err != nil {
				return fmt.Errorf("定位会话目录：%w", err)
			}
		}
		sessionRoot = r
	case endpoint.AgentCodex:
		agentName = endpoint.AgentCodex
		discover, parse = endpoint.DiscoverCodex, endpoint.ParseCodexSession
		r := *root
		if r == "" {
			if r, err = endpoint.CodexRoot(); err != nil {
				return fmt.Errorf("定位会话目录：%w", err)
			}
		}
		sessionRoot = r
	default:
		return fmt.Errorf("不支持的 agent %q；已支持：%s、%s", *agent, endpoint.AgentClaude, endpoint.AgentCodex)
	}
	if _, err := os.Stat(sessionRoot); err != nil {
		return fmt.Errorf("会话目录不可读：%s（%v）", sessionRoot, err)
	}

	hmacKey, err := keyfile.LoadOrCreate(*keyPath)
	if err != nil {
		return fmt.Errorf("指纹密钥：%w", err)
	}
	runDir := filepath.Join(*outDir, time.Now().Format("20060102-150405"))
	absKey := keyfile.MustAbs(*keyPath)
	if strings.HasPrefix(absKey, keyfile.MustAbs(runDir)+string(filepath.Separator)) {
		return errors.New("指纹密钥文件不能放在输出目录里")
	}
	if err := output.EnsureDir(runDir); err != nil {
		return err
	}

	sessions, skips, err := discover(sessionRoot, from, to)
	if err != nil {
		return fmt.Errorf("发现会话：%w", err)
	}
	fmt.Fprintf(os.Stderr, "会话目录：%s\n输出目录：%s\n窗口：%s ~ %s\n发现 %d 个会话文件\n",
		sessionRoot, runDir, from.Format(time.DateTime), to.Format(time.DateTime), len(sessions))

	det := detect.New(hmacKey, nil)
	hw, err := output.OpenHits(runDir, false)
	if err != nil {
		return err
	}
	defer hw.Close()
	bw, err := output.OpenBehavior(runDir, false)
	if err != nil {
		return err
	}
	defer bw.Close()

	st := &output.RunState{
		RulesetVersion: rules.Version,
		Source:         sessionRoot,
		Tables:         []string{agentName},
		StartedAt:      time.Now(),
		From:           from,
		To:             to,
		Cursors:        map[string]output.Cursor{},
		Done:           map[string]bool{},
		Coverage:       map[string]*output.Coverage{agentName: {}},
	}
	cov := st.Coverage[agentName]

	behaviorCount := 0
	interrupted := false
	for i, s := range sessions {
		if ctx.Err() != nil {
			interrupted = true
			break
		}
		recs, evs, sk, err := parse(s, from, to, *maxLine)
		skips = append(skips, sk...)
		if err != nil {
			skips = append(skips, endpoint.Skip{Path: s.Rel, Reason: err.Error()})
			continue
		}
		for _, o := range scanAll(det, recs, *workers) {
			if err := hw.Write(o); err != nil {
				return err
			}
			cov.Add(o)
		}
		// 行为判定（ECAP-008）：单事件匹配，与凭证检测并行不悖。
		// 没有凭证命中的会话同样可能有行为观察——两者整改动作不同。
		for _, te := range evs {
			for _, bf := range behavior.Scan(te.Event) {
				row := output.BehaviorRow{
					Agent:      agentName,
					SessionID:  te.SessionID,
					SourceFile: te.SourceFile,
					Line:       te.Line,
					RuleID:     bf.RuleID,
					RuleName:   bf.Name,
					Severity:   bf.Severity,
					Tool:       bf.Tool,
					Field:      bf.Field,
					Excerpt:    bf.Excerpt,
				}
				if !te.TS.IsZero() {
					row.TS = te.TS.Format(time.RFC3339)
				}
				if err := bw.Write(row); err != nil {
					return err
				}
				behaviorCount++
			}
		}
		if err := hw.Flush(); err != nil {
			return err
		}
		if err := bw.Flush(); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "\r已扫 %d/%d 个会话，%d 条记录，有命中 %d 条，行为观察 %d 条   ",
			i+1, len(sessions), cov.Rows, cov.RecordsWithHits, behaviorCount)
	}
	fmt.Fprintln(os.Stderr)

	// 缺口按原因归类：可计数的进 Coverage（覆盖表渲染，ECAP-006），
	// 归不进计数类的按原因归并成错误行。扫不到必须可解释（EBR-009）。
	for _, line := range summarizeSkips(skips, cov) {
		st.Errors = append(st.Errors, line)
	}
	if interrupted {
		st.Errors = append(st.Errors, "扫描被中断，结果不完整；端上扫描不支持续扫，请重新扫描")
	} else {
		st.FinishedAt = new(time.Now())
		st.Done[agentName] = true
	}
	if err := hw.Flush(); err != nil {
		return err
	}
	if err := output.SaveState(runDir, st); err != nil {
		return err
	}
	if err := output.WriteCoverage(runDir, st); err != nil {
		return err
	}
	if err := output.BuildReport(runDir, output.EndpointProfile()); err != nil {
		return fmt.Errorf("生成报告：%w", err)
	}
	fmt.Fprintf(os.Stderr, "完成。报告：%s\n没有发现 ≠ 没有泄漏：请一并阅读报告里的覆盖缺口。\n",
		filepath.Join(runDir, output.SummaryFile))
	return nil
}

func scanAll(det *detect.Detector, recs []detect.Record, workers int) []detect.Outcome {
	outcomes := make([]detect.Outcome, len(recs))
	if len(recs) == 0 {
		return outcomes
	}
	workers = max(1, workers)
	var wg sync.WaitGroup
	idx := make(chan int)
	for range workers {
		wg.Go(func() {
			for i := range idx {
				outcomes[i] = det.Scan(recs[i])
			}
		})
	}
	for i := range recs {
		idx <- i
	}
	close(idx)
	wg.Wait()
	return outcomes
}

// summarizeSkips 把缺口按原因归类：能归入 Coverage 计数类的（ECAP-006
// 定义的三类：AgentUnsupported / ParseFailed / FileVanished）累加进 cov，
// 不再以散文进报告；归不进的仍按原因归并成错误行（每类一条，附一例）。
func summarizeSkips(skips []endpoint.Skip, cov *output.Coverage) []string {
	if len(skips) == 0 {
		return nil
	}
	byReason := map[string]int{}
	example := map[string]string{}
	classify := func(s endpoint.Skip) (string, bool) {
		switch {
		case strings.HasPrefix(s.Reason, "窗口外"), strings.HasPrefix(s.Reason, "取文件信息失败"):
			// 发现阶段的正常筛选/读元数据失败，不归三类计数；
			// 窗口外本就是预期行为，无需进报告。
			return "", false
		case strings.HasPrefix(s.Reason, "目录读取失败"), strings.HasPrefix(s.Reason, "打开失败"), strings.HasPrefix(s.Reason, "读取出错"):
			cov.FileVanished++
			return "", true // FileVanished 已计数，不再生成错误行
		case strings.HasPrefix(s.Reason, "不是合法 JSON"), strings.HasPrefix(s.Reason, "重新编码失败"):
			cov.ParseFailed++
			return "", true
		case strings.HasPrefix(s.Reason, "单行超过上限"):
			return "单行超过上限，未扫描", false
		default:
			return "", false
		}
	}
	for _, s := range skips {
		key, counted := classify(s)
		if counted {
			continue
		}
		if key == "" {
			continue
		}
		byReason[key]++
		if example[key] == "" {
			example[key] = s.Path
		}
	}
	keys := slices.Collect(maps.Keys(byReason))
	slices.SortFunc(keys, func(a, b string) int {
		if byReason[a] != byReason[b] {
			return cmp.Compare(byReason[b], byReason[a])
		}
		return cmp.Compare(a, b)
	})
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, fmt.Sprintf("未扫描 %d 处：%s（例：%s）", byReason[k], k, example[k]))
	}
	return out
}

func parseTime(s string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("无法解析时间 %q（支持 2026-09-01、2026-09-01 08:00、RFC3339）", s)
}
