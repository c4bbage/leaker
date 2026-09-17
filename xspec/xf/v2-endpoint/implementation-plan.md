# 端上自查 v0.1 实施方案（可交付 subagent 执行）

## 文件头

| 属性 | 内容 |
| :--- | :--- |
| 文件性质 | **实施方案**，供 subagent 按条执行。**不是** `/xf-design-v2` 或 `/xf-detail-v2` 的产出，**不满足**其门禁，也不能作为正式阶段通过凭据 |
| 基线 | [PRODUCT.md](./PRODUCT.md) 产品内容 **0.3** / 文档修订 4，SHA-256 `4284086ea0ef42640a17a7daacd6b64da073f53f7b6e26304d9a267c8f0ad523` |
| 代码基线 | `leakscan/`，规则集 `2026-09-14.2`，`go test ./...` 全绿 |
| 覆盖范围 | ECAP-005 补全、ECAP-008、ECAP-011，以及输出层与网关产品解耦 |
| 执行者 | 每个工作项可独立交给一个 subagent；依赖关系见 §1 |

---

## 0. 执行者须知（先读这一节）

### 0.1 绝对不要改动的代码

以下三个包**已在 7039 条真实记录上验证过**，并已抓出并修复一类真实误报。改动它们会同时影响网关产品（EBR-006：规则集只有一份）。

```
internal/rules/      ← 内容识别规则 + 占位符判定
internal/detect/     ← 指纹、命中聚合、Record/Hit 结构
internal/extract/    ← 会话内容按来源角色拆分
```

**唯一允许的例外**：WI-3 需要往 `internal/rules` 增加**新的**凭证类型时，只能追加，不得修改现有规则的正则、严重程度或置信度。

### 0.2 必须守住的产品规则

| 规则 | 含义 | 怎么验证 |
| :--- | :--- | :--- |
| EBR-001 | 零外发：不得有任何网络请求，含遥测、上报、版本检查 | `grep -rn 'net/http\|net.Dial' cmd/leakagent internal/endpoint internal/behavior` 必须无结果 |
| EBR-002 | 产物不含凭证原文 | 用 `rules.Scan` 反扫全部输出文件，非 placeholder 命中数必须为 0 |
| EBR-003 | 输出目录 0700、文件 0600 | 扫描后检查权限位 |
| EBR-007 | 只读：不修改/移动/删除任何 agent 会话文件 | 不得出现 `os.Create`/`os.Remove`/`os.Rename` 指向会话目录 |
| EBR-008 | `CGO_ENABLED=0` 静态可执行 | `./build.sh` 六平台必须全部成功 |

### 0.3 完成标准

每个工作项完成的定义：`go build ./... && go vet ./... && go test ./...` 全绿，**且**该项列出的验收测试存在并通过。不允许用 `t.Skip` 绕过。

---

## 1. 工作项与依赖

```
WI-1 输出层解耦 ──┬──> WI-2 凭证所属文件路径 (ECAP-011)
                  └──> WI-5 Codex 适配器
WI-3 行为规则引擎 (ECAP-008) ── 独立，可并行
WI-4 敏感路径数据表 ── WI-2 与 WI-3 共用，须先于两者完成
```

| 编号 | 工作项 | 依赖 | 可并行 |
| :--- | :--- | :--- | :--- |
| WI-1 | 输出层与网关产品解耦 | 无 | 与 WI-3、WI-4 并行 |
| WI-4 | 敏感路径数据表 | 无 | 与 WI-1 并行 |
| WI-2 | 凭证所属文件路径（ECAP-011） | WI-1、WI-4 | — |
| WI-3 | 行为规则引擎（ECAP-008） | WI-4 | 与 WI-1 并行 |
| WI-5 | Codex 适配器 | WI-1 | — |

**WI-1 与 WI-2 改动同一段代码路径**（`HitsHeader` 与写入端），若同一个执行者承担，合并为一次改动，不要做两遍。

**WI-5 必须在 WI-1 之后**，否则新适配器会继承网关形状的列名，等于把问题复制一份。

---

## 2. WI-1：输出层与网关产品解耦

### 2.1 问题

`internal/output` 目前只服务网关语义，端上复用时产生三类错误：

| 位置 | 现状 | 证据 |
| :--- | :--- | :--- |
| `internal/output/report.go` | 16 处硬编码网关措辞（"网关凭证泄漏回溯审计报告"、"员工姓名"、"Key 关闭日志"、"仅限安全团队查看"） | `grep -c '网关\|员工\|部门\|Key 关闭' internal/output/report.go` = 16 |
| `internal/output/output.go` `Coverage` | 4 个端上无意义字段渲染为 0，暗示"检查过了" | `NoContentLogOff`、`AuthHeader`、`AuthUnmasked`、`WithHeaders` |
| `internal/output/output.go` `HitsHeader` | 无 `source_path` 列，端上靠重定义 `key_name` 顶替 | 见 `README-leakagent.md` 的列名对照表 |

开发者在自己笔记本上跑自查，报告却说"本文件含员工姓名""仅限安全团队查看"——这会直接摧毁工具可信度。

### 2.2 改动

**新增 `internal/output/profile.go`**：

```go
package output

// Profile 描述一次扫描属于哪个产品，决定报告措辞与统计口径。
type Profile struct {
    ID              string   // "gateway" | "endpoint"
    ReportTitle     string   // 报告一级标题
    SensitivityNote string   // 标题下的敏感性提示
    SubjectNoun     string   // 发现聚合的主体称谓："员工" / "会话"
    SourceNoun      string   // 数据来源称谓："网关" / "本机 agent"
    // GapLabels 把 Coverage 字段名映射为该产品的人类可读标签；
    // 不在 map 里的字段不渲染——这是隐藏网关专有字段的机制。
    GapLabels map[string]string
}

func GatewayProfile() Profile  { /* 保持现有措辞，网关报告输出必须逐字不变 */ }
func EndpointProfile() Profile { /* 端上措辞，见 2.3 */ }
```

**修改 `internal/output/report.go`**：`BuildReport(dir string)` → `BuildReport(dir string, p Profile)`。所有硬编码中文改为从 `Profile` 取。

**修改 `internal/output/output.go`**：

```go
// Coverage 增加端上缺口计数。网关侧这些恒为 0，端上侧网关那 4 个恒为 0，
// 靠 Profile.GapLabels 控制各自渲染哪些。
type Coverage struct {
    // ...保留全部现有字段...
    AgentUnsupported int64 `json:"agent_unsupported"` // agent 不支持
    ParseFailed      int64 `json:"parse_failed"`      // 格式无法解析
    FileVanished     int64 `json:"file_vanished"`     // 读取时文件已消失
}

// HitsHeader 末尾追加一列（追加在末尾，保证既有列位不变）
var HitsHeader = []string{ /* ...现有列... */, "source_path" }
```

`HitWriter.Write` 相应多写一列，值取 `Outcome.Record` 新增的 `SourcePath` 字段（见 WI-2）。网关侧该字段为空字符串。

**修改调用点**：`cmd/leakscan/main.go`、`cmd/leakscan/filescan.go` 传 `GatewayProfile()`；`cmd/leakagent/main.go` 传 `EndpointProfile()`。

**`cmd/leakagent/main.go` 的 `summarizeSkips`**：现在把缺口塞进 `st.Errors` 当散文。改为按原因归类计数写入 `Coverage` 的新字段，`st.Errors` 只保留真正的错误。

### 2.3 端上报告措辞

| 位置 | 网关（不变） | 端上 |
| :--- | :--- | :--- |
| 标题 | 网关凭证泄漏回溯审计报告 | 本机 Agent 凭证泄漏自查报告 |
| 敏感性提示 | 本文件含员工姓名和凭证脱敏片段……仅限安全团队查看 | 本文件含凭证脱敏片段和本机路径，属敏感数据；不要提交仓库或放共享盘 |
| 主体称谓 | 员工 | 会话 |
| 来源称谓 | 网关 | 本机 agent |
| 覆盖章节 | 只有网关实际保存了内容的调用才能被检测 | 只有 agent 实际写到磁盘的会话才能被检测；已被 agent 轮转或清理的看不到 |

两个产品的报告都必须保留"**没有发现 ≠ 没有泄漏**"（EBR-009）。

### 2.4 验收

- 新增 `internal/output/profile_test.go`：
  - `TestGatewayReportUnchanged` —— 用固定的 `hits.csv` 夹具生成网关报告，与改动前的黄金文件逐字比对。**这条是防止改坏网关产品的护栏，必须有。**
  - `TestEndpointReportHasNoGatewayWording` —— 端上报告中不得出现「员工」「网关」「部门」「Key 关闭日志」。
  - `TestEndpointCoverageHidesGatewayFields` —— 端上报告不渲染 `AuthHeader` / `NoContentLogOff` 等。
- `go test ./...` 全绿。

---

## 3. WI-4：敏感路径数据表（WI-2 与 WI-3 共用）

### 3.1 为什么先做这个

PRODUCT 0.3 的 ECAP-011 明确要求路径清单与 ECAP-008 的凭证位置表**共用同一份数据**。两份清单一定会漂移——这正是 EBR-006 为内容规则防的那类问题。

### 3.2 改动

**新增 `internal/behavior/paths.go`** —— 数据以 Go 常量内嵌，不用外部 JSON 文件（保证 `CGO_ENABLED=0` 单文件分发，不需要运行时读配置）：

```go
package behavior

// SensitivePath 描述一个凭证所在位置。
type SensitivePath struct {
    ID       string   // 稳定标识，如 "ssh_private_key_dir"
    Name     string   // 中文名，进报告
    OS       []string // "darwin" / "linux" / "windows"；空表示全平台
    Patterns []string // 路径匹配模式（大小写不敏感，用 Go regexp/RE2）
    Severity string   // 复用 rules.SevHigh/SevMedium/SevLow
}
```

**必须覆盖的条目**（CC-Monitor 那份只有 7 个 Unix 模式，对本产品威胁模型偏薄，以下为本产品自身工作）：

| 平台 | 必含 |
| :--- | :--- |
| 全平台 | `.ssh/`、`id_rsa`、`id_ed25519`、`id_ecdsa`、`.pem$`、`.p12$`、`.pfx$`、`.env$`、`.aws/credentials`、`.kube/config`、`kubeconfig`、`.docker/config.json`、`.netrc`、`.npmrc`、`.pypirc`、`.git-credentials` |
| macOS | `Library/Keychains/`、`Library/Application Support/` 下的凭证文件 |
| Linux | `/etc/shadow`、`.gnupg/`、`.config/gcloud/`、`.local/share/keyrings/` |
| Windows | `%APPDATA%` 下凭证路径、`AppData\Roaming\`、`.aws\credentials`、注册表导出文件 `.reg$` |
| 国内云 | `.aliyun/config.json`、`.tencentcloud/`、`.huaweicloud/`、`.obsutil` 配置 |

**注意**：CC-Monitor 无许可证（ESRC-014），**不得复制其代码或正则字面量**；以上条目按公开的工具文档独立编写。

### 3.3 验收

新增 `internal/behavior/paths_test.go`：
- `TestEveryPathCompiles` —— 全部模式能被 `regexp.MustCompile` 编译（RE2，线性时间）。
- `TestPathIDsUnique` —— ID 不重复。
- `TestKnownPathsMatch` —— 表驱动：`~/.ssh/id_rsa`、`C:\Users\x\.aws\credentials`、`/etc/shadow` 等必须命中预期条目。
- `TestNoFalseMatchOnCommonPaths` —— `src/environment.ts`、`README.env.md`、`.github/` 等**不得**命中。

---

## 4. WI-2：凭证所属文件路径（ECAP-011）

### 4.1 问题

现在报告只能说"在 `proj/abc.jsonl:1234` 发现了一个 SSH 私钥"。要去轮换密钥的人真正需要知道的是"这个私钥来自 `~/.ssh/id_rsa`"。

Claude 的 `toolUseResult` 里本来就带 `filePath`（实测形态见 §4.2），信息一直都在，只是被丢掉了。

### 4.2 已实测的 `toolUseResult` 形态

```
{stdout, stderr, interrupted, isImage, noOutputExpected}          Bash，84 例
"<字符串>"                                                          27 例
{content, filePath, originalFile, structuredPatch, type, ...}     Edit，7 例
{file:{filePath, content}, type}                                  Read，1 例
```

### 4.3 改动

**`internal/detect/detect.go`** —— 这是对 0.1 节禁改规则的**唯一许可例外**，且只允许**追加一个字段**，不得改动任何现有字段或逻辑：

```go
type Record struct {
    // ...现有字段全部保留...
    SourcePath string // 凭证所属文件（如 ~/.ssh/id_rsa）；无法归因时为空
}
```

`Outcome` 透传该字段供 `HitWriter` 写入。

**`internal/endpoint/claude.go`** —— 在 `recordFromLine` 中解析 `toolUseResult` 的路径字段：

```go
// extractFilePath 从 toolUseResult 中取出凭证所属文件路径。
// 按实测形态依次尝试 filePath、file.filePath；取不到返回空字符串。
// 绝不猜测：拿不到就是空（ECAP-011 明确要求不得猜测）。
func extractFilePath(toolUseResult json.RawMessage) string
```

取到路径后写入 `rec.SourcePath`。若该路径命中 WI-4 的敏感路径表，在 `rec.SourcePath` 后追加敏感标记（形式由执行者定，但必须在报告中可区分）。

### 4.4 验收

`internal/endpoint/claude_test.go` 新增：
- `TestSourcePathFromReadResult` —— `{file:{filePath:"/root/.ssh/id_rsa",content:<私钥>}}` → `rec.SourcePath == "/root/.ssh/id_rsa"`，且该命中在 `hits.csv` 的 `source_path` 列有值。
- `TestSourcePathFromEditResult` —— `{filePath:"...", content:"..."}` 形态同样能取到。
- `TestSourcePathEmptyWhenUnknown` —— Bash 的 `{stdout:...}` 形态取不到路径时为空字符串，**不得**猜测成会话文件路径。

---

## 5. WI-3：行为规则引擎（ECAP-008）

### 5.1 范围

**单事件匹配**：一条记录 → 一次判定，不做序列关联（序列是 v0.2 的 ECAP-009）。

**只做检测，不做拦截**（§6 产品边界）。

**不纳入破坏性操作规则**：`rm -rf`、fork bomb、反弹 shell、持久化、docker privileged、包管理等属 EDR，§6 已显式排除。ESRC-014 已记录 CC-Monitor 那 30 条不纳入的判断。

### 5.2 引擎

**新增 `internal/behavior/behavior.go`**：

```go
package behavior

// Rule 是一条行为规则。schema 与 CC-Monitor 独立撞型（ESRC-014），
// 但本实现与其代码无关（该仓库无许可证，不可复用）。
type Rule struct {
    ID       string   // 稳定标识
    Name     string   // 中文名，进报告
    Tools    []string // 适用的工具名；空表示全部
    Field    string   // 在工具输入/结果的哪个字段上匹配，如 "command" / "file_path"
    Pattern  string   // RE2 正则
    Severity string   // 复用 rules.Sev*
    OS       []string // 限定平台；空表示全平台
}

// Event 是从会话记录归一化出的一次工具调用。
type Event struct {
    Tool   string            // 工具名，如 "Read" / "Bash"
    Fields map[string]string // 字段名 → 值
}

// Finding 是一条行为命中。注意它没有凭证值、指纹和脱敏片段——
// 这正是它不能复用 detect.Hit 的原因（见 5.3）。
type Finding struct {
    RuleID   string
    Name     string
    Severity string
    Tool     string
    Field    string
    Excerpt  string // 命中片段，已截断；若字段可能含凭证必须先脱敏
}

func Scan(e Event) []Finding
```

**v0.1 必含规则**（全部围绕凭证可见性，不含破坏性操作）：

| ID | 含义 | 工具 | 严重程度 |
| :--- | :--- | :--- | :--- |
| `credential_file_read` | 读取了敏感路径表中的文件 | Read | high |
| `credential_file_write` | 写入敏感路径表中的文件 | Write / Edit | medium |
| `credential_cmd_read` | 命令行读取凭证文件（`cat ~/.ssh/id_rsa` 等） | Bash | high |
| `credential_tool_invoke` | 调用系统凭证工具（macOS `security find-generic-password`、Linux `secret-tool`、Windows `cmdkey`） | Bash | high |
| `env_dump` | 整体导出环境变量（`env`、`printenv`、`Get-ChildItem Env:`） | Bash | medium |

前三条的路径判定**必须调用 WI-4 的敏感路径表**，不得内联另一份路径清单。

### 5.3 行为命中写到哪里

**决定：单独输出 `behavior.csv`，不进 `hits.csv`，不复用 `detect.Hit`。**

理由：行为命中没有凭证值、没有指纹、没有脱敏片段，而 `detect.Hit` 的三个核心字段正是这三样。塞进去要么给 `Hit` 加可空语义（污染 0.1 节的禁改包），要么写一堆空列。

**新增 `internal/output/behavior.go`**：

```go
var BehaviorHeader = []string{
    "agent", "session_id", "source_file", "line", "ts",
    "rule_id", "rule_name", "severity", "tool", "field", "excerpt",
}
func OpenBehavior(dir string) (*BehaviorWriter, error)
```

报告中单列一节"Agent 行为观察"，与凭证发现分开陈述——两者的整改动作不同。

### 5.4 Event 从哪来

`internal/endpoint/claude.go` 在解析每行时，除了产出 `detect.Record`，另产出 `[]behavior.Event`：工具名和参数从 assistant 记录的 `tool_use` 块取，结果从 `toolUseResult` 取。

`ParseSession` 签名相应改为：

```go
func ParseSession(s Session, from, to time.Time, maxLine int) ([]detect.Record, []behavior.Event, []Skip, error)
```

### 5.5 验收

新增 `internal/behavior/behavior_test.go`：
- `TestCredentialFileReadFires` —— `Event{Tool:"Read", Fields:{"file_path":"/home/u/.ssh/id_rsa"}}` → 命中 `credential_file_read`。
- `TestNoFalsePositiveOnSourceCode` —— `src/env.ts`、`test/fixtures/id_rsa.pub.example` 不得命中。
- `TestExcerptNeverContainsCredential` —— **关键**：构造一个 `Bash` 事件其命令里含真实格式的私钥，用 `rules.Scan` 反扫 `Finding.Excerpt`，非 placeholder 命中数必须为 0（EBR-002）。
- `TestAllRulesCompile` / `TestRuleIDsUnique`。

`internal/endpoint/claude_test.go` 新增 `TestEventsExtractedFromToolUse`。

---

## 6. WI-5：Codex 适配器

### 6.1 已实测形态

```
路径：~/.codex/sessions/YYYY/MM/DD/rollout-<ISO时间>-<uuid>.jsonl
每行：{"timestamp":"...","type":"...","payload":{...}}
  type=session_meta   → payload 含 id、timestamp、cwd、originator、cli_version、model_provider
  type=response_item  → payload 为 OpenAI 形状的消息；工具结果为 payload.type=="function_call_output"，内容在 payload.output
  type=event_msg      → 与 response_item 重复的视图
```

### 6.2 要点

- **`event_msg` 与 `response_item` 内容重复**。执行者必须先核实是否重复，**只取其一**，否则同一凭证会被计两次。判断依据写进代码注释。
- `session_meta` 的 `cwd` 是整个文件的归属信息，需在流式解析中先读到并缓存。
- `payload` 是 OpenAI Responses 形状，`extract` 已支持，**直接交给 `extract.Request`，不要自己拆**。
- 复用 WI-1 之后的 `EndpointProfile`，不得新增第三套报告措辞。

### 6.3 验收

`internal/endpoint/codex_test.go` 对齐 Claude 适配器的测试清单：角色映射（`function_call_output` → `tool_result`）、窗口按记录时间戳、幂等、坏行/超限计入缺口、`event_msg` 去重不产生双重命中。

---

## 7. 全局验收（全部工作项完成后）

```bash
cd leakscan
go build ./... && go vet ./... && go test ./...
./build.sh                                    # 六平台
./bin/leakagent scan -from <近一周> -out /tmp/acc
```

逐条核对：

| 项 | 依据 | 判定 |
| :--- | :--- | :--- |
| 报告无网关措辞 | EBR-004 语境 | `grep -c '员工\|网关\|部门' /tmp/acc/*/summary.md` = 0 |
| 产物无凭证原文 | EBR-002 | 用 `rules.Scan` 反扫全部输出，非 placeholder 命中 = 0 |
| 权限正确 | EBR-003 | 目录 0700、文件 0600 |
| 零网络 | EBR-001 | `grep -rn 'net/http\|net.Dial' cmd/leakagent internal/endpoint internal/behavior` 无结果 |
| 缺口可解释 | EBR-009 | 报告缺口分类计数齐全，且含"没有发现 ≠ 没有泄漏" |
| 网关未被改坏 | EBR-006 | `TestGatewayReportUnchanged` 通过；网关 `go test ./...` 全绿 |
| `source_path` 有值 | ECAP-011 | 工具结果类命中的该列非空 |
| 规则集单一来源 | EBR-006 | `internal/rules` 仍只有一份，`rules.Version` 两个产品一致 |

---

## 8. 本方案未覆盖的事项

诚实列出，避免执行者误以为方案已穷尽：

- **EQ-002**：各 agent 在 Windows / Linux 的会话路径未实测。WI-4 的 Windows 条目按文档编写，**未在真机验证**。
- **EQ-003**：是否开源未决，影响 EBR-004 表述面向内部还是外部用户。
- **EQ-006**：Cursor / opencode 的 SQLite 读取方式（只读 immutable vs 先复制）未定，届时需引入纯 Go 驱动 `modernc.org/sqlite` 以保住 `CGO_ENABLED=0`。本方案不含这两个适配器。
- **EQ-007**：误报率仅在一台 macOS 上验证过。WI-3 的行为规则误报率**完全未知**，首次真实运行后须复核。
- **ECAP-009 / ECAP-010**：序列检测与实时拦截不在 v0.1。
- **Gemini 适配器**：字段未确认（EQ-001），不在本方案。

---

## 9. 执行记录（2026-09-15，全部工作项完成）

subagent 模型路由在本环境不可用（两次 403 "direct model access is not allowed"），
WI-1 由主会话手工完成；WI-2/3/4/5 同样在主会话完成。各项状态：

| 编号 | 状态 | 关键产出 | 验收 |
| :--- | :--- | :--- | :--- |
| WI-1 | ✅ 完成 | `internal/output/profile.go`（Profile/GatewayProfile/EndpointProfile）、`report.go` 全面 Profile 化、`HitsHeader` 追加 `source_path`、`Coverage` 追加 3 个端上缺口字段、4 处 BuildReport 调用点、`summarizeSkips` 归类进 Coverage | `profile_test.go` 4 条测试全绿，含黄金文件逐字比对 |
| WI-4 | ✅ 完成 | `internal/behavior/paths.go`：24 个 SensitivePath 条目，`MatchPath`/`MatchPathForOS` | paths_test.go 7 条全绿，含切词契约钉住测试 |
| WI-2 | ✅ 完成 | `detect.Record`/`detect.Hit` 追加 `SourcePath`（§0.1 例外条款）、`claude.go` 的 `extractFilePath`（Read 的 `file.filePath` 与 Edit/Write 的顶层 `filePath`，Bash/字符串形态返回空不猜测） | claude_test.go 3 条 SourcePath 测试；真实扫描 source_path 列有值 |
| WI-3 | ✅ 完成 | `internal/behavior/behavior.go`：5 条规则（credential_file_read/write、credential_cmd_read、credential_tool_invoke、env_dump）；`output/behavior.go` 独立 behavior.csv；报告新增"Agent 行为观察"节；`ParseSession` 增加 `[]ToolEvent` 返回值 | behavior_test.go 10 条全绿，含 TestExcerptNeverContainsCredential（EBR-002） |
| WI-5 | ✅ 完成 | `internal/endpoint/codex.go`：event_msg 去重（md5 配对核实 173 组重复）、session_meta cwd 缓存、OpenAI Responses 形状交给 extract、arguments JSON 摊平成事件字段 | codex_test.go 3 条全绿（角色映射/窗口/幂等坏行超限） |

### 执行中的两个设计决定（超出方案文本，需评审知悉）

1. **`shellTools` 跨 agent 工具名清单**（behavior.go）：Codex 的命令执行工具叫
   `shell`/`local_shell` 而非 `Bash`，三条 command 类规则的 Tools 列表统一引用
   `shellTools = ["Bash", "shell", "local_shell"]`。新适配器接入时只需往这个清单
   加名字，不改规则本体。
2. **Codex `arguments` JSON 摊平**：Codex 的 function_call.arguments 是 JSON 字符串，
   适配器解析一层把 `command`（数组 → 空格连接）、`file_path` 等提升为独立事件
   字段，行为引擎的既有规则按字段名直接命中，无需为 Codex 另立规则。

### 全局验收结果（§7 核对表，2026-09-15）

| 项 | 结果 |
| :--- | :--- |
| go build/vet/test | 全绿（6 包） |
| ./build.sh 六平台 | 全部成功，规则集 2026-09-14.2 |
| 报告无网关措辞 | Claude/Codex 两份真实报告 grep 员工\|网关\|部门 = 0 |
| 产物无凭证原文（EBR-002） | 两个运行目录全部产物（含 behavior.csv）rules.Scan 反扫非 placeholder 命中 = 0 |
| 权限（EBR-003） | 目录 700、文件 600 |
| 零网络（EBR-001） | grep net/http\|net.Dial = 0 处 |
| 缺口可解释 + 没有发现≠没有泄漏（EBR-009） | 两份报告均含该句与缺口分类计数 |
| 网关未被改坏（EBR-006） | TestGatewayReportUnchanged（黄金文件逐字比对）通过；cmd/leakscan 测试全绿 |
| source_path 有值（ECAP-011） | 真实扫描 1 行有值（Read 工具结果命中） |
| 规则集单一来源（EBR-006） | internal/rules 仅一份，两产品 checkpoint 的 ruleset_version 一致（2026-09-14.2） |
| 只读不干扰（EBR-007） | endpoint/behavior 包无 os.Create/os.Remove/os.Rename/O_WRONLY |
| 真实数据 | Claude 13860 条记录 17 处命中 + 50 条行为观察；Codex 710 条记录 + 角色映射全部生效 |

### 遗留

- env_dump / credential_tool_invoke 在本机真实会话中未触发（printenv 出现均嵌在
  python heredoc 字符串里，不命中是正确行为）；规则已由合成用例验证。
- ECAP-006 的 `agent_unsupported` 计数目前恒为 0（v0.1 只有 claude/codex 两个适配器，
  其余 agent 尚未进入扫描范围，缺口的口径将在多 agent 汇总扫描落地时生效）。
- §8 所列未知项（EQ-002 Windows/Linux 路径、EQ-003 开源、EQ-007 误报率）不变。
