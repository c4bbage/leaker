package output

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// copyFixture 把网关夹具复制到临时目录，供报告生成使用。
func copyFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{CheckpointFile, HitsFile} {
		b, err := os.ReadFile(filepath.Join("testdata", "gateway_fixture", name))
		if err != nil {
			t.Fatalf("读夹具 %s：%v", name, err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// copyEndpointFixture 在网关夹具基础上把错误行换成端上口吻：
// 报告的 §9 引用的是运行时数据（st.Errors），端上运行不会出现
// 网关侧写进去的错误文案，测试夹具必须如实反映这一点，
// 否则措辞检查会把数据误判成模板措辞。
func copyEndpointFixture(t *testing.T) string {
	t.Helper()
	dir := copyFixture(t)
	st, err := LoadState(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.Errors = []string{"未扫描 3 处：单行超过上限 8388608 字节（例：proj/abc.jsonl:1204）"}
	if err := SaveState(dir, st); err != nil {
		t.Fatal(err)
	}
	return dir
}

// TestGatewayReportUnchanged 是防止改坏网关产品的护栏：
// 用固定夹具生成的网关报告必须与改动前的黄金文件逐字一致。
func TestGatewayReportUnchanged(t *testing.T) {
	dir := copyFixture(t)
	if err := BuildReport(dir, GatewayProfile()); err != nil {
		t.Fatalf("BuildReport：%v", err)
	}
	for _, name := range []string{FindingsFile, SummaryFile} {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("读生成的 %s：%v", name, err)
		}
		want, err := os.ReadFile(filepath.Join("testdata", "gateway_golden", name))
		if err != nil {
			t.Fatalf("读黄金文件 %s：%v", name, err)
		}
		if !bytes.Equal(got, want) {
			// 打印行级差异，方便定位是哪一节措辞变了
			gotLines := strings.Split(string(got), "\n")
			wantLines := strings.Split(string(want), "\n")
			for i := 0; i < len(gotLines) || i < len(wantLines); i++ {
				var g, w string
				if i < len(gotLines) {
					g = gotLines[i]
				}
				if i < len(wantLines) {
					w = wantLines[i]
				}
				if g != w {
					t.Errorf("%s 第 %d 行不一致：\n got: %q\nwant: %q", name, i+1, g, w)
				}
			}
		}
	}
}

// TestEndpointReportHasNoGatewayWording：端上报告面向开发者本人，
// 不得出现网关语境的词（EBR-004）。
func TestEndpointReportHasNoGatewayWording(t *testing.T) {
	dir := copyEndpointFixture(t)
	if err := BuildReport(dir, EndpointProfile()); err != nil {
		t.Fatalf("BuildReport：%v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, SummaryFile))
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	// "会话"是端上称谓，夹具表名 call_logs/call_traces 不含这些词。
	// 注意 "网关" 两字连写才计；"关" 单字会误伤。
	for _, word := range []string{"员工", "网关", "部门"} {
		if strings.Contains(s, word) {
			t.Errorf("端上报告出现了网关措辞 %q", word)
		}
	}
}

// TestEndpointCoverageHidesGatewayFields：端上报告不得渲染网关专有的
// 覆盖统计（认证头、Key 关闭日志），那会暗示"检查过了"而实际没有。
func TestEndpointCoverageHidesGatewayFields(t *testing.T) {
	dir := copyEndpointFixture(t)
	if err := BuildReport(dir, EndpointProfile()); err != nil {
		t.Fatalf("BuildReport：%v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, SummaryFile))
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, phrase := range []string{"Key 关闭日志", "认证头", "User-Agent", "按部门"} {
		if strings.Contains(s, phrase) {
			t.Errorf("端上报告渲染了网关专有内容 %q", phrase)
		}
	}
	// 同时确认端上自己的缺口列存在（GapLabels 生效）
	for _, phrase := range []string{"会话行格式无法解析", "文件读取时已消失"} {
		if !strings.Contains(s, phrase) {
			t.Errorf("端上报告缺少自己的缺口列 %q", phrase)
		}
	}
}

// TestEndpointReportKeepsNoLeakNote：两个产品都必须保留
// "没有发现 ≠ 没有泄漏"（EBR-009）。
func TestEndpointReportKeepsNoLeakNote(t *testing.T) {
	dir := copyEndpointFixture(t)
	if err := BuildReport(dir, EndpointProfile()); err != nil {
		t.Fatalf("BuildReport：%v", err)
	}
	b, err := os.ReadFile(filepath.Join(dir, SummaryFile))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "没有发现 ≠ 没有泄漏") {
		t.Error("端上报告缺少「没有发现 ≠ 没有泄漏」（EBR-009）")
	}
}
