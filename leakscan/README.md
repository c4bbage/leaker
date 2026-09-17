# leakscan：网关凭证泄漏回溯扫描

只读扫描自建 LLM 网关数据库中已保存的调用记录，检查员工（及其编码 agent）有没有把 SSH 密钥、VPN 配置、阿里云密钥、GitLab 令牌等凭证发给大模型。结果存成本地 CSV 和 Markdown。

对应产品文档：`../xspec/xf/v2/PRODUCT.md`（CAP-002、003、009、012、015）。本版是**回溯审计**，不做实时通知，也不做阻断。

## 先读：边界与安全

- **只读**：连接时强制 `default_transaction_read_only=on` 并校验；另设语句超时、空闲事务超时；按时间窗口分批读取，批间休眠。仍然建议使用只授予 `SELECT` 的专用账号，最好连只读副本。
- **只能看到网关保存了的内容**：Key 关闭日志、内容为空的调用检测不到，报告第 1 节会列出这些缺口。**没有发现 ≠ 没有泄漏。**
- **看不到员工私用的外部中转站**：那需要出口代理、DNS 或终端侧手段。
- **输出本身是敏感数据**：里面有员工姓名和凭证脱敏片段（长值前 4 后 4；20 字符以内的短值只留前 2 位和长度）。输出目录权限 0700、文件 0600；不要提交仓库，也不要放共享盘。
- **不保存凭证原文**：同一凭证用带密钥的 HMAC 指纹去重。密钥默认在 `~/.leakscan/hmac.key`，多次扫描要用同一把密钥，指纹才能跨次比对。密钥文件不能放在输出目录里。
- **不会拿凭证去外部验证**，也不会把内容发给任何外部服务。
- **检查员工对话内容属于员工监控**：本工具产出的明细到人，使用前请确认已完成公司制度上的告知和批准（PRODUCT BR-004）。

## 准备只读账号

```sql
CREATE ROLE leakscan_ro LOGIN PASSWORD '***';
GRANT USAGE ON SCHEMA public TO leakscan_ro;
GRANT SELECT ON call_logs, call_traces, api_keys TO leakscan_ro;
```

`api_keys` 只读取 `id、user_id、name、key_hash、enabled、log_enabled`，不读取 `encrypted_key`。

## 使用

```bash
go build -o bin/leakscan ./cmd/leakscan
export LEAKSCAN_DSN='postgres://leakscan_ro:***@replica-host:5432/gateway?sslmode=require'

# 1. 先探查：确认网关实际保存了什么（只输出数量、字段名、大小分位，不输出内容）
bin/leakscan probe -from '2026-09-10 00:00' -to '2026-09-10 01:00' -out probe.md

# 2. 回溯扫描
bin/leakscan scan -from 2026-08-01 -to 2026-09-11 -batch 500 -sleep 200ms

# 中断（Ctrl+C）后从断点继续
bin/leakscan scan -resume out/20260911-150405

# 3. 修改或筛选 hits.csv 后重新生成汇总
bin/leakscan report -dir out/20260911-150405

# 扫描本地导出文件（不连数据库）：JSONL 或 JSONL.gz，每行一个请求体，如 {"messages":[...]}
bin/leakscan file -in sessions.jsonl.gz -out out/file
```

`file` 子命令与 `scan` 使用同一套解析和识别规则，输出同样的 `hits.csv`、`findings.csv`、`summary.md`。文件里没有员工、部门、客户端和时间，发现按"文件 × 凭证"汇总，"调用次数"是出现该凭证的行数；报告不含按部门、按客户端两节。单行超过 `-max-body` 计入超限，不是合法 JSON 的行计入解析失败。文件扫描不支持续扫，中断后需要重新扫描。

建议先对 1 小时窗口跑 `probe`，重点看：
- 第 1、2 节：内容字段是否真的写入，关闭日志的 Key 占比
- 第 3～6 节：请求体结构是否为 `messages` / `input` 等常见格式（不是的话需要调整解析）
- 第 7 节：**大小分位**。如果 P99 或最大值接近 `-max-body`（默认 8MiB），先调大再扫。超大的记录往往是带文件内容的长 agent 会话，正是私钥最可能出现的地方
- 第 8 节：**请求头里的 Authorization 是否未脱敏落库**。如果是，网关库本身就是一份全员 Key 清单
- 第 10 节：`call_logs.ts` 与实际写入时间的差值（以后做持续扫描时要用）
- 第 11 节：两张表是否重复保存同样的内容。如果重复，扫描 `-tables call_logs` 即可，读取量减半；`call_traces` 的请求头问题 probe 第 8 节已经给出
- 第 13 节：`key_hash` 是否为 64 位十六进制（决定能否确认"贴出的是本网关 Key"）

**不要一上来就扫几个月。** 建议的节奏：
1. 读取量估算：probe 第 1 节的记录数 × 第 7 节的平均大小 ≈ 本窗口要从库里读出的字节数。`-sleep` 限制的是批次频率，不限制字节量，大请求体多时要把 `-batch` 调小。
2. 先扫几个小时的窗口，看 `summary.md` 的"按类型"表：哪类命中数异常多、抽查 `hits.csv` 是否误报，必要时调整规则后再扩大窗口。
3. 再扫一天，观察副本负载，确认没问题后按周推进。

`scan` 的常用参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-from` / `-to` | 必填 / 现在 | 扫描窗口，支持 `2026-09-01`、`2026-09-01 08:00`、RFC3339 |
| `-tables` | `call_logs,call_traces` | 两张表都存了内容；`call_traces` 还有请求头 |
| `-batch` | 500 | 每批读取条数 |
| `-sleep` | 200ms | 批间休眠，给网关库让路 |
| `-workers` | CPU 核数 | 识别并发数（数据库读取始终单连接） |
| `-max-body` | 8388608（8MiB） | 单个内容字段超过该字节数（库内存储大小）则跳过，计入覆盖统计，并在报告开头醒目提示 |
| `-stmt-timeout` | 60s | 单条 SQL 超时 |
| `-hmac-key` | `~/.leakscan/hmac.key` | 指纹密钥 |

## 输出

每次扫描生成 `out/<时间戳>/`：

| 文件 | 内容 |
| --- | --- |
| `summary.md` | 报告：覆盖率与缺口、系统性问题（请求头认证信息落库）、按类型/部门/来源角色/客户端统计、高危发现列表 |
| `findings.csv` | 按"员工 × 凭证指纹"汇总：类型、严重程度、首次/最近调用、调用次数、来源角色、脱敏片段、同一凭证涉及人数 |
| `hits.csv` | 明细：每条调用记录 × 每个凭证一行，含 request_id，可回查 |
| `coverage.json` | 各表覆盖统计 |
| `checkpoint.json` | 扫描窗口、断点、覆盖统计 |

CSV 带 UTF-8 BOM，可以直接用 Excel 打开。`findings.csv` 由 `hits.csv` 计算得出，可以随时用 `report` 重算。

**来源角色**用来区分整改对象：`user_input` 是员工主动粘贴；`tool_result` 是编码 agent 读文件、执行命令后自动带出（整改 agent 的读取范围）；`model_output` 是模型把密钥吐了出来（通常指向网关侧或上游侧密钥被套出）。

## 识别范围

规则集版本见 `internal/rules/rules.go` 的 `Version`。

`huggingface_token`、`sendgrid_key`、`stripe_secret` 三条的**正则模式**取自 [kenn-io/agentsview](https://github.com/kenn-io/agentsview) 的 `internal/secrets/rules.go`（MIT，2026-09-14 读取）；关键字预筛、占位符判定、脱敏和严重程度沿用本包机制，未使用其 validate/mask 实现。

- **第一层（必含）**：SSH 私钥（OpenSSH/RSA/EC/PKCS8/PuTTY，含 JSON 转义形式和截断块）、OpenVPN 配置（静态密钥、内嵌证书密钥、auth-user-pass）、WireGuard 私钥与预共享密钥、IPsec PSK、阿里云 AccessKey（ID 与 Secret 成对为高危）、GitLab 各类令牌及 git 地址内嵌令牌
- **第二层**：AWS/腾讯云/华为云/GCP 密钥、GitHub 令牌、Kubernetes 凭证、数据库连接串、飞书/钉钉/企业微信/Slack Webhook、应用密钥、Telegram/Slack/Notion 令牌、Anthropic/OpenAI/Google API Key、npm/PyPI 令牌、Hugging Face 令牌、SendGrid Key、Stripe 生产密钥、通用私钥与 PGP 私钥、加密钱包私钥、URL 内嵌口令、sk- 格式 Key（若 `key_hash` 为 SHA-256 则确认是否为本网关 Key 以及是不是他人的）
- **第三层（低危，只进明细）**：JWT、配置中的口令字段。真实代码流量里这两类误报很多，不计入 `findings.csv` 和发现总数，报告只给出条数，需要时自己筛 `hits.csv`

降噪：文档示例、占位符（`xxxx`、`your_key`、`EXAMPLE` 等）和低熵值标为 `placeholder`，只保留在 `hits.csv`，不进入发现。所有正则都用 Go 标准库 `regexp`（RE2，线性时间），构造出来的恶意内容也不会让扫描卡死。

## 已知限制

- **误报率未经真实数据验证**。测试数据里的正常调用是合成的，真实编码流量中的示例配置、测试夹具、base64 大块都可能触发规则，第一次在真实库上跑务必按上面的节奏从小窗口开始。

- 请求体解析按 OpenAI Chat、OpenAI Responses、Anthropic Messages 通用遍历；遇到不认识的结构会退回按字符串扫描，不会漏扫，但来源角色可能归到 `request_other`。先用 `probe` 确认实际结构。
- 流式响应如果以 SSE 原文存成字符串，会拼接增量后再识别；如果网关只存了部分分块，可能漏检。
- 同一份 OpenVPN 配置可能产生两条发现（静态密钥、接入地址），属于有意为之。
- `call_traces` 按自身 `ts`（写入时刻）筛选窗口，归属信息取自同一 `request_id` 的 `call_logs`。
- 本版是按窗口回溯的一次性扫描。持续扫描需要解决"记录晚写入"的问题（PRODUCT Q-013），可以先看 `probe` 第 10 节的数据。
- OpenAI Privacy Filter 暂未接入。个人信息和格式不固定的凭证留到后续版本，接入前需要在内部中文样本上评估（PRODUCT Q-008）。

## 测试

```bash
go test ./...                                                   # 单元测试（合成凭证在运行时生成）
./e2e/run.sh /path/to/llm_gateway_prod_schema.sql               # 端到端：Docker Postgres + 你们的表结构 + 合成数据
KEEP=1 ./e2e/run.sh /path/to/llm_gateway_prod_schema.sql        # 保留输出以便查看
```

端到端测试核对以下几点：
- 预期的泄漏（agent 读取私钥、粘贴 AK/SK、git 地址令牌、VPN 配置、模型输出令牌、他人网关 Key）全部发现
- 同一私钥多轮对话只算一个发现；文档示例被排除
- 内容超过 `-max-body` 的记录在报告中醒目提示
- 关闭日志的调用计入覆盖缺口；请求头未脱敏被报告为系统性问题
- 中断后续扫的结果与一次跑完完全一致
- 所有输出文件用识别规则反扫，找不到任何凭证原文，文件权限为 0600
- 只读账号无法写入
