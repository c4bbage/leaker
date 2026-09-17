---
name: xflow-relationship-graph
description: 当任务需要关系追踪、覆盖检查、依赖分析、断链检查、影响范围或跨模块证据时，选择并执行 Relationship Graph 能力
---

# Relationship Graph

## 核心原则

- Markdown（spec/design/task）是业务事实源
- `xspec/xf/relationship-index.json` 是可重建派生索引
- 禁止 Agent 手工创建或修改 `relationship-index.json`
- Relationship CLI（`xf-relations.mjs`）提供机器事实，Agent 结合源 Markdown 解释
- `module.yaml` 的 `relationship.coverage` 是 Archive 管理的生命周期状态；字段缺失按 `partial` 读取
- `complete` 只表示已按获批证据完成历史 Relationship 迁移覆盖，不表示程序证明业务图绝对完整

## Progressive coverage 语义

- schema 1 / `unknown` 返回 `known_graph_only` 且要求 rebuild；`partial` 返回 `known_graph_only`；`complete` 在 `build_mode=node` 且节点为 `xf-design` / `xf-task` 的生命周期过渡 snapshot 中也返回 `known_graph_only`；只有 `complete` + `manual` / `xf-implement` / `xf-archive` 返回 `relationship_snapshot`。
- `known_graph_only` 返回的是已知边和影响下界；missing focus 只能解释为未覆盖或未记录，不得断言对应业务对象或关系不存在。
- `partial` 下未触及的 legacy AC 没有 FR 时以 `LEGACY_GAP` 可见且非阻断；本 Change 新增或覆盖的 AC 没有 FR 必须报错；baseline 中此前已被 FR 引用的 AC 若在本 Change 后丢失全部 FR 引用，必须以 `baseline_reference_regression` 报错（旧债已还不能重新欠）；`complete` 模块中未被 FR 引用的 AC 必须报错。
- 已存在的 bounded legacy AC identity（例如 `AC-RBAC-01`）可以被新 FR 的 `acs:` 引用；新发 AC 仍只允许 canonical ID。
- 只要 FR/DS 在 Modules baseline 或当前 Active Change 中已经拥有正式 identity，修改时必须复用该真实 ID，并禁止再次 `next-id`；只有全新对象，或旧 prose 首次 Relationship 纳管且尚无正式 identity，才调用 `next-id`，不得自行扫描、猜号或复用历史 removed ID。当前 Change 已写入的新 identity 会参与下一次 `next-id` 的占号，但这只用于另一个新增 identity，不能给同一已存在对象重新发号。
- 正式 FR/DS 对象必须位于 Markdown 正文；fenced code block 是示例区，parser 会忽略，禁止把真实 identity 包在 fence 中。

## Coverage Transition Authority

- `partial` 模块的普通 Change 保持 `partial`；`complete` 模块的普通 Change 保持 `complete`，不得静默降级；`complete → partial` 不作为普通路径提供。没有显式 intent 时不得写 coverage。
- `partial → complete` 只允许在 `changes/relationship-migration.yaml` 所属的同一 Change 迁移审计上下文中，Relationship audit / evidence / approval receipt 与模块事实匹配、用户明确批准，并由 Archive 展示、核对、应用后发生。
- `changes/relationship-migration.yaml` 是 Relationship 自有 audit / evidence / approval receipt，随现有 finalize 归档；它不进入 module 目录，也不是全局状态库，不得把它描述成 Candidate 模块业务文件。
- Fresh `complete` 必须同时具有显式 `relationship_coverage_intent: complete` 与 `relationship_provenance.kind: relationship-aware-creation`；`change_type: added` 单独不构成 complete 证据。
- Archive 不得依据新增文件数、Graph 结果或 `change_type` 猜测 complete；既有 `complete` 也不得被普通 Change 静默降级。
- transition 校验失败时只拒绝 coverage 写入并报告原因；不得清空旧 coverage、回滚已完成的核心归档或伪造 approval。若用户尚未确认是否继续不带 transition 的归档，先暂停归档计划。

## 何时触发

- 用户直接询问关系、覆盖、依赖、断链、影响范围或跨模块关联
- 执行 `/xf-analyze`，或其他 XFlow 节点需要关系证据支撑判断
- Agent 在当前任务中发现需要确认 FR → DS → Task 追溯链
- 未触发以上场景时，不要仅因存在 Relationship Graph 就主动调用

## 五种能力

| 能力 | 命令 | 用途 | 何时使用 |
|---|---|---|---|
| build | `--action build` | 从当前 Markdown 全量重建索引 | 新的关系分析且本轮尚未确认索引新鲜度时 |
| validate | `--action validate` | 执行当前 V1/V2 已实现的机械规则：dangling、自依赖、Task cycle、DS cycle warning、Progressive `UNREFERENCED_AC` 分类等 | 辅助检查断链、覆盖或依赖；`valid=true` 不等于全部业务关系已机械证明完整 |
| query | `--action query --key <module/object-id>` | 查看直接 incoming/outgoing 关系 | 需要了解某对象的关系全景 |
| impact | `--action impact --key <module/object-id> [--depth N]` | 多跳影响范围分析 | 评估变更影响面 |
| next-id | `--action next-id --module <name> --type <fr|ds>` | 只读分配 module/type 历史安全编号 | 新建 FR/DS identity 前；修改已有 identity 时禁止调用 |

## 如何执行

1. 先判断当前问题需要哪种能力，不要默认连续调用全部 action。
2. 新的关系分析若本轮没有可信的最新 build，先执行一次 build；若阶段入口或本轮已经成功 build，直接复用。
3. 覆盖/断链问题选择 validate；直接关系选择 query；多跳影响选择 impact。
4. 对 Node 或可定位 finding，有 `source.file` 时必须回读对应 Markdown，再给出业务结论。
5. 同一轮分析复用已得到的索引与结果，不重复执行相同 action。
6. 创建多个新 identity 时，每次把前一个写入当前 Change 后再调用 next-id，确保同轮连续编号。

## Query / Impact 使用

- key 格式：`module/object-id`（如 `auth/FR-001`、`payment/DS-003`）
- `query` 返回直接关系：incoming（谁引用我）和 outgoing（我引用谁）
- `impact` 按双向关系遍历，默认深度 1；通过 `--depth` 扩大
- CLI 返回 JSON，Agent 对照 Markdown 事实源解释
- `known_graph_only` 下只陈述命中的已知边；必须显式保留“未知边可能尚未迁移”的限定

## Source 精读

- CLI 返回的 Node / 可定位 finding 在有 `source.file` 时，以其指向源 Markdown
- 有 `source.file` 时 **必须 Read 对应 Markdown 原文**，不得把 `relationship-index.json` 全文当分析入口
- 关系类型（acs/fr/ds/depends）由字段名决定，不由 CLI 解释

## 调用纪律

- `query` / `impact` **自身不自动触发 build**；是否先 build 由上述执行流程判断
- 已有结果直接复用，不重复调用相同 action
- `INDEX_NOT_FOUND` → 当前任务需要关系分析时先执行 build；无法 build 才明确报告索引缺失
- build 失败 → 明确报告失败原因，不伪造关系
- `@module` 只负责定位跨模块对象，不代表关系类型
- 不需要时不要机械连续调用所有 action
