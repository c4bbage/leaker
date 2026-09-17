<!-- xflow:context:start -->
> 自动生成，请勿手动编辑。修改 Flow 配置后执行 `xflow sync` 更新。

## 关于 xflow（本项目的开发方式）

本项目使用 **xflow** 开发——一套**规范驱动开发（SDD, Specification-Driven Development）**框架：写代码前先把「需求 → 设计 → 研究」逐阶段固化为结构化制品，并用人工审批门禁保证质量与可追溯。

- **工作方式**：需求沿一串 `xf-<node>` 命令推进（见下方「流程」/「节点导航」），每个节点产出规定的设计制品（spec / hld / design / task…）。**设计先行、研究先行**——技术不确定项当场用研究解决，不留到实现阶段。
- **框架与数据分离**：`.xflow/`（模板 + 脚本，只读，随仓库分发）与 `xspec/`（项目数据，读写，运行时生成）。
- **阶段推进由脚本把关**：每个命令入口先跑 `xf-enter-node.mjs` 做「结构 / phase / 门禁」三关校验，通过后自动推进 phase；未过即终止并给诊断——agent 不绕过、不跳步。
- **门禁 = 人工审批点**：带门禁的节点完成后需用户 `xflow approve`（或 Web 审核）才能进入下游，agent 不能自行审批。

> 你的职责：按当前节点的命令正文产出制品、跑完成后验证；**「下一步做什么」以下方「节点导航」表为准，不要自行编造流程或跳步**。

## 流程

```
xf-constitution → xf-product → xf-split → xf-brainstorm (gate) → xf-clarify (gate) → xf-design → xf-detail (gate) → xf-task → xf-implement → xf-archive
```

流程外辅助命令：`xf-analyze`、`xf-explore`、`xf-fix`、`xf-roadmap`、`xf-status`。

> 注：`xf-brainstorm` 与 `xf-clarify` 是**二选一的替代入口**，任选其一完成并通过审批即可进入 `xf-design`，**无需两者都做**。

## 节点导航（回答「下一个节点」以此表为准）

> 本流程是依赖图（DAG）而非单链：一个节点可能有多个前置或多个后继。**判断「下一步」时以下表的「前置 / 后继」列为准，不要用上面那条 `→` 直线去推断。**

| 节点 | 前置（需先完成） | 完成后可进入 | 门禁 |
| :--- | :--- | :--- | :--- |
| `xf-constitution` | （入口） | `xf-product` | — |
| `xf-product` | `xf-constitution` | `xf-split` | — |
| `xf-split` | `xf-product` | `xf-brainstorm`、`xf-clarify` | — |
| `xf-brainstorm` | `xf-split` | `xf-design` | ✋ 完成后需人工审批 |
| `xf-clarify` | `xf-split` | `xf-design` | ✋ 完成后需人工审批 |
| `xf-design` | `xf-brainstorm` 或 `xf-clarify`（二选一，任一通过即可） | `xf-detail` | — |
| `xf-detail` | `xf-design` | `xf-task` | ✋ 完成后需人工审批 |
| `xf-task` | `xf-detail` | `xf-implement` | — |
| `xf-implement` | `xf-task` | `xf-archive` | — |
| `xf-archive` | `xf-implement` | （终点） | — |

## 核心架构

框架脚本和数据**分离**：

| 目录 | 定位 | 性质 |
| :--- | :--- | :--- |
| `.xflow/` | 框架（模板 + 脚本） | **只读**，随仓库分发 |
| `xspec/xf/` | 项目数据（模块 + 变更 + 归档） | **读写**，运行时生成 |

> **名称辨析（重要）**：本项目使用的 SDD 开发流程是 **边锋sdd开发流程**——`.xflow/xf/Flow.yaml` 里的 `name` / `displayName` / `description` 描述的是**这套开发流程本身**，**不是**你正在开发的业务项目。写 `constitution.md` / `PRODUCT.md` 等制品时，项目名应来自项目自身（`package.json` 的 name、`README` 标题、项目根目录名）或询问用户，**切勿**把流程名（如「边锋sdd开发流程」）当作项目名。

## 目录结构

```
.xflow/                        # 框架（模板 + 脚本），只读
└── xf/               # 本 flow 的模板与脚本资源

xspec/xf/                    # 项目数据（读写，运行时生成）
├── constitution.md           # 项目宪章（xf-constitution 产出）
├── PRODUCT.md                # 产品定位 + 模块结构 + 依赖（xf-product 产出）
├── changes/                   # 当前活跃变更（同时只允许一个）
│   ├── change.yaml           # 变更元数据（id / phase / scope / affected_modules）
│   ├── .gates/               # 门禁审批记录（仅 xflow approve 写，agent 禁写）
│   ├── integration.md        # 跨模块协调视图（xf-task 产出）
│   └── <module>/             # 每个受影响模块的设计制品
│       └── spec.md / hld.md / design.md / data-model.md / contracts.md / task.md …
├── modules/                   # Source of Truth（归档后固化，hook 保护禁止 agent 直写）
│   └── <module>/             # 各模块最新稳定状态
└── archive/                   # 历史变更快照（hook 保护）
    └── <change-id>/          # 每次归档保留 changes/ 完整副本
```

> 每个模块**具体生成哪些制品由 `module_type` 决定**，SSOT 是 `templates/CATALOG.yaml`；用 `node .xflow/scripts/xf-manifest.mjs --module-type <type> --phase <phase>` 查询，**不要硬编码文件名**。所有设计制品一律写在 `xspec/xf/changes/<module>/` 下。

## 辅助脚本

### xf-current-change.mjs — 活跃变更状态查询

```bash
node .xflow/scripts/xf-current-change.mjs --field active   # → true / false
node .xflow/scripts/xf-current-change.mjs --field phase    # → xf-constitution / ...
```

### xf-check-invariants.mjs — 结构合法性校验

```bash
node .xflow/scripts/xf-check-invariants.mjs
# 退出码：0=合法，2=违规，1=脚本错误
```

### xf-check-phase.mjs — Phase 入口校验

```bash
node .xflow/scripts/xf-check-phase.mjs --command <command>
# 退出码：0=合法，2=违规，1=脚本错误
```

### xf-manifest.mjs — 模块文件清单查询

```bash
node .xflow/scripts/xf-manifest.mjs --module-type <type> --phase <phase>
node .xflow/scripts/xf-manifest.mjs --list-types
```

模板类型映射 SSOT：`templates/CATALOG.yaml`。自定义模块类型未在 CATALOG.yaml 注册时自动回退到 `_default` 通用模板。什么时候用：任何阶段需要知道「某 module_type 该生成/读取哪些文件」时先查它，**禁止硬编码文件清单**。

### xf-deps.mjs — 任务依赖关系查询

```bash
node .xflow/scripts/xf-deps.mjs --module <module>            # 模块的跨模块出/入站依赖全景
node .xflow/scripts/xf-deps.mjs --task <TNNN> --module <module>   # 单任务上下游链路
```

什么时候用：`xf-task` / `xf-analyze` / `xf-implement` 阶段核对跨模块依赖（`depends: TNNN@module`）是否完整、有无悬空引用或反向依赖，比逐个翻 task.md 更不易遗漏。

### xf-gate.mjs — 阶段门禁检查

```bash
node .xflow/scripts/xf-gate.mjs --to <target-stage>
# 退出码：0=通过，2=未通过，1=脚本错误
```

## 阶段门禁

`xf-brainstorm` 完成后设置人工审批门禁，确保 AI 不能跳过人工审查直接推进到 `xf-design`：
`xf-clarify` 完成后设置人工审批门禁，确保 AI 不能跳过人工审查直接推进到 `xf-design`：
`xf-detail` 完成后设置人工审批门禁，确保 AI 不能跳过人工审查直接推进到 `xf-task`：

门禁流程：
1. 门禁节点完成后，生成 gate-report
2. 由**用户**在终端执行 `xflow approve <节点名>`（本地直接通过）；或点击门禁脚本输出的 Web 审核链接在 Web 端通过。两者等价。
3. agent **禁止**自行执行 `xflow approve`，只能等待用户审批通过后继续下一个节点

**禁令（不可违反）：**
- **禁止** 直接创建、修改或删除 `xspec/xf/changes/.gates/` 下的任何文件
- **禁止** 执行 `xflow approve` 命令
- **禁止** 向用户提供手动创建、修改 `.gates/` 文件的命令或方法
- **禁止** 在门禁未通过时搜索、读取、分析 `.gates/` 目录或门禁脚本源码来试图理解或绕过机制
- 门禁检查未通过时 **必须立即终止当前命令**，仅输出固定提示：

```
⛔ 门禁未通过：<脚本返回的 reason 原文>

请在终端执行：xflow approve
审批通过后重新执行当前命令。
```

## 产出自检

在每个人工门禁之前，AI 必须先执行产出自检（`xf-validate.mjs` 脚本检查 + 语义检查），确保输出符合模板结构和 xflow 规范。

自检时间点：
- **`xf-brainstorm` 完成后**：执行 `--phase xf-brainstorm` 检查，通过后提示人工审批
- **`xf-clarify` 完成后**：执行 `--phase xf-clarify` 检查，通过后提示人工审批
- **`xf-detail` 完成后**：执行 `--phase xf-detail` 检查，通过后提示人工审批

**禁令（不可违反）：**

- **禁止** 修改 `.xflow/validate-rules.yaml` 文件
- **禁止** 跳过自检步骤直接输出完成报告
- **禁止** 在自检未通过时仍报告“全部通过”

## 设计阶段研究规则

xflow 的核心原则是**设计先行、研究先行**——在写一行代码之前消除技术不确定性。

**禁令（不可违反）：**

- 在 `xf-constitution` / `xf-product` / `xf-split` / `xf-brainstorm` / `xf-clarify` / `xf-design` / `xf-detail` 阶段，**禁止**将技术不确定项标记为「待研究」「TODO」「留到实现阶段再确认」等任何形式的延迟处理
- 发现技术不确定项时，**必须**自主调用 `xf-research` subagent 当场研究解决，**不得询问用户**「是否需要研究」
- 研究结论必须回写到设计制品中，不能只存在于 research.md 而设计文档仍留空

## 活跃变更保护

xflow 同一时间只允许一个活跃变更：`xspec/xf/changes/` 下只装一份 `change.yaml` + 它声明的 `affected_modules` 子目录。

**禁令（不可违反）：**

- **禁止**在 `change.yaml` 已存在且 `status ≠ archived` 时直接覆写它开新变更。任何新变更必须先归档当前变更
- **禁止**把过期 `change.yaml` 重命名为 `change-XXX.yaml` 等"备份"——`changes` 根目录的 yaml 必须叫且只叫 `change.yaml`
- **禁止**在 `xspec/xf/changes/{module}/` 下创建未在 `change.yaml.affected_modules` 中声明的模块目录
- **禁止**手动创建或保留 `ARCHIVE.md`
- **禁止**在结构校验或 phase 入口校验报错时绕过或"先做一部分"。校验失败必须立即终止，把诊断报告原样输出给用户
- **禁止**在 `phase ∈ {xf-brainstorm, xf-clarify, xf-design, xf-detail, xf-task, xf-implement, xf-archive}` 时把"新模块"并入当前 `affected_modules`。新模块属于新需求，应当：先归档当前变更，再开新变更

**写操作前必读**：准备写入变更文件之前，先调用：

```bash
node .xflow/scripts/xf-current-change.mjs --field active
node .xflow/scripts/xf-current-change.mjs --field phase
```

- `active=false` → 可以正常开启新变更
- `active=true` 且 `phase ∈ {xf-constitution, xf-product, xf-split}` → 同一变更内的迭代是允许的
- `active=true` 且 `phase ∈ {xf-brainstorm, xf-clarify, xf-design, xf-detail, xf-task, xf-implement, xf-archive}` → **禁止**直接开新变更，必须先归档

## phase 字段（由脚本管理，agent 禁止手改）

`change.yaml` 的 `phase` **只由 `xf-enter-node.mjs` 在进入节点时自动写入**：每个 `xf-<node>` 命令开头都会先跑它，通过结构 / phase / 门禁三关后，把 `phase` 置为当前节点。

- **推进阶段 = 运行对应的 `xf-<node>` 命令**，phase 由脚本自动同步；agent **无需、也禁止**手动编辑 `change.yaml` 的 `phase` 字段。
- 若发现「下游产物已存在但 phase 未同步」之类的不一致：**不要**手改 phase 去"对齐"，也**不要**把「同步 phase 字段」当作可执行的下一步。正确做法是直接运行目标节点命令（脚本会在校验通过后写入正确 phase），或把不一致如实报告给用户由其决定。
- 「手动改 phase 绕过校验」「替用户同步 phase」都是**明确禁止**的反模式。

## Source of Truth 保护

xflow 通过 IDE 插件 hook 实时拦截 agent 对受保护路径的写入。

### 受保护路径

| 路径 | 含义 | 白名单 | 合法写入路径 |
| :--- | :--- | :--- | :--- |
| `xspec/xf/modules/` | Source of Truth | 项目级文档（以 protect plugin 白名单为准） | 仅 `xf-archive.mjs` 等专用脚本写入；agent 任何 phase 都不能直接写 |
| `xspec/xf/archive/` | 历史变更快照 | 无 | 仅 `xf-archive.mjs` 通过脚本写入 |
| `xspec/xf/changes/.gates/` | 门禁审批记录 | 无 | 仅用户在终端执行 `xflow approve` 写入 |

**禁令（不可违反）：**

- **禁止**用 Write/Edit/MultiEdit/StrReplace/apply_patch 直接修改受保护路径下的文件（白名单除外）。任何 phase 下都拦——包括最后一个归档节点
- **禁止**用 bash/Shell 工具绕过
- **禁止**以任何形式向用户建议"禁用保护 / 豁免拦截 / 绕过 hook"等绕开 xflow 流程的捷径

**正确处理被拦截后的反馈：**

- `phase ∈ {xf-constitution, xf-product, xf-split, xf-brainstorm, xf-clarify, xf-design, xf-detail, xf-task, xf-implement}` → 把写入重定向到 `xspec/xf/changes/{module}/{file}` 或 `xspec/xf/changes/{module}/{file}.delta.md`
- `phase = xf-archive` → 把拦截消息完整告诉用户让用户决定
- 无活跃变更 → 先从 `xf-constitution` 创建变更

## 交互规则

**核心原则：与用户交互时，优先让用户「点选」而非「输入文字」。**

**强制要求：凡需要用户做选择时，必须直接调用平台内置的交互工具（tool call），让平台渲染选择 UI，禁止在文本消息中罗列选项让用户手动输入，也禁止用 bash/脚本模拟此功能。各平台内置工具名：Cursor → `AskQuestion`，Claude Code → `AskUserQuestion`，OpenCode → `question`（均为直接 tool call，不是 shell 命令）。**

需要用户做决策时：

1. **能自主决策的不要问用户**：如果已有足够上下文（宪章、技术约束、历史约定）指向唯一合理方案，直接采用并说明理由，不发起询问。
2. **用选项代替填空**：将所有需要用户回答的问题转化为 2–4 个具体选项，每项一句话说清含义——**禁止**让用户面对空白输入框自由发挥。
3. **标明推荐项**：在选项中注明哪个是推荐选择，并用 1–2 句说明推荐理由。
4. **包含最小化选项**：始终提供一个「跳过 / 维持现状 / 最简路径」的选项，降低决策成本。
5. **必须直接 tool call 平台内置选择控件**：Cursor 调用 `AskQuestion`，Claude Code 调用 `AskUserQuestion`，OpenCode 调用 `question`。这三个都是平台内置的 tool call，不是脚本或 shell 命令——禁止尝试用 bash、node 脚本或任何外部程序模拟。若当前平台工具不可用，退回到在消息中以编号列表呈现选项并要求用户回复编号，但不得直接让用户输入任意文本。

**例外**：收集用户「自有信息」时（如「你的产品解决什么问题」）可自然提问，不强套选项格式。
<!-- xflow:context:end -->
