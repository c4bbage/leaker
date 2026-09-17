# 实现对照核验记录（独立）

文件性质：`xf-implement-v2`（2.2.0）独立核验报告。本命令只核对代码与测试证据，没有修改 `leakscan/` 代码或任何正式制品，也不代替原 `/xf-implement` 的实施流程。

## 1. 审查范围与版本

### 1.1 上游基线（2026-09-11 读取）

| 文件 | SHA-256 | 状态 |
| :--- | :--- | :--- |
| [PRODUCT.md](./PRODUCT.md) | `e2cbea1c5840e8ef2ab4b25a86402897aa1f1146e8f72d52073571c0a664097c` | 与 architecture 引用一致 |
| [architecture.md](./architecture.md) | `4913c9643299ebdaf117cf7c70b1671e56be45a75fa1c35cc1ed502e7486e353` | 与 architecture-review 受检摘要一致，基线有效 |
| [architecture-review.md](./architecture-review.md) | `55e4c044cd763a7c750ea221091c4d93a43985d040cdfeb5ba63b2b860346d21` | D01 失败（无需求输入） |
| [split-review.md](./split-review.md) | `1aa8a8adafdc65c79e68f398bbcb3a0f8979fd7225a9cae121867d46b1cf0c01` | 1.2 未重跑 S 检查（FB-008） |
| [feedback.md](./feedback.md)（本轮更新前） | `650ac76603129e8bd1a13b87890e79fa63bb985d9b793153f854a5cc4b5b8eb1` | 本轮已更新 FB-006，新增 FB-009～011 |
| `requirements.md` / `exploration.md` / `detail.md` / `tasks.md` | 不存在 | 没有 REQ、EX、JOB 可核对 |

**核验对象的选择**：没有 detail 和 tasks，因此没有 JOB；没有需求入口，因此没有 EX。本轮核对 architecture 中**已声明为已实现**的 DES-001～DES-010，以及 §7 的回放 RP-01～RP-15；DES-011（持续扫描）为候选且未实现，不在核验范围。结论只限于这些 DES / RP，不代表阶段 1a 或产品整体验收。

### 1.2 代码版本

`leakscan/` 不是 git 仓库，没有 HEAD。以文件摘要定位（核验开始时计算，核验期间未改动）：

| 文件 | SHA-256 |
| :--- | :--- |
| `main.go` | `cee8d860461bbbf051aebe5d3036e6735fe83acb021c1d653823fdb221f31451` |
| `internal/detect/detect.go` | `f10a62cca914d034defd014f89faa3342368fe88660c085f83bef67de0eeab6f` |
| `internal/detect/detect_test.go` | `1ad0b3b5c71edb09dbb7133b1e8369d5fcfa304613b24c188f6c377f544619a9` |
| `internal/extract/extract.go` | `cd72fbf0d8f364ce87935e8b61ffd0d094b20d25d2117a6ad67dc196030b1f17` |
| `internal/output/output.go` | `a1bc1490d074389ae46d1d55b03aa90638b2454be63692e38b22e35f4d637a01` |
| `internal/output/report.go` | `017cb7bd2e76f9be60cb2f0817b42a06319a03ba96b7cd6c91c72aa7389df3fc` |
| `internal/rules/rules.go` | `89b01e6201b34b5eda0fc2a1ed9b6fe1c9aac0ca4264f103a90f881fc76d90f0` |
| `internal/rules/rules_test.go` | `624d03a9d1979faecd01775e548556bdea99a712adc1f296a227a059bc299c61` |
| `internal/rules/structured.go` | `0d440ab2dd529e326f944445272996fa15629c9465402a290f31111de31aeb2d` |
| `internal/store/db.go` | `f5842b713e8c96e80bdcdbeebb6550cd8cbea63ab7de0d06f9e1a49166172df9` |
| `internal/store/probe.go` | `831fdf897d4fcd6cfbdac0093d44696da9d2960c64f517834d4b48d0d965420c` |
| `internal/testfixture/fixture.go` | `1e1d3f80450da9ffc220014f272b5806d907a3be79f873c8726159c20669dc29` |
| `e2e/run.sh` | `d9b93cd73cf45cfc1c7b7d35720a32ca76800897c458b4891e406abce5af8d00` |
| `e2e/seed/main.go` | `b4e1651691a668d4d5e1ac52af115b130fbfe76b5a23df8c6655e0c2ad64db9e` |
| `e2e/verify/main.go` | `94d37ddcbafce2d497f893521ef10726d752fd99b5196991d1c809b5f27e8f24` |
| `go.mod` / `go.sum` | `f0972665…16b29` / `a5e7a8db…e69` |

17 个文件摘要清单整体的 SHA-256：`3d1200cbf8a39380dbb5825e11efde52adec27e8058549eebe7a1cb207e2edb6`。审查范围只包括上述文件，不涉及网关源码（本机没有）。

### 1.3 运行环境与安全前提

- macOS 26.5.1（Darwin arm64），go1.26.1，Docker 29.4.0，镜像 `postgres:17-alpine`（`sha256:18cfe3ef5e68…`）。
- 所有数据库连接都是 `127.0.0.1` 上临时启动的容器（端口 55432 / 55433 / 55434），结束后删除。表结构取自 SRC-008，数据为 `e2e/seed` 生成的合成凭证（seed 只允许连本机）。没有连接任何生产库或副本，没有迁移或删除真实数据。
- 复现脚本放在会话临时目录（`iv.sh`、`iv2.sh`），只调用编译出的 `leakscan` 二进制，没有修改源码。

## 2. 实际运行的命令与结果

| # | 命令 | 退出码 | 结果 |
| :--- | :--- | :--- | :--- |
| R1 | `go vet ./...` | 0 | 无输出 |
| R2 | `go test -count=1 ./...`（另以 `-v` 运行一次查看用例） | 0 | `internal/detect` 8 个用例、`internal/rules` 5 个用例全部 PASS |
| R3 | `./e2e/run.sh /Users/cgy/Downloads/llm_gateway_prod_schema.sql` | 0 | `[通过]` 36 条，`[失败]` 0 条，末行"E2E 通过" |
| R4 | `iv.sh`：完整扫描基线（两表，3031 + 304 条记录，另插入 1 条顶层为字符串 / 数组的记录） | 0 | 见 RP-10、FB-010 |
| R5 | `iv.sh`：hits.csv 末尾追加残缺行后 `leakscan report` | 1 | "读取 hits.csv：parse error on line 17, column 53: extraneous or missing \" in quoted-field" |
| R6 | `iv.sh`：把断点的 `ruleset_version` 改为 `1999-01-01.0` 后 `-resume` | 1 | "断点的规则集版本 1999-01-01.0 与当前 2026-09-11.1 不同，不能续扫，请重新扫描" |
| R7 | `iv2.sh`：窗口只含张三 3 次调用，`-batch 1` 基线 | 0 | SSH 私钥 hits 3 行、1 个指纹；发现 1 个，调用次数 3 |
| R8 | `iv2.sh`：`-batch 1 -sleep 1500ms` 运行，第 1 批断点落盘后立即复制断点快照（断点 `req-000001`，覆盖 1 行）；运行结束后用快照覆盖断点，再 `-resume` | 0 / 0 | 续扫后 hits 5 行，不同 `(request_id, 指纹)` 3 个，**重复 2 行**；覆盖行数 3、有命中记录 3（与基线一致）；发现 1 个，调用次数 3（与基线一致） |
| R9 | `iv2.sh`：用密钥 K1 扫第 1 条后 SIGINT，用密钥 K2 `-resume` | 0 / 0 | 无任何提示；SSH 私钥出现 2 个指纹；**发现拆成 2 个**（调用次数 2 与 1） |

`iv.sh` 中第一次尝试的 RP-06 复现无效（快照时断点已越过全部泄漏记录，续扫无重复），因此改用 `iv2.sh` 的窄窗口逐条方式（R8）。R8 的状态与"刷明细后、写断点前进程被杀"完全等价：断点是运行中真实保存的，明细比断点多出后续批次。

## 3. 代码与设计对应

结论取值：**已验证**＝代码行为与 DES 一致且有实际运行证据；**发现差异**＝运行或代码证据表明与 DES 不符；**未验证**＝没有运行证据或依赖不可取得的外部条件。

| DES / RP | 代码位置及内容摘要 | 测试位置 / 实际命令 | 实际结果与环境 | 尚缺证据 / 反例 | 结论 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| DES-001 单个命令行 | `main.go`：子命令 probe / scan / report | R2、R3 | 构建与三个子命令都在 e2e 中执行 | — | 已验证（合成数据） |
| DES-002 只读接入与负载控制 | `internal/store/db.go:34–45` 设置 `default_transaction_read_only=on`、`statement_timeout`、`idle_in_transaction_session_timeout=60000` 并用 `SHOW` 校验；`:64–98` 键集分页 `(ts, request_id) > ($3,$4) ORDER BY ts, request_id LIMIT`；`pg_column_size` 超限不取回 | R3（`e2e/run.sh:57–60` 只读账号 `DELETE` 失败）；R3"大小上限"步骤 | 只读账号不能写；超限提示出现在 summary | 执行计划（`EXPLAIN`）未看；负载影响、自适应让路没有实现也未测（RP-15，设计已标缺口） | 已验证：只读与超限跳过。未验证：负载 |
| DES-003 来源角色拆分 | `internal/extract/extract.go`：按 role / 块 type 切换角色；`Headers`（`:262` 起）对认证头只设 `AuthPresent` / `AuthLooksUnmasked` | `detect_test.go` 8 个用例（R2）；e2e 第 79–81、101 行（R3） | 全部通过；认证头问题作为系统性问题报告，不产生员工命中 | 真实网关请求体结构未知 | 已验证（合成数据） |
| DES-004 识别引擎 | `internal/rules/rules.go`（关键字预筛 + RE2）、`structured.go`（PEM、OpenVPN、WireGuard、成对云密钥等） | `rules_test.go` 5 个用例，含 `TestAdversarialInputLinear`（0.11s）（R2） | 通过 | 真实误报率；附录 A 差异（FB-002、FB-003） | 已验证（合成数据） |
| DES-005 凭证身份与指纹 | `detect.go:108` `HMAC(key, m.Value)`；`RunState`（`output.go:178–190`）**不记录密钥身份**；续扫只校验规则集版本（`main.go:168`） | R7、R9 | R9：换密钥续扫被接受，同一私钥拆成两个发现 | "规范化方案归类型"是设计候选，未实现，不核验 | **发现差异**：architecture §2.1 规定扫描运行包含指纹密钥，实现未强制 → FB-009（实现缺陷） |
| DES-006 记录 / 位置 / 命中身份 | `report.go:111–116` 按 `user_id`（或 Key）× 指纹聚合，`Requests` 为 `request_id` 集合；覆盖统计 `RecordsWithHits` 按表计（`output.go:167`） | R3（e2e 第 73–75 行）；R4 | 张三 SSH 私钥 hits 6 行（两表各 3），发现调用次数 3，表 `call_logs;call_traces`；`records_with_hits` call_logs 10、call_traces 4 | — | 已验证：发现层按 `request_id` 去重。**与 architecture 描述不符**：两表同内容 e2e 早已覆盖，设计稿低估了证据 → FB-011（设计文档修正） |
| DES-007 提交点 | `main.go:300–314` 先写明细、`Flush`（`output.go` 中 `Sync`）、再 `SaveState`；`output.go:52–59` 续扫追加打开；`output.go:199–210` 临时文件无 `fsync`；无目录锁 | R3（正常中断续扫一致）；R5；R6；R8 | 正常 SIGINT 续扫与完整扫描一致；断点落后时重复 2 行明细；残缺行使 report 退出码 1；版本不一致被拒绝 | 写明细失败时覆盖统计重复计数（代码审读，未复现）；多进程并发（未测） | **发现差异**：FB-006 已复现，属实现缺陷；设计的修复方案未实现。RP-13（版本拒绝）已验证 |
| DES-008 输出与原文边界 | `output.go:39–42` 目录 0700；各输出 `OpenFile(..., 0o600)`（`output.go:60`、`report.go:205、230`、`main.go:124`）；`sanitize`（`output.go:110–117`）；`main.go:196–198` 拒绝把密钥放在输出目录；`report.go` 过滤 placeholder 与第三层 | R3（e2e 第 117–140 行反扫输出、检查权限） | 全部输出文件反扫不到凭证原文，权限 0600 | `O_TRUNC` 打开已存在文件时不会收紧原有权限（例如之前留下的 0644 `probe.md`），未测；第三层口径待 FB-002 | 已验证（合成数据） |
| DES-009 本网关 Key 确认 | `detect.go:215–243`：只对 `llm_api_key_generic` 做 SHA-256（含去 `sk-` 变体）比对，标本人 / 他人、启用 / 停用；`store.LoadKeys` 只读 6 列 | `TestGatewayKeyConfirmation`（R2）；e2e 第 81 行（R3） | 通过 | 真实哈希方式（Q-016）；边界偏差（FB-004） | 已验证（合成数据，假定 SHA-256 无盐）；真实环境未验证 |
| DES-010 覆盖统计与报告 | `output.go:121–170` 计数：无内容、关闭日志、请求 / 响应解析失败、超限、认证头；`report.go` 覆盖节与超限提示；`extract.go:47–60` 只在 JSON 解码失败时置 `Parsed=false` | R3（e2e 第 99–104 行、"大小上限"步骤）；R4 | 关闭日志 20 条、超限提示均正确；插入顶层字符串 / 数组内容后，两个解析失败计数仍为 0 | "落库前已删除"无法计数（设计已标缺口） | **发现差异**：读库模式下内容是 `jsonb::text`，永远能解码，解析失败计数不可达；结构未识别的内容没有计数原因 → FB-010（设计需修订） |
| RP-01～RP-05、RP-07～RP-09、RP-14 | 同上各 DES | R3 | e2e 对应检查全部 `[通过]` | 合成数据 | 已验证（合成数据） |
| RP-06 | 见 DES-007 | R5、R8 | 复现成功 | — | 发现差异（FB-006） |
| RP-10 | 见 DES-006 | R3、R4 | 发现层去重成立；按表计数重复 | — | 已验证（结论成立；证据描述需修正，FB-011） |
| RP-11、RP-12 | `structured.go:49、165、173、214、292` 各规则自定取值 | 无 | 未运行 | 需改规则才能演示 RP-11；截断 PEM 未构造 | 未验证（代码审读结论维持，FB-005） |
| RP-13 | `main.go:168–169` | R6 | 拒绝续扫，退出码 1 | 没有自动化测试 | 已验证（手工复现） |
| RP-15 | 无自适应让路代码 | 无 | — | 设计已标缺口 | 未验证（缺口，非差异） |

## 4. 检查 I01–I05

[PASS] I01 — 未直接改生产代码或绕过实施流程
依据：§1.2 代码摘要在核验开始时计算，本轮只写 `implementation-review.md` 与 `feedback.md`；复现脚本位于会话临时目录，只调用二进制；§1.3 所有连接为本机临时容器。
判定：没有修改 `leakscan/`，没有调用生产控制面或正式阶段脚本。
影响/处理：需要的代码修复（FB-006、FB-009、FB-010）交原 `/xf-implement`。

[PASS] I02 — 核对实际行为，而非文件存在
依据：§3 表逐项引用代码行并给出运行结果，例如 DES-005「R9：换密钥续扫被接受，同一私钥拆成两个发现」、DES-010「插入顶层字符串 / 数组内容后，两个解析失败计数仍为 0」。
判定：差异都来自运行结果或读到的具体代码逻辑，不是按函数名推断。审查范围限定为 `leakscan/` 的 17 个文件，没有对网关或其他仓库下结论。没有 JOB / EX，核对对象为已声明实现的 DES 与 RP（§1.1 已说明）。
影响/处理：无。

[PASS] I03 — 区分测试定义、实际运行与外部集成
依据：§2 每条运行记录都有命令、退出码与实际输出；§3"尚缺证据"列列出未运行项（`EXPLAIN`、负载、多进程、写明细失败、RP-11 / RP-12）；§1.3 说明数据库是本机 `postgres:17-alpine` 容器与合成数据。
判定：所有"已验证"都限定为"合成数据"或"手工复现"；没有把本机 Postgres 结果当作网关生产库行为，没有把单次正常运行当作并发保证（多进程明确未测）。R8 的复现方式及其与真实崩溃的等价关系在 §2 说明，第一次无效尝试也如实记录。
影响/处理：无。

[PASS] I04 — 反例反馈到正确层次，未改文档掩盖缺陷
依据：FB-006、FB-009 → 实施流程（实现缺陷，设计已给出应有行为）；FB-010 → design（DES-010 所列计数原因在读库模式下不成立，是设计假设问题，不是代码写错）；FB-011 → design（设计稿低估证据）。architecture.md 摘要仍为 `4913c964…`，本轮未修改。
判定：区分了"代码不符合设计"和"设计假设不成立"两类，没有为了让结论变成已验证而改设计。
影响/处理：无。

[PASS] I05 — 未验证项不记为通过，结果可关联代码版本
依据：§3 中 DES-011、RP-11、RP-12、RP-15 标"未验证"；DES-002 负载、DES-009 真实环境拆开标注；§1.2 以文件摘要固定代码版本，§2 的运行发生在该版本上（核验期间未改文件）。
判定：局部核验没有被表述为阶段 1a 或产品验收。
影响/处理：无。

## 5. 检查 G01–G06

[PASS] G01 — 写入范围
依据：只写 `xspec/xf/v2/implementation-review.md`、`xspec/xf/v2/feedback.md`。
判定：未越界。
影响/处理：无。

[PASS] G02 — 范围、来源与上游摘要
依据：§1.1 列出上游摘要及缺失的 requirements / detail / tasks；核对了 architecture 摘要与其自检记录一致。
判定：输入缺失已声明，没有假造 JOB 或 EX；结论限定为已检查的 DES / RP。上游 D01 失败与 FB-008 未关闭仍然有效，这意味着本核验对照的是"候选设计"，不是经需求确认的设计。
影响：FB-001、FB-008 关闭后需要按新的 REQ / EX 重新映射本核验。
处理：无新增。

[PASS] G03 — ID 与链接
依据：新反馈编号 FB-009～FB-011 接续已有 FB-001～FB-008，没有重复；§3 引用的 DES、RP 都在 architecture.md 中存在；相对链接指向本目录已有文件。
判定：没有新造 JOB / EX / DES。
影响/处理：无。

[PASS] G04 — 反例登记
依据：R8 → FB-006（更新为已复现）；R9 → FB-009；R4 解析失败计数 → FB-010；DES-006 证据描述 → FB-011。
判定：本轮发现的差异全部登记；依赖它们的结论（续扫一致性、跨续扫的发现唯一性、解析失败覆盖统计）已标为发现差异，不再宣称已验证。
影响/处理：无。

[PASS] G05 — 证据真实
依据：§2 的命令、退出码和输出摘录；§1.2 代码摘要；环境版本。
判定：没有把测试定义当作运行结果。RP-11 / RP-12 维持"代码审读"性质，没有升级为已验证。
影响/处理：无。

[PASS] G06 — 方法适度、不越权决策
依据：只复现了与已声明 DES 相关的最小场景；没有替业务决定 FB-002（第三层口径）或 FB-004（边界细化）。
判定：未扩大范围，也没有重复询问已授权事项。
影响/处理：无。

## 6. 结论与交接

### 6.1 文档自检

I01–I05、G01–G06 全部通过。上游 architecture-review 的 D01 失败仍然有效。

### 6.2 业务确认

没有新的业务确认。FB-002（第三层是否计入发现）仍需在首次真实扫描前由安全负责人决定。

### 6.3 技术验证结论（仅限本机合成数据）

- **已验证**：DES-001、DES-002（只读、超限跳过）、DES-003、DES-004、DES-006（发现层去重）、DES-008、DES-009（假定 SHA-256）；RP-01～05、07～10、13、14。
- **发现差异**：
  - DES-005 / FB-009：续扫时换指纹密钥被接受，同一凭证拆成多个发现。实现缺陷。
  - DES-007 / FB-006：断点落后于明细时续扫产生重复行；残缺行使报告无法生成。实现缺陷，已复现。
  - DES-010 / FB-010：解析失败计数在读库模式下不可达，结构未识别的内容没有覆盖原因。设计需修订。
- **未验证**：负载影响与执行计划、多进程并发、写明细失败时的覆盖计数、RP-11、RP-12、DES-009 真实哈希方式、全部生产环境行为。

### 6.4 可交接给原 `/xf-implement` 的修复项

| 问题 | 文件位置 | 期望行为（来自 architecture） | 验证办法 |
| :--- | :--- | :--- | :--- |
| FB-009 续扫不校验指纹密钥 | `internal/output/output.go:178–190`（`RunState`）；`main.go:155–170`（加载密钥与续扫校验） | 断点记录密钥标识（不保存密钥本身），续扫密钥不同则拒绝 | 复用 R9：换密钥续扫应退出非 0 并提示 |
| FB-006 提交点 | `main.go:300–314`；`internal/output/output.go:52–75`（`OpenHits`）、`:199–210`（`SaveState`） | 断点记录明细已提交字节偏移，续扫先截断；临时断点文件 `fsync` 后再 `rename`；输出目录加锁；写明细失败时不保存未推进断点的覆盖增量 | 复用 R8：续扫后重复行为 0；R5 场景在截断后可生成报告；两个进程同时续扫时第二个被拒绝 |
| FB-010 覆盖原因 | `internal/extract/extract.go:47–60`；`internal/output/output.go:121–170` | 先由 design 修订 DES-010：统计"结构未识别（整段扫描）"一类原因 | 复用 R4 插入的记录：计数为 1 |
| FB-007 版本口径（本轮未变化，仍开放） | `internal/rules/rules.go:14`；`internal/output/report.go` 第三层过滤 | 区分规则集版本与输出 / 报告口径版本，两者写入断点与 summary | 修改脱敏或过滤后续扫应被拒绝或提示 |

**在修复前使用 leakscan 的注意事项**：续扫必须使用同一把 `-hmac-key`；非正常退出（强杀、断电）后重新完整扫描，不要续扫；报告中"解析失败 0"不代表请求体结构全部被识别。

### 6.5 正式流程关系

本独立核验完成不表示实施任务完成，也不表示任何正式阶段通过。核验对照的是 D01 失败、需求输入缺失的候选设计。
