---
description: 按 7 支柱 148 项检查做代码↔设计一致性深度审查；无参数全量、带支柱号单支柱、merge 汇总、update 状态同步（三态：⚪未修订/✅已修订/❌不需要修订；验证通过后自动翻转无需用户确认）
---

## 用户输入

```
$ARGUMENTS
```

---

对当前变更的代码做↔设计一致性深度审查。

**参数解析**（从 `$ARGUMENTS` 去首尾空白）：

| 输入 | 模式 | 流程 |
|:-----|:-----|:-----|
| （空） | **全量审查** | Phase A × 7（P1→P7 顺序）→ Phase B 汇总合并 |
| `P1`~`P7` 或支柱名 | **单支柱审查** (Phase A) | 只执行指定支柱，输出分报告 |
| `merge` | **汇总合并** (Phase B) | 合并 7 份分报告为主文档 unified（唯一 SSOT，保留） |
| `update` | **状态同步** (Phase D) | 批量扫描 ⚪ ISSUE，逐项判定已修复(✅)/不修订(❌)/未处理(⚪)，只更新主文档 unified |
| `update ISSUE-NN` | **状态同步** (Phase D) | 单项：验证指定 ISSUE，已修复→✅ / 不修订→❌ |
| `update R-NN` | **状态同步** (Phase D) | 单项：通过修复任务号定位 ISSUE，验证后翻转 ⚪→✅ |
| `update wontfix ISSUE-NN` | **状态同步** (Phase D) | 单项：判定指定 ISSUE 为不修订，翻转 ⚪→❌（须选定类别+依据） |

> 单支柱名映射（输入别名 → 支柱号 / 分报告 slug）：
> - `P1`/`sdd`/`traceability` → P1 / `sdd-traceability`
> - `P2`/`memory` → P2 / `memory-safety`
> - `P3`/`error` → P3 / `error-control`
> - `P4`/`structure` → P4 / `structure-complexity`
> - `P5`/`convention` → P5 / `conventions`
> - `P6`/`testing`/`comptime` → P6 / `comptime-testing`
> - `P7`/`zig`/`compliance`/`dep`/`compat` → P7 / `dependency-compat`

---

## 步骤 0：确定变更范围

1. 读取当前变更：
   ```bash
   node .xflow/scripts/xf-current-change.mjs --field active
   node .xflow/scripts/xf-current-change.mjs --field id
   node .xflow/scripts/xf-current-change.mjs --field phase
   ```
   若 `active=false`，终止并提示用户先创建变更。

2. 读取 `xspec/xf/changes/change.yaml`，取 `id`（如 `CHG-20260730-001`，记为 `$CID`）、`name`（记为变更名称）和 `modules[]`（记为受审模块列表）。

3. **生成变更 Slug `$CHANGE_SLUG`**（用于所有输出文件名前缀，替代旧版 `chg<N>` 短号——短号会循环复用导致无法区分不同变更）：

   **生成规则**：
   1. 取 `change.yaml` 的 `name` 字段值
   2. 将所有非 `[a-zA-Z0-9]` 字符（含中文字符、空格、标点）替换为 `-`
   3. 转为小写
   4. 合并连续多个 `-` 为单个 `-`
   5. 去除首尾 `-`
   6. 若长度 > 50，在最后一个不超过 50 的 `-` 处截断；若无 `-` 则硬截断
   7. **回退**：若结果为空（name 纯非 ASCII），取 `id` 去掉 `CHG-` 前缀（如 `20260730-001`）

   **示例**：
   | name | → `$CHANGE_SLUG` |
   |:-----|:-----------------|
   | `012-agent-engine新增 + 006/005增强` | `012-agent-engine-006-005` |
   | `006-tool-system 工具系统` | `006-tool-system` |
   | `011-memory-context` | `011-memory-context` |
   | `CHG-4: parseSseData 所有权修复（005-llm-provider）` | `chg-4-parsessedata-005-llm-provider` |
   | `需求澄清`（纯非 ASCII） | `20260730-001`（回退到 id） |

   > **强制校验（不可跳过）**：生成后必须确认 `$CHANGE_SLUG` 与 `change.yaml` 的 `name` 语义对应——**禁止使用 `chg<N>` 短号**（如 `chg1`、`chg5`）。凡 `docs/analyze/review/` 下文件名以 `chg[0-9]+-review` 或 `chg[0-9]+-audit` 开头者即视为用了旧短号，须按上述规则改用 name 生成的新 slug。若 `$CHANGE_SLUG` 已含 `chg`、或与 name 明显无对应关系，须重新生成后再继续。

4. 对每个模块，按 `action`（added/modified）确定文档范围：
   - **added**：读 `changes/<mod>/` 全套产物（spec → hld → design → data-model → contracts → task）
   - **modified**：读 `changes/<mod>/*.delta.md` + `modules/<mod>/` 基线全文
   - 用 `node .xflow/scripts/xf-manifest.mjs --module-type <type> --all-phases --change-type <added|modified>` 获取完整文件清单

5. 建立受审源文件清单：glob `src/**/*.zig` 中属于受审模块的文件（参考 `PRODUCT.md` 模块→源文件映射）。

6. **读取审查规范**：`.opencode/skills/sdd-zig-review/SKILL.md`（§0 SSOT 拓扑、§0.1 支柱注册表 148 项、§1 定级/记录/报告结构、§2 CI 映射、§3.1 执行模式+按需加载路由表）。**各模式按 SKILL.md §3.1 路由表追加读取子文件**——支柱检查项在 `pillars/`（7 文件），Phase B 专属在 `workflow/phase-b.md`，Phase D 专属在 `workflow/phase-d.md`，不默认全载。

7. **历史文件归位**（执行 `$ROUND` 扫描前必须先完成）：扫描 `docs/analyze/` 顶层是否存在本变更的分报告文件 `<$CHANGE_SLUG>-review-<slug>-r*.md`（排除 `*-review-unified-r*.md` 主文档）。若发现顶层有分报告，**立即将其移动到 `docs/analyze/review/`**——这消除历史遗留导致 AI 跟随错误路径写入顶层的「先例污染」。归位后再进入步骤 8。

8. **确定审查轮次 `$ROUND`**：扫描 `docs/analyze/review/` 目录下已存在的 `<$CHANGE_SLUG>-review-*-r*.md` 分报告文件，取最大 r 值 +1 作为本轮轮次号。
   - 例：`$CHANGE_SLUG` = `012-agent-engine-006-005`，已有 `012-agent-engine-006-005-review-memory-safety-r1.md`、`012-agent-engine-006-005-review-dependency-compat-r1.md` → 本轮 `$ROUND = 2`
   - 无已有文件 → `$ROUND = 1`
   - `$ROUND` 用于所有输出文件命名，避免与历史审查产物冲突
   - **Phase D（update 模式）例外**：扫描 `docs/analyze/` 目录下已存在的 `<$CHANGE_SLUG>-review-unified-r*.md` 主文档，取最大 r 值**本身**（不加 1），因为 Phase D 原地更新已有轮次文件，不产生新文件、不开新轮次

9. **输出目录约定**（硬约束——所有写入操作必须遵守）：

   | 产物类型 | 输出目录 | 文件名模式 |
   |:---------|:---------|:----------|
   | 7 份分报告（Phase A 各支柱） | `docs/analyze/review/` | `<$CHANGE_SLUG>-review-<slug>-r<R>.md` |
   | 主文档 unified（Phase B 输出） | `docs/analyze/` | `<$CHANGE_SLUG>-review-unified-r<R>.md` |

   > **禁止将分报告写入 `docs/analyze/`**——分报告只进 `docs/analyze/review/`，主文档只进 `docs/analyze/`。两者的区别：分报告是逐支柱检查证据（7 份），主文档是汇总签收的唯一 SSOT（1 份）。

---

## Phase A：单支柱审查

> **执行流程**：按 SKILL.md §3.2 Phase A 工作流执行（A.1 定位受审范围 → A.2 读必读文档 → A.3 加载 checklist 逐条检查 → A.4 记录与输出 → A.5 验证）。
>
> **检查项来源**：SKILL.md §0.1 支柱注册表 → 按 §3.1 路由表 Read 对应 `pillars/p<X>-*.md` 文件（含检查项数与详细检查清单）。
>
> **关键要求**（摘自 SKILL.md §3.2）：
> - 每处问题按 §1.2「问题记录模板」记录，分报告内编号用 `P<支柱号>-<序号>`
> - 输出至 `docs/analyze/review/<$CHANGE_SLUG>-review-<slug>-r<R>.md`，结构见 SKILL.md §3.2 A.4 分报告模板
> - frontmatter 必须含 `change_id`/`pillar`/`slug`/`review_round`/`supersedes`/`status:done`/`date`/`issues_found`
> - 全量模式下按 P1→P7→P2→P3→P4→P5→P6 顺序执行（P1 必须首行，P7 建议第二）
> - P4 执行前须先按 `pillars/p4-structure-complexity.md` §8.4.1「重复扫描方法论」做系统化扫描
>
> **验证**：`zig build && zig build test`（确认问题描述引用的代码行准确）。**全量模式下审查期间代码不变，build+test 只需在 Phase A 开始前执行一次，不逐支柱重复**；单支柱模式则该支柱完成后执行一次。

---

## Phase B：汇总合并

> **前置**：7 份分报告（`docs/analyze/review/<$CHANGE_SLUG>-review-*-r<R>.md`）均已存在且 `status: done`。若缺失，提示先执行对应支柱。`<R>` 与步骤 0.8 确定的 `$ROUND` 一致。
>
> **执行流程**：Read `.opencode/skills/sdd-zig-review/workflow/phase-b.md` 按其 §3.3 全流程执行（B.1 确认完整性 → B.2 去重合并 → B.3 统一编号 → B.4 交叉检查〔§1.3 十种跨支柱组合〕 → B.5 依赖建模/冲突判定/拓扑分层〔§1.5〕 → B.5.5 子批划分〔§1.5.1，规模控制〕 → B.6 输出统一报告 → B.7 验证）。
>
> **输出**：`docs/analyze/<$CHANGE_SLUG>-review-unified-r<R>.md`，按 `templates/report-template.md` §A 主文档模板填充。
>
> **验证**：`zig build && zig build test && zig fmt && node .xflow/scripts/xf-validate.mjs --node xf-implement`

---

## Phase D：状态同步

> **前置**：Phase B 已完成（`unified` 主文档存在）。
> **触发时机**：ISSUE 修复完成后——不绑定特定 xflow 阶段。无论修复发生在 `xf-analyze`（文档修订）还是 `xf-implement`（代码修复）阶段，均应执行 Phase D 同步状态。
> **自动翻转**：验证/判定通过后，直接翻转状态并更新统计，无需用户二次确认。

> **执行流程**：Read `.opencode/skills/sdd-zig-review/workflow/phase-d.md` 按其 §3.5 全流程执行（D.1 定位目标文档 → D.2 确定待更新集合 → D.3 验证/判定〔路径 A 代码修复 / 路径 B 文档修复 / 路径 C 不修订〕 → D.4 翻转状态+更新统计 → D.5 验证）。

### D.1 定位目标文档

1. 执行**步骤 0**（确定变更范围 + 生成 `$CHANGE_SLUG` + 确定 `$ROUND`）
2. 确认主文档 `docs/analyze/<$CHANGE_SLUG>-review-unified-r<R>.md` 存在（状态唯一权威）
3. 若缺失 → 终止并提示用户先执行 `review-code merge`（主文档）

### D.2 确定待更新 ISSUE 集合与翻转目标

| 输入 | 待处理集合 | 翻转目标 |
|:-----|:----------|:---------|
| `update`（无参数） | 主文档 §2 所有 ⚪ ISSUE（逐项判定：已修复→✅，不修订→❌，未处理→保持⚪） | ✅ 或 ❌ |
| `update ISSUE-NN` | 仅该 ISSUE（若已是 ✅/❌ → 提示已完成，跳过） | ✅ 或 ❌ |
| `update R-NN` | 在主文档 §4 修复任务清单表中查找 R-NN 对应的 ISSUE-NN | ✅ |
| `update wontfix ISSUE-NN` | 仅该 ISSUE（明确判定不修订） | ❌ |

### D.3 逐项验证或判定

> 三条验证路径（A 代码修复 / B 文档修复 / C 不修订判决）及 wontfix 四类别（误报/可接受风险/设计豁免/超纲）的完整定义见 `workflow/phase-d.md` §3.5 D.3。**核心约束：不允许仅凭"已改/不想改"就翻转状态——必须按路径执行对应验证/判定。**

**构建验证**（路径 A 代码修复需执行，全量执行一次即可，不逐 ISSUE 重复）：
```bash
zig build && zig build test
```
构建或测试失败 → **所有代码修复 ISSUE 状态不予翻转**，报告失败原因后终止（文档修复 ISSUE 不受影响）

### D.4 翻转状态并更新统计（单写主文档）

对验证通过（✅）或判定通过（❌）的 ISSUE，**只更新主文档 unified**。

**⚪→✅（已修订）**——主文档（`<$CHANGE_SLUG>-review-unified-r<R>.md`）更新项：
1. §2 表格「状态」列：⚪ → ✅
2. frontmatter `resolved_issues` +1，`open_issues` −1
3. §1 执行摘要行：`✅ <N> / ⚪ <N> / ❌ <N>` 更新数值
4. §8 签收表「解决状态」行：更新数值

**⚪→❌（不需要修订）**——主文档更新项：
1. §2 表格「状态」列：⚪ → ❌ +「不修订理由」列填 `<类别> <依据>`
2. §2.5 不修订判定表新增一行（ISSUE / 类别 / 依据）
3. frontmatter `wontfix_issues` +1，`open_issues` −1
4. §1 执行摘要行 + §8 签收表：更新数值

> §4 任务清单（排程视图）不修改。

### D.5 输出状态同步报告

```
📊 状态同步完成

处理结果：
  待处理 ISSUE：<N> 项
  ✅ 验证通过（翻转 ⚪→✅）：<N> 项
  ❌ 判定通过（翻转 ⚪→❌）：<N> 项
  ⚪ 未通过（保持 ⚪）：<N> 项

已更新文件：
  - docs/analyze/<$CHANGE_SLUG>-review-unified-r<R>.md（frontmatter + §1 + §2 + §2.5 + §8）

当前进度：
  ✅ 已修订：<resolved_issues> / <unique_issues>
  ⚪ 未修订：<open_issues> / <unique_issues>
  ❌ 不需要修订：<wontfix_issues> / <unique_issues>
```

未通过的 ISSUE 逐项列出原因（代码未改/语义仍不满足/build 失败/不修订依据不充分）。
❌ 判定通过的 ISSUE 列出类别+依据摘要。

### D.6 验证

1. 确认主文档 `resolved_issues` + `open_issues` + `wontfix_issues` = `unique_issues`
2. 确认翻转的 ISSUE 状态已更新至主文档 §2「状态」列，frontmatter 统计同步
3. 确认 ❌ 状态的 ISSUE 在主文档 §2 行 + §2.5 表均有「不修订理由+类别」依据
4. 确认 §4 任务清单（排程视图）未被改动（无状态列）

---

## 关键约束

> **完整约束清单**见 SKILL.md §3.6。以下为命令执行层高频约束的速查（完整定义以 SKILL.md §3.6 为准）：
>
> - **文件名前缀**：`<$CHANGE_SLUG>-` 前缀，严格按步骤 0.3 由 `change.yaml` 的 `name` 生成，禁止 `chg<N>` 短号
> - **输出语言**：所有面向用户的文本中文（代码标识 / Zig API / Blocker/Major/Minor / ISSUE-NN / P#-NN / 命令参数除外）
> - **Phase D 状态翻转**：三态（⚪/✅/❌）验证通过后自动翻转；翻转规则详见 `workflow/phase-d.md` §3.5

## 项目硬指标速查

体积≤10MB / 冷启动<50ms / RSS≤64MB / `max_turns≥50` / 退化超10%须审批
