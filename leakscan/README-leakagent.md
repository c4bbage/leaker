# leakagent：端上编码 agent 凭证泄漏自查

扫描**你自己电脑上**编码 agent 落盘的会话记录，检查 agent 有没有把 SSH 密钥、VPN 配置、云密钥、GitLab 令牌等发给大模型。结果只写到本地文件，**不联网**。

产品文档：`../xspec/xf/v2-endpoint/PRODUCT.md`。与同仓库的 `leakscan`（网关侧）是**两个产品**，共享同一套识别规则（EBR-006），但二进制分开：`leakagent` 里不含任何数据库代码。

## 为什么要有它

`leakscan` 看的是网关流量，看不到员工绕开网关、直接用外部中转站的情况（网关产品 Q-007）。而编码 agent 把完整会话写在本地磁盘上——不管它连的是内部网关、厂商官方 API 还是某个中转站。读这些本地文件，就能回答网关回答不了的问题。

## 先读：边界与安全

- **不上报**：不做任何网络请求，没有遥测、上报、版本检查、规则更新（EBR-001）。结果只在本机。
- **只读**：不修改、移动或删除任何 agent 的会话文件（EBR-007）。
- **报告本身是敏感数据**：含凭证脱敏片段和本机路径。输出目录 0700、文件 0600；不要提交仓库，也不要放共享盘（EBR-003）。
- **不保存凭证原文**：只记类型、HMAC 指纹和脱敏片段（EBR-002）。
- **指纹密钥不与 `leakscan` 共用**：默认在 `~/.leakagent/hmac.key`。端上二进制会分发到很多机器，共用密钥会让持有者能穷举猜测值比对指纹（EBR-005）。
- **谁运行、谁看报告，决定了它是不是员工监控**（EBR-004）：
  - 开发者在自己机器上跑、自己看报告 → **不构成员工监控**，无需告知批准。
  - IT 统一下发并回收报告 → 监控足迹与网关侧等同甚至更大（覆盖全部仓库含私人项目），**必须按公司制度完成告知与批准**。

## 使用

```bash
go build -o bin/leakagent ./cmd/leakagent

# 必须指定窗口：本机历史会话可能有几个 GB
bin/leakagent scan -from 2026-09-01
bin/leakagent scan -from 2026-09-01 -to 2026-09-14
```

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-from` | 必填 | 窗口起点，支持 `2026-09-01`、`2026-09-01 08:00`、RFC3339 |
| `-to` | 现在 | 窗口终点 |
| `-root` | `~/.claude/projects` | 会话产物根目录 |
| `-out` | `out` | 输出根目录，每次扫描新建子目录 |
| `-max-line` | 8MiB | 单行上限，超过则跳过并计入缺口 |
| `-hmac-key` | `~/.leakagent/hmac.key` | 指纹密钥 |

输出与 `leakscan` 同构：`summary.md`、`findings.csv`、`hits.csv`、`coverage.json`。

## 支持的 agent

| Agent | 状态 |
| --- | --- |
| Claude Code | ✅ `~/.claude/projects/**/*.jsonl` |
| Codex | 计划中 `~/.codex/sessions/**/rollout-*.jsonl` |
| Cursor | 计划中 `~/.cursor/chats/**/store.db`（SQLite，blob 为明文 JSON） |
| opencode | 计划中 `~/.local/share/opencode/storage/part/**` |
| Gemini | 未定，字段待确认 |

**没有发现 ≠ 没有泄漏。** 不支持的 agent、解析失败的记录、超限的行都计入报告的覆盖缺口。

## 来源角色

判断该找谁整改，看 `roles` 列：

- `tool_result` —— **agent 自动读出来的**（读文件、执行命令）。既要轮换凭证，也要收紧 agent 的读取范围。Claude Code 的这部分在 transcript 的顶层 `toolUseResult` 字段，不在 `message` 里。
- `user_input` —— 你自己粘贴的。
- `model_output` —— 模型吐出来的，通常指向上游或网关侧密钥被套出。

## 已知限制

- **报告措辞仍是网关侧的**：`summary.md` 现在会写"网关凭证泄漏回溯审计报告""员工姓名""Key 关闭日志"，这些在端上语境不成立。报告生成器目前由两个产品共用，端上专用措辞尚未实现。
- **明细列按端上语义复用了网关的列名**，对照表：

  | hits.csv 列 | 端上含义 |
  | --- | --- |
  | `table` | agent 名（`claude`） |
  | `request_id` | `会话文件相对路径:行号` |
  | `key_id` | 会话 ID |
  | `key_name` | **会话文件相对路径** |
  | `user_name` | 该次会话的工作目录 `cwd` |
  | `model` | git 分支 |
  | `user_agent` | Claude Code 版本 |
  | `key_type` | `sidechain` 表示子 agent 会话 |

  专用的 `source_path` 列是否要加，见 PRODUCT 的 EQ-008。
- **误报率未经充分验证**。首次真实数据扫描已修掉一类误报（全遮盖字符的口令，如 `postgres://user:***@host`），但样本只有一台机器。
- **只在 macOS 上实测过**。Windows / Linux 的路径尚未核实（EQ-002）。
- **不支持续扫**，中断后需重新扫描。
- **只做内容检测**：不检测"agent 读了凭证文件"这类行为，也不做事件序列关联，都在 v0.2（EQ-004 已定）。

## 测试

```bash
go test ./internal/endpoint/
```

覆盖：`toolUseResult` 必须归为 `tool_result` 角色而非 `user_input`（整改对象不同）、assistant 内容归 `model_output`、窗口按每条记录时间戳过滤、重复扫描结果一致、坏行与超限行计入缺口不中断扫描。
