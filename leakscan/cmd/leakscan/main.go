// leakscan：只读回溯扫描网关数据库，检查员工是否在大模型调用中泄漏了敏感凭证。
//
//	leakscan probe  -dsn ... -from ... -to ...    先确认网关实际保存了什么（只输出统计，不输出内容）
//	leakscan scan   -dsn ... -from ... -to ...    扫描并输出 hits.csv / findings.csv / summary.md
//	leakscan report -dir out/<run>                 从 hits.csv 重新生成汇总
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"

	"leakscan/internal/detect"
	"leakscan/internal/keyfile"
	"leakscan/internal/output"
	"leakscan/internal/rules"
	"leakscan/internal/store"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var err error
	switch os.Args[1] {
	case "probe":
		err = runProbe(ctx, os.Args[2:])
	case "scan":
		err = runScan(ctx, os.Args[2:])
	case "report":
		err = runReport(os.Args[2:])
	case "file":
		err = runFile(ctx, os.Args[2:])
	case "-h", "--help", "help":
		usage()
		return
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "错误：", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `leakscan：网关凭证泄漏回溯扫描（只读）

子命令：
  probe   探查网关实际保存的内容结构，只输出统计，不输出内容
  scan    扫描时间窗口内的调用记录，输出命中明细、发现汇总与报告
  report  从已有扫描目录的 hits.csv 重新生成 findings.csv 与 summary.md
  file    扫描本地 JSONL / JSONL.gz 文件（每行一个请求体），不连数据库

数据库连接串可用 -dsn 或环境变量 LEAKSCAN_DSN 提供，务必使用只读账号，最好连只读副本。
各子命令加 -h 查看参数。
`)
}

type timeFlag struct{ t *time.Time }

func (f timeFlag) String() string {
	if f.t == nil || f.t.IsZero() {
		return ""
	}
	return f.t.Format(time.RFC3339)
}

func (f timeFlag) Set(s string) error {
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			*f.t = t
			return nil
		}
	}
	return fmt.Errorf("无法解析时间 %q（支持 RFC3339、2006-01-02 15:04:05、2006-01-02）", s)
}

func dsnOrEnv(v string) (string, error) {
	if v != "" {
		return v, nil
	}
	if e := os.Getenv("LEAKSCAN_DSN"); e != "" {
		return e, nil
	}
	return "", errors.New("缺少数据库连接串：使用 -dsn 或环境变量 LEAKSCAN_DSN")
}

func runProbe(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("probe", flag.ExitOnError)
	dsn := fs.String("dsn", "", "PostgreSQL 连接串（只读账号）")
	to := time.Now()
	from := to.Add(-time.Hour)
	fs.Var(timeFlag{&from}, "from", "窗口开始（默认 1 小时前）")
	fs.Var(timeFlag{&to}, "to", "窗口结束（默认现在）")
	timeout := fs.Duration("stmt-timeout", 30*time.Second, "单条 SQL 超时")
	out := fs.String("out", "", "同时写入该文件（默认只打印）")
	fs.Parse(args)
	d, err := dsnOrEnv(*dsn)
	if err != nil {
		return err
	}
	conn, err := store.Connect(ctx, store.Options{DSN: d, StatementTimeout: *timeout})
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	var w io.Writer = os.Stdout
	if *out != "" {
		f, err := os.OpenFile(*out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			return err
		}
		defer f.Close()
		w = io.MultiWriter(os.Stdout, f)
	}
	store.Probe(ctx, conn, from, to, w)
	return nil
}

func runScan(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("scan", flag.ExitOnError)
	dsn := fs.String("dsn", "", "PostgreSQL 连接串（只读账号）")
	var from, to time.Time
	fs.Var(timeFlag{&from}, "from", "窗口开始（必填）")
	fs.Var(timeFlag{&to}, "to", "窗口结束（默认现在）")
	tables := fs.String("tables", "call_logs,call_traces", "扫描的表，逗号分隔")
	batch := fs.Int("batch", 500, "每批读取条数")
	sleep := fs.Duration("sleep", 200*time.Millisecond, "批间休眠，给网关库让路")
	workers := fs.Int("workers", runtime.NumCPU(), "识别并发数")
	maxBody := fs.Int("max-body", 8<<20, "单个内容字段大小上限（字节，按库内存储大小），超过则跳过并计入覆盖统计")
	outDir := fs.String("out", "out", "输出根目录")
	resume := fs.String("resume", "", "从已有扫描目录的断点继续（忽略 -from/-to/-tables）")
	keyFile := fs.String("hmac-key", keyfile.DefaultPath("leakscan", "hmac.key"), "指纹密钥文件（不存在会自动生成）；不要放进输出目录")
	timeout := fs.Duration("stmt-timeout", 60*time.Second, "单条 SQL 超时")
	fs.Parse(args)

	d, err := dsnOrEnv(*dsn)
	if err != nil {
		return err
	}
	hmacKey, err := keyfile.LoadOrCreate(*keyFile)
	if err != nil {
		return fmt.Errorf("指纹密钥：%w", err)
	}

	var runDir string
	var st *output.RunState
	if *resume != "" {
		runDir = *resume
		if st, err = output.LoadState(runDir); err != nil {
			return err
		}
		if st.RulesetVersion != rules.Version {
			return fmt.Errorf("断点的规则集版本 %s 与当前 %s 不同，不能续扫，请重新扫描", st.RulesetVersion, rules.Version)
		}
	} else {
		if from.IsZero() {
			return errors.New("缺少 -from")
		}
		if to.IsZero() {
			to = time.Now()
		}
		if !from.Before(to) {
			return errors.New("-from 必须早于 -to")
		}
		var ts []string
		for t := range strings.SplitSeq(*tables, ",") {
			t = strings.TrimSpace(t)
			if t == "" {
				continue
			}
			if !store.Tables[t] {
				return fmt.Errorf("不支持的表 %q", t)
			}
			ts = append(ts, t)
		}
		runDir = filepath.Join(*outDir, time.Now().Format("20060102-150405"))
		st = &output.RunState{RulesetVersion: rules.Version, From: from, To: to, Tables: ts, StartedAt: time.Now(),
			Cursors: map[string]output.Cursor{}, Done: map[string]bool{}, Coverage: map[string]*output.Coverage{}}
	}
	if absKey, _ := filepath.Abs(*keyFile); strings.HasPrefix(absKey, keyfile.MustAbs(runDir)+string(filepath.Separator)) {
		return errors.New("指纹密钥文件不能放在输出目录里")
	}
	if err := output.EnsureDir(runDir); err != nil {
		return err
	}

	conn, err := store.Connect(ctx, store.Options{DSN: d, StatementTimeout: *timeout})
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	keys, err := store.LoadKeys(ctx, conn)
	if err != nil {
		st.Errors = append(st.Errors, "读取 api_keys 失败，无法区分日志关闭原因、无法确认本网关 Key："+err.Error())
		keys = map[string]store.KeyInfo{}
	}
	gw := map[string]detect.GatewayKey{}
	for _, k := range keys {
		gw[k.Hash] = detect.GatewayKey{ID: k.ID, UserID: k.UserID, Name: k.Name, Enabled: k.Enabled}
	}
	det := detect.New(hmacKey, gw)

	hw, err := output.OpenHits(runDir, *resume != "")
	if err != nil {
		return err
	}
	defer hw.Close()

	fmt.Fprintf(os.Stderr, "输出目录：%s\n窗口：%s ~ %s\n", runDir, st.From.Format(time.RFC3339), st.To.Format(time.RFC3339))
	for _, table := range st.Tables {
		if st.Done[table] {
			continue
		}
		if st.Coverage[table] == nil {
			st.Coverage[table] = &output.Coverage{}
		}
		if err := scanTable(ctx, conn, det, hw, st, runDir, table, *batch, *maxBody, *workers, *sleep, keys); err != nil {
			output.SaveState(runDir, st)
			if ctx.Err() != nil {
				fmt.Fprintf(os.Stderr, "\n已中断，断点已保存。继续：leakscan scan -resume %s\n", runDir)
				return nil
			}
			return fmt.Errorf("扫描 %s：%w（断点已保存，可用 -resume %s 继续）", table, err, runDir)
		}
	}
	st.FinishedAt = new(time.Now())
	if err := output.SaveState(runDir, st); err != nil {
		return err
	}
	if err := output.WriteCoverage(runDir, st); err != nil {
		return err
	}
	if err := hw.Flush(); err != nil {
		return err
	}
	if err := output.BuildReport(runDir, output.GatewayProfile()); err != nil {
		return fmt.Errorf("生成报告：%w", err)
	}
	fmt.Fprintf(os.Stderr, "\n完成。报告：%s\n", filepath.Join(runDir, output.SummaryFile))
	return nil
}

func scanTable(ctx context.Context, conn *pgx.Conn, det *detect.Detector, hw *output.HitWriter, st *output.RunState, runDir, table string,
	batch, maxBody, workers int, sleep time.Duration, keys map[string]store.KeyInfo) error {
	cov := st.Coverage[table]
	c := st.Cursors[table]
	cur := store.Cursor{TS: c.TS, RequestID: c.RequestID}
	if cur.TS.IsZero() {
		cur.TS = st.From
	}
	start := time.Now()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		recs, next, err := store.FetchBatch(ctx, conn, table, st.From, st.To, cur, batch, maxBody, keys)
		if err != nil {
			return err
		}
		if len(recs) == 0 {
			st.Done[table] = true
			return output.SaveState(runDir, st)
		}
		outcomes := make([]detect.Outcome, len(recs))
		var wg sync.WaitGroup
		idx := make(chan int)
		for range max(1, workers) {
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

		for _, o := range outcomes {
			if err := hw.Write(o); err != nil {
				return err
			}
			cov.Add(o)
		}
		// 先落盘命中，再推进断点：断点之前的记录一定已写入
		if err := hw.Flush(); err != nil {
			return err
		}
		cur = next
		st.Cursors[table] = output.Cursor{TS: cur.TS, RequestID: cur.RequestID}
		if err := output.SaveState(runDir, st); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "\r%s：已扫 %d 条，有命中 %d 条，进度至 %s，用时 %s   ",
			table, cov.Rows, cov.RecordsWithHits, cur.TS.Format("2006-01-02 15:04:05"), time.Since(start).Truncate(time.Second))
		if len(recs) < batch {
			st.Done[table] = true
			fmt.Fprintln(os.Stderr)
			return output.SaveState(runDir, st)
		}
		if sleep > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(sleep):
			}
		}
	}
}

func runReport(args []string) error {
	fs := flag.NewFlagSet("report", flag.ExitOnError)
	dir := fs.String("dir", "", "扫描输出目录")
	fs.Parse(args)
	if *dir == "" {
		return errors.New("缺少 -dir")
	}
	if err := output.BuildReport(*dir, output.GatewayProfile()); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "已生成：%s、%s\n", filepath.Join(*dir, output.FindingsFile), filepath.Join(*dir, output.SummaryFile))
	return nil
}
