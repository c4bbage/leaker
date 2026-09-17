package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"leakscan/internal/detect"
	"leakscan/internal/keyfile"
	"leakscan/internal/output"
	"leakscan/internal/rules"
)

// FileTable 是文件扫描时写入明细 table 列的值。
const FileTable = "file"

// runFile 扫描本地 JSONL（可 gzip 压缩）文件：每行是一次调用的请求体
// （如 {"messages":[...]}），按与数据库扫描相同的规则识别，输出同样的明细、发现和报告。
// 文件中没有员工、部门和时间信息，发现按"文件 × 凭证"汇总。
func runFile(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("file", flag.ExitOnError)
	in := fs.String("in", "", "输入文件：JSONL 或 JSONL.gz，每行一个请求体（必填）")
	outDir := fs.String("out", "out", "输出根目录，每次扫描新建子目录")
	workers := fs.Int("workers", runtime.NumCPU(), "识别并发数")
	batch := fs.Int("batch", 32, "每批读取行数")
	maxBody := fs.Int("max-body", 8<<20, "单行大小上限（字节），超过则跳过并计入覆盖统计")
	keyFile := fs.String("hmac-key", keyfile.DefaultPath("leakscan", "hmac.key"), "指纹密钥文件（不存在会自动生成）；不要放进输出目录")
	fs.Parse(args)
	if *in == "" {
		return errors.New("缺少 -in")
	}
	hmacKey, err := keyfile.LoadOrCreate(*keyFile)
	if err != nil {
		return fmt.Errorf("指纹密钥：%w", err)
	}
	runDir := filepath.Join(*outDir, time.Now().Format("20060102-150405"))
	if absKey, _ := filepath.Abs(*keyFile); strings.HasPrefix(absKey, keyfile.MustAbs(runDir)+string(filepath.Separator)) {
		return errors.New("指纹密钥文件不能放在输出目录里")
	}
	if err := output.EnsureDir(runDir); err != nil {
		return err
	}
	f, err := os.Open(*in)
	if err != nil {
		return err
	}
	defer f.Close()
	var r io.Reader = f
	if strings.HasSuffix(strings.ToLower(*in), ".gz") {
		gz, err := gzip.NewReader(f)
		if err != nil {
			return fmt.Errorf("解压 %s：%w", *in, err)
		}
		defer gz.Close()
		r = gz
	}
	counter := &countingReader{r: r}
	br := bufio.NewReaderSize(counter, 1<<20)

	det := detect.New(hmacKey, nil)
	hw, err := output.OpenHits(runDir, false)
	if err != nil {
		return err
	}
	defer hw.Close()

	source := filepath.Base(*in)
	st := &output.RunState{RulesetVersion: rules.Version, Source: source, Tables: []string{FileTable}, StartedAt: time.Now(),
		Cursors: map[string]output.Cursor{}, Done: map[string]bool{}, Coverage: map[string]*output.Coverage{FileTable: {}}}
	cov := st.Coverage[FileTable]
	fmt.Fprintf(os.Stderr, "输出目录：%s\n输入文件：%s\n", runDir, *in)

	start := time.Now()
	line := 0
	var readErr error
	for readErr == nil {
		if ctx.Err() != nil {
			break
		}
		recs := make([]detect.Record, 0, *batch)
		for len(recs) < *batch {
			b, tooLong, err := readLine(br, *maxBody)
			if err != nil {
				readErr = err
				if len(b) == 0 && !tooLong {
					break
				}
			}
			line++
			if !tooLong && len(bytes.TrimSpace(b)) == 0 {
				if readErr != nil {
					break
				}
				continue
			}
			rec := detect.Record{Table: FileTable, RequestID: "L" + strconv.Itoa(line), KeyID: source, KeyName: source}
			if tooLong {
				rec.RequestOversize = true
			} else {
				rec.RequestBody = b
			}
			recs = append(recs, rec)
			if readErr != nil {
				break
			}
		}
		if len(recs) == 0 {
			continue
		}
		outcomes := make([]detect.Outcome, len(recs))
		var wg sync.WaitGroup
		idx := make(chan int)
		for range max(1, *workers) {
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
		if err := hw.Flush(); err != nil {
			return err
		}
		elapsed := time.Since(start).Seconds()
		fmt.Fprintf(os.Stderr, "\r已扫 %d 行，解压后 %.1f GB（%.0f MB/s），有命中 %d 行   ",
			cov.Rows, float64(counter.n)/(1<<30), float64(counter.n)/(1<<20)/max(elapsed, 0.001), cov.RecordsWithHits)
	}
	fmt.Fprintln(os.Stderr)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		st.Errors = append(st.Errors, fmt.Sprintf("读取第 %d 行附近出错，之后的内容未扫描：%v", line, readErr))
	}
	if ctx.Err() != nil {
		st.Errors = append(st.Errors, fmt.Sprintf("扫描被中断，只扫描了前 %d 行；文件扫描不支持续扫，请重新扫描", line))
	} else if readErr == nil || errors.Is(readErr, io.EOF) {
		st.FinishedAt = new(time.Now())
		st.Done[FileTable] = true
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
	if err := output.BuildReport(runDir, output.GatewayProfile()); err != nil {
		return fmt.Errorf("生成报告：%w", err)
	}
	fmt.Fprintf(os.Stderr, "完成。报告：%s\n", filepath.Join(runDir, output.SummaryFile))
	return nil
}

// readLine 读取一行（不含换行符）。超过 limit 的行只读到末尾丢弃，返回 tooLong。
func readLine(br *bufio.Reader, limit int) (line []byte, tooLong bool, err error) {
	var buf []byte
	for {
		chunk, e := br.ReadSlice('\n')
		if !tooLong {
			if len(buf)+len(chunk) > limit+1 {
				tooLong, buf = true, nil
			} else {
				buf = append(buf, chunk...)
			}
		}
		if e == bufio.ErrBufferFull {
			continue
		}
		if e != nil {
			err = e
		}
		break
	}
	return bytes.TrimRight(buf, "\r\n"), tooLong, err
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}
