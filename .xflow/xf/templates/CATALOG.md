# 模板目录索引（CATALOG）— 类型导读

> **用途**：供人阅读的「module_type 如何选型」指南。
>
> **机器 SSOT**：`CATALOG.yaml`（`module_type → 文件清单` 单一信源）
> **查询接口**：`node .xflow/scripts/xf-manifest.mjs --list-types` / `--module-type <type> [--phase <phase>]`
>
> 命令（split / design / detail / task 等）**不再**从本文件解析文件清单，全部通过 `xf-manifest.mjs` 动态查询。
> 新增或调整 `module_type` / 文件时，**只改 `CATALOG.yaml`**；本文件仅在类型定位或选型建议发生实质变化时同步更新。

---

## 一、已注册的 module_type 及其定位

### `web-backend`

Web 后端服务（REST API、分层架构、Controller / Service / Repository）。适用于 Go / Python / Java / Node.js 等有托管运行时的后端——Go / Python / Java 都归入此类型，开发模型相同，无需单独类型。

典型产物含 `contracts.md`（API 契约必有）。

### `web-frontend`

Web 前端界面（SPA / SSR、页面交互、组件体系）。React / Vue / Svelte / Solid 等声明式框架。

典型产物含 `contracts.md`（记录调用后端的 API 清单，与后端 `contracts.md` 双向对齐）。

### `native-app`

声明式 UI 原生 App：SwiftUI / Jetpack Compose / Flutter / React Native。

典型产物默认**不含** `contracts.md`：原生 App 的网络层通常通过后端模块的 `contracts.md` 定义；若本 App 存在独立对外协议（如自有 gRPC、蓝牙协议），可按需添加（此时 CATALOG.yaml 中 `contracts.md` 标记为 optional，在 detail 阶段由设计者判断是否生成）。

### `ai-agent`

AI Agent 架构（推理循环 + 工具调用 + 记忆管理）。含**专属** `evaluation.md`（Agent 评测方案：指标、数据集、通过阈值、离线评估流程），其他类型不生成。

> 若系统同时包含 HTTP 服务层和 Agent 推理层，应拆分为两个独立模块（`web-backend` + `ai-agent`），各自填写 `module_type`。

### `systems`

系统级后端（Zig / C / Rust），面向有**二进制体积 / RSS / 启动时间**硬约束或主动选择无 GC 运行时的场景。

典型产物**不含** `contracts.md`：系统模块的对外边界通常以二进制 ABI / IPC / 共享内存 / 序列化协议等形式存在，归入 `design.md` 描述；不需要独立的 REST/HTTP 契约文档。

> Go / Python / Java 属于 `web-backend`（托管运行时，开发模型相同），不是 `systems`。

### `_default`（通用兜底）

当用户指定的 `module_type` 未在 `CATALOG.yaml` 中注册时（如 `data-pipeline`、`infra`、`desktop-app`、`cli-tool` 等），`xf-manifest.mjs` 和 `xf-scaffold.mjs` 自动回退到 `_default`。通用模板提供类型无关的最小骨架（`spec` / `hld` / `design` / `task`；`data-model` 为 optional），确保任意模块类型都能正常走完工作流。

## 二、选型建议

| 如果你的模块…… | 建议类型 |
| :--- | :--- |
| 对外提供 HTTP/REST/RPC API，有托管运行时（Node / Go / Python / Java） | `web-backend` |
| 是浏览器端 SPA / SSR 前端 | `web-frontend` |
| 是手机端原生 App（iOS / Android / 跨端框架） | `native-app` |
| 围绕 LLM 推理循环、工具调用、记忆管理构建 | `ai-agent` |
| 用 Zig / C / Rust 编写，有体积 / RSS / 启动硬约束 | `systems` |
| 是数据管道、基础设施、CLI、桌面端等其他类型 | 自定义类型（自动走 `_default`） |

---

## 三、通用模板（跨模块 / 变更级 / 项目级）

下列模板存放于 `.xflow/templates/_shared/`，不归属于任何 `module_type`，由对应命令按需使用：

| 文档 | 使用场景 |
| :--- | :--- |
| `change.yaml` | 变更元数据（`/xf-brainstorm` 或 `/xf-clarify` 产出） |
| `research.md` | 技术研究索引（课题汇总 + 浅研究 inline，xf-research subagent 产出） |
| `research-full.md` | 单课题完整深度分析（≥3 方案或有 benchmark 时拆至 `research/` 子文件） |
| `brainstorm.md` | 头脑风暴记录 |
| `integration.md` | 跨模块协调视图（`/xf-task` 产出） |
| `changelog.md` | 变更归档记录 |
| `constitution.md` | 项目宪章 |
| `product.md` | 产品定位 |

---

## 四、新增 module_type 操作规则

1. **编辑 `CATALOG.yaml`（必做）**：新增顶层键，补全 `description` 和 `files` 映射（每个文件标注 `status` / `phase`）
2. **创建模板目录（可选）**：在 `.xflow/templates/<type>/` 下放置对应的 `.md` 模板文件——若未创建，`xf-manifest.mjs` 会自动回退到 `_default` 模板
3. **更新本文件（可选）**：如新类型有独特定位或选型建议，在 §一 / §二 中补充说明；纯文件清单差异**不需要**在此文件同步
4. 验证：`node .xflow/scripts/xf-manifest.mjs --module-type <新类型> --all-phases` 能正确返回期望的文件清单
5. 运行测试：`node --test .xflow/scripts/__tests__/xf-manifest.test.mjs`

> 原则：CATALOG.yaml 是机器消费的 SSOT；CATALOG.md 仅承载"人需要理解的语义"。凡文件清单、必有/按需/专属标记等"结构化信息"，一律只在 YAML 中维护，不在 MD 中重复。
