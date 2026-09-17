管理 `xspec/xf/ROADMAP.md` 和模块级 ROADMAP，支持版本发布、功能规划、历史归档、查看操作。

## 用户输入

```
$ARGUMENTS
```

**参数解析**：

- **无参数**：列出当前路线图摘要（等同于 `list`）
- **子步骤**：`release` / `plan` / `archive` / `simplify` / `list`（`archive` 支持 `--target` 三模式：version/matrix/changelog）

**参数表**：

| 参数 | 类型 | 必填 | 说明 |
|:---|:---|:---|:---|
| `--change` | string | release 时必填 | 变更编号（如 CHG-20260505-001） |
| `--bump` | string | release 时可选 | 版本号 bump 类型：`major` / `minor` / `patch`（默认 `patch`） |
| `--module` | string | 否 | 模块名（如 `004`、`004-aiderag-integration`），操作模块级 ROADMAP |
| `--add` | string | plan 时必填 | 功能标题 |
| `--pri` | string | plan 时必填 | P0 / P1 / P2 / P3（或 high/medium/low） |
| `--ver` | string | plan 时必填 / archive --target version 时必填 | 目标版本号（如 v1.4；archive --target version 支持逗号分隔批量，如 `v1.6.2,v1.7.0`） |
| `--effort` | string | plan 时可选 | 预计工作量 |
| `--target` | string | archive 时可选 | 归档目标：`version`（默认）/ `matrix` / `changelog` |
| `--stage` | string | archive --target matrix 时可选 | 按开发阶段过滤矩阵行：`P0` / `P1` / `P2` / `P3` |
| `--from` | string | archive --target matrix/changelog 时条件必填 | 起始版本号（与 `--to` 配合，指定版本区间） |
| `--to` | string | archive --target matrix/changelog 时条件必填 | 结束版本号（与 `--from` 配合，指定版本区间） |

## 前置条件

- `xspec/xf/ROADMAP.md` 必须存在（项目主路线图）
- `xspec/xf/ROADMAP.archive.md` 必须存在（历史版本归档文件；`archive` 子步骤若不存在则自动创建）
- `release` 子步骤要求 `xspec/archive/<change>/CHANGELOG.md` 存在

---

## 步骤 1：参数解析与目标文件确定

### 1.1 解析子步骤

从 `$ARGUMENTS` 提取子步骤名称（release / plan / archive / simplify / list）。

### 1.2 确定目标 ROADMAP

- **无 --module**：目标文件 = `xspec/xf/ROADMAP.md`（主路线图）
- **有 --module**：
  1. 规范化模块名：
     - 如果输入为纯数字前缀（如 `004`），glob 匹配 `xspec/modules/004-*/ROADMAP.md`
       - 匹配 0 个 → 报错：`❌ 模块 004 不存在`
       - 匹配 1 个 → 使用该路径
       - 匹配 > 1 个 → 报错：`❌ 模块 004 有多个匹配：[列表]，请使用完整名称`
     - 如果输入为完整模块名（如 `004-aiderag-integration`），精确匹配 `xspec/modules/<name>/ROADMAP.md`
  2. 目标文件 = `xspec/modules/<module>/ROADMAP.md`
  3. 如果目标文件不存在 → 输出错误并终止

---

## 步骤 2：执行对应子步骤

### 2.1 release（版本发布）

**用法**：`/xf:roadmap release --change CHG-20260505-001 [--bump patch|minor|major] [--module 004]`

**实现步骤**：

1. 检查 `xspec/archive/<change>/CHANGELOG.md` 是否存在
2. 提取变更信息（标题、摘要、日期）
3. 根据 `--bump` 参数递增版本号（默认 `patch`）：
   - **major**：v1.3.1 → v2.0.0
   - **minor**：v1.3.1 → v1.4.0
   - **patch**：v1.3.1 → v1.3.2（默认）
4. 在 [版本计划矩阵](#版本计划矩阵) 表格中追加新版本行（按时间顺序）
5. 更新「当前版本」和「最后更新」日期

**输出示例**：

```
✅ ROADMAP 已更新：vX.Y.Z → vX.Y.Z+1

📝 变更信息：
- 变更编号：<change-id>
- 变更摘要：<summary>
- 发布日期：<YYYY-MM-DD>

💡 下一步：
- 查看路线图：/xf:roadmap list
- 规划下一版本：/xf:roadmap plan --add "功能名" --pri P1 --ver v1.5
- 若版本章节已完整，可归档旧版：/xf:roadmap archive --ver vX.Y.Z
```

### 2.2 plan（功能规划）

**用法**：`/xf:roadmap plan --add "功能名" --pri P1 --ver v1.4 [--module 004] [--effort 1周]`

#### 2.2.1 前置检查

1. 检查必填参数：--add, --pri, --ver
2. 检查目标 ROADMAP 是否存在

#### 2.2.2 定位目标表格

1. 读取目标 ROADMAP
2. 定位「### 🟡 进行中」剩余任务表格（版本计划矩阵为唯一来源，新功能追加到此处）
3. 如果表格不存在，在章节下创建新表格

#### 2.2.3 追加新功能

1. 在表格末尾追加新行：
   ```markdown
   | <功能名> | <pri> | <ver> | <effort> | 计划中 |
   ```
2. 更新「最后更新」日期
3. 写入文件

#### 2.2.4 输出结果

```
✅ 功能已添加到路线图

📝 功能信息：
- 标题：<功能名>
- 优先级：<pri>
- 目标版本：<ver>
- 工作量：<effort>

💡 下一步：
- 查看路线图：/xf:roadmap list
- 管理技术债务：/xf:debt list
```

### 2.3 archive（版本/矩阵/变更历史归档）

**用法**：
- 版本归档（默认）：`/xf:roadmap archive --ver v1.7.0` 或批量 `/xf:roadmap archive --ver v1.6.2,v1.7.0`
- 矩阵行归档：`/xf:roadmap archive --target matrix --stage P0` 或 `/xf:roadmap archive --target matrix --from v0.1.0 --to v0.5.0`
- 变更历史归档：`/xf:roadmap archive --target changelog --from v0.4.1 --to v0.4.8`

根据 `--target` 参数（默认 `version`）选择归档模式：

| 模式 | 说明 | 详见 |
|:---|:---|:---|
| `version` | 归档已完成版本：更新矩阵状态为 ✅ + 更新已交付摘要 | §2.3.1–§2.3.5 |
| `matrix` | 归档已冻结阶段的矩阵行至 ROADMAP.archive.md 新部分，主文件矩阵仅保留活跃阶段 | §2.3.6 |
| `changelog` | 归档文档变更历史早期条目至 ROADMAP.archive.md 第二部分，主文件 changelog 保持精简 | §2.3.7 |

#### 2.3.1 前置检查（--target version 模式）

> 以下为 `--target version`（默认）模式的流程。`--target matrix` 见 §2.3.6，`--target changelog` 见 §2.3.7。

1. 解析 `--ver` 参数（逗号分隔，支持批量）
2. 对每个版本号：
   - 在版本计划矩阵中查找对应行，确认状态列为 `✅ 完成`
   - 若状态不是 `✅ 完成` → 输出：`⚠️ vX.Y.Z 尚未完成，跳过归档`
3. 检查 ROADMAP.archive.md 是否已含对应版本标题（幂等检查）：
   - 已存在 → 输出：`⚠️ vX.Y.Z 已归档，跳过（幂等）`
4. 若 ROADMAP.archive.md 不存在 → 创建初始文件（含归档说明头部）

#### 2.3.2 更新版本状态

在 [版本计划矩阵](#版本计划矩阵) 中定位对应版本行，将状态改为 `✅ 完成`。

> ROADMAP.md 采用「版本计划矩阵为唯一来源」结构，不再保留 `### vX.Y.Z` 详细章节（已移入 ROADMAP.archive.md）。archive 操作仅需更新矩阵状态和精简摘要，无需提取/替换章节内容。

#### 2.3.3 更新精简摘要

更新「### ✅ 已交付」中的版本计数和文字摘要。

> 如需归档的版本有详细章节曾存在于主文件，此步骤无需重建——内容已在 ROADMAP.archive.md 中。

#### 2.3.4 更新文件元信息

1. 更新 ROADMAP.md 头部：
   - `最后更新` → 当前日期（YYYY-MM-DD），说明归档操作
   - `版本` → 递增 patch 号（vX.Y.Z → vX.Y.Z+1）
2. 向 ROADMAP.md `## 文档变更历史` 表格追加条目：

   ```markdown
   | vX.Y.Z+1 | YYYY-MM-DD | 📦 **vA.B.C 归档**：版本计划矩阵状态更新为 ✅，ROADMAP.md 保留精简摘要 |
   ```

3. 更新 ROADMAP.archive.md 头部：
   - `最后更新` → 当前日期
   - `版本` → 递增 patch 号
   - `归档内容` 列表追加新版本条目

#### 2.3.5 输出结果

```
✅ 归档完成：vX.Y.Z 版本名

📦 归档操作：
- 版本计划矩阵：vX.Y.Z 状态 → ✅ 完成
- 已交付摘要：更新版本计数

💡 下一步：
- 查看当前路线图：/xf:roadmap list
- 继续归档其他版本：/xf:roadmap archive --ver vA.B.C
```

#### 2.3.6 归档模式：--target matrix

将版本计划矩阵中已冻结阶段（如 P0）的行迁移至 ROADMAP.archive.md 新部分，主文件矩阵仅保留活跃阶段行。

**触发条件**：某阶段全部版本已交付且矩阵行较多（建议 >8 行）时，或用户主动要求精简矩阵。

**参数要求**（`--stage` 或 `--from`+`--to`，至少一项，可组合）：
- `--stage P0`：归档指定阶段全部 ✅ 已交付行
- `--from vX.Y.Z --to vA.B.C`：归档版本区间内的行
- 组合：`--stage P0 --from v0.1.0 --to v0.3.1` 归档 P0 阶段 v0.1.0–v0.3.1 行

**实现步骤**：

1. 从版本计划矩阵中提取目标行（按 `--stage` 过滤阶段列，或按 `--from`/`--to` 过滤版本列，或两者交集）
2. 幂等检查：在 ROADMAP.archive.md 中查找是否已含目标版本范围的矩阵行
   - 已存在 → 输出：`⚠️ 矩阵行已归档，跳过（幂等）`
3. 在 ROADMAP.archive.md 追加新部分（编号递增，如「第五部分」）：
   - 部分标题：`## 第N部分：版本计划矩阵 <阶段> 行（<版本范围>，<版本号> 归档）`
   - 引导文本：说明行从主文件迁移 + 当前主文件矩阵保留范围
   - 粘贴完整矩阵行（保留所有列）
4. 从 ROADMAP.md 版本计划矩阵中删除已归档的行
5. 更新版本计划矩阵引导文本（补充归档指引，指向 ROADMAP.archive.md 对应部分）
6. 更新 ROADMAP.md 头部元信息（最后更新 + 版本 patch 递增）
7. 向 ROADMAP.md 文档变更历史追加条目，记录矩阵归档操作
8. 更新 ROADMAP.archive.md 头部（最后更新 + 归档内容列表追加新部分）

**输出示例**：

```
✅ 矩阵行归档完成：<阶段> <版本范围>（共 <N> 行）

📦 归档操作：
- ROADMAP.archive.md 新增第<N>部分
- ROADMAP.md 版本计划矩阵删除 <N> 行
- 矩阵引导文本已更新

💡 下一步：
- 查看当前路线图：/xf:roadmap list
- 归档变更历史：/xf:roadmap archive --target changelog --from vX.Y.Z --to vA.B.C
```

#### 2.3.7 归档模式：--target changelog

将文档变更历史中的早期条目迁移至 ROADMAP.archive.md 第二部分，主文件 changelog 保持精简。

**触发条件**：文档变更历史条目超过 ~10 条且早期条目仅具历史审计价值时。

**参数要求**：`--from vX.Y.Z --to vA.B.C`（必填）

**实现步骤**：

1. 从 ROADMAP.md 文档变更历史表中提取 `--from` 到 `--to` 区间的条目（含两端）
2. 幂等检查：在 ROADMAP.archive.md 第二部分中查找是否已含目标版本范围
   - 已存在 → 输出：`⚠️ changelog 条目已归档，跳过（幂等）`
3. 在 ROADMAP.archive.md 第二部分追加迁移的条目：
   - 如已有分组（如「v0.4.1-v0.4.8（v0.4.15 归档）」），追加到对应分组
   - 如无，创建新分组标题（含归档版本号）+ 条目表格
4. 从 ROADMAP.md 文档变更历史表中删除已归档条目
5. 在 ROADMAP.md 文档变更历史引导文本中补充归档指引（指向 ROADMAP.archive.md 第二部分）
6. 更新 ROADMAP.md 头部元信息（最后更新 + 版本 patch 递增）
7. 向 ROADMAP.md 文档变更历史追加条目，记录 changelog 归档操作
8. 更新 ROADMAP.archive.md 头部（最后更新 + 归档内容列表更新）

**输出示例**：

```
✅ 变更历史归档完成：<from>–<to>（共 <N> 条）

📦 归档操作：
- ROADMAP.archive.md 第二部分追加 <N> 条
- ROADMAP.md 文档变更历史删除 <N> 条
- 引导文本已更新

💡 下一步：
- 查看当前路线图：/xf:roadmap list
- 归档矩阵行：/xf:roadmap archive --target matrix --stage P0
```

### 2.4 simplify（里程碑概览分层简化）

**用法**：`/xf:roadmap simplify [--module 004]`

重写「里程碑概览」章节为分层结构，版本计划矩阵为唯一来源。若已为精简格式 → 跳过（幂等）。

#### 2.4.1 前置检查

1. 检查目标 ROADMAP 是否存在
2. 检查「里程碑概览」章节是否已为方案四格式（若已简化 → 输出 `⚠️ 里程碑概览已为方案四格式，跳过`）
3. 检查「版本计划矩阵」章节是否存在（作为数据源）

#### 2.4.2 从版本计划矩阵提取数据

读取版本计划矩阵表格，按状态分组：
- **✅ 完成**（含部分 "✅ CHG 完成"）→ ✅ 已交付
- **🟡 进行中**（含 "待实现"）→ 🟡 进行中
- **📋 计划** → 📋 计划中
- P2 阶段版本 → 🚧 P2 远期

#### 2.4.3 生成四层结构

用以下模板替换原「里程碑概览」章节全部内容：

```markdown
## 里程碑概览

> 以下为里程碑全景摘要。详细版本计划、前置依赖、工作量估算见 **[版本计划矩阵](#版本计划矩阵)**。
> 已完成版本的完整交付清单见 **[ROADMAP.archive.md](./ROADMAP.archive.md)**。

### ✅ 已交付（<版本范围>）

| 版本 | 代号 | 日期 | 核心交付 |
|:---|:---|:---:|:---|
| **vX.Y.Z** | <代号> | <日期> | <一行摘要> |
| ...

> ⚠️ <若有延后项，标注延后目标版本>

### 🟡 进行中（<版本号> 剩余）

| CHG | 内容 | 工作量 | 状态 | 详情 |
|:---|:---|:---:|:---:|:---|
| **CHG-XX** | <内容> | ~X 周 | <状态> | <核心修复/交付描述> |
| ...

**阻塞项**：<有/无> ✅  
**关键依赖**：<依赖链描述>

### 📋 计划中（<版本范围>）

| 版本 | 代号 | 时间 | 核心交付 | 工作量 |
|:---|:---|:---:|:---|:---:|
| **vX.Y.Z** | <代号> | <日期> | <一行摘要> | ~X 周 |
| ...

### 🚧 P2 阶段（远期，<时间范围>）

| 版本 | 代号 | 目标 | 核心交付 |
|:---|:---|:---:|:---|
| **vX.Y.Z** | <代号> | <关键词> | <一行摘要> |
| ...

> 📂 已归档版本的完整历史见 **[ROADMAP.archive.md](./ROADMAP.archive.md)**  
> 📋 技术债务统计：**[TECH-DEBT.md](./TECH-DEBT.md)** — <总数> 项（🔴高 <N> / 🟡中 <M> / 🟢低 <K>）  
> 📐 架构演进图见 **[版本计划矩阵](#版本计划矩阵)** 和下文 **[架构演进](#架构演进)**
```

#### 2.4.4 生成规则

1. **一行摘要**：从版本计划矩阵「核心功能」列提取，≤80 字符，用 `+` 连接多个交付项
2. **日期**：优先从矩阵「发布」列读取；无日期用 `~` 标记
3. **工作量**：从矩阵「工作量」列读取
4. **进行中 CHG**：从版本计划矩阵 `🟡` 行 + 当前执行状态面板提取
5. **技术债务统计**：从 `TECH-DEBT.md` 头部提取（`总计：N 项（🔴高 X / 🟡中 Y / 🟢低 Z）`）
6. **延后警告**：从版本计划矩阵 v1.7.1 行的「延后」标注提取，填入 ⚠️ 标注
7. **CHG-11 特殊处理**：若已独立章节存在，在「🟡 进行中」表格中用 `断链修复：<文件:行号>` 格式描述

#### 2.4.5 更新文件元信息

1. 更新 ROADMAP.md 头部「最后更新」→ 当前日期，说明简化操作
2. 版本号递增 patch（vX.Y.Z → vX.Y.Z+1）
3. 向「文档变更历史」追加条目：
   ```markdown
   | vX.Y.Z+1 | YYYY-MM-DD | 📐 **里程碑概览方案四分层简化**：采用分层递进结构（✅→🟡→📋→🚧），删除与版本计划矩阵/下一步详细计划重复内容，主文件行数减少约 50%。 |
   ```

#### 2.4.6 输出结果

```
✅ 里程碑概览已简化为方案四格式

📐 简化操作：
- 原行数：<before> → <after>（减少 <diff> 行，~<pct>%）
- ✅ 已交付：<N> 个版本
- 🟡 进行中：<M> 项
- 📋 计划中：<K> 个版本
- 🚧 P2 远期：<J> 个版本

💡 下一步：
- 查看简化结果：/xf:roadmap list
- 归档已完成版本：/xf:roadmap archive --ver vX.Y.Z
```

### 2.5 list（查看）

**用法**：`/xf:roadmap list [--module 004]`

**实现步骤**：

1. **读取目标 ROADMAP**：
   - 确定目标文件（主 / 模块级）
   - 读取完整内容

2. **解析关键信息**：
   - 当前版本号和最后更新日期
   - 从版本计划矩阵统计：✅ 完成数 / 🟡 进行中数 / 📋 计划数 / 🚧 P2 远期数
   - 从 🟡 进行中表格提取剩余任务摘要
   - 技术债务统计（从 TECH-DEBT.md 头部提取）
   - 已归档版本数量（从 ROADMAP.archive.md 统计）

3. **输出摘要**（示例）：
   ```
   📋 AideRag 路线图（当前版本：vX.Y.Z，最后更新：YYYY-MM-DD）

   ## 版本总览（版本计划矩阵为唯一来源）
   ✅ 已交付：N 个版本（从版本计划矩阵统计 ✅ 行数）
   🟡 进行中：M 个版本（从版本计划矩阵统计 🟡 行数，展开剩余任务数）
   🚧 P2 远期：J 个版本（从版本计划矩阵统计 📋/🚧 行数）
    技术债务：从 TECH-DEBT.md 提取统计
   已归档版本：见 ROADMAP.archive.md
   ```

---

## 行为规则

1. **只读优先**：`list` 子步骤不修改任何文件
2. **幂等性**：重复执行 release 同一 change → 跳过（幂等）；重复 archive 同一版本 → 检测 archive 文件已有对应标题，跳过并提示；重复 simplify → 检测已为方案四格式，跳过并提示
3. **版本号自动递增**：根据 --bump 参数递增当前版本号（major / minor / patch）
4. **日期自动更新**：更新「最后更新」为当前日期（YYYY-MM-DD）
5. **保守改写**：只改目标行/段，不改无关内容
6. **模块独立性**：模块 ROADMAP 操作不影响其他模块
7. **模块聚合**：release 无 --module 时，自动处理所有受影响模块的 ROADMAP，聚合统计信息
8. **中文输出**：所有提示、报告、错误信息使用中文
9. **归档条件**：仅归档版本计划矩阵中状态为 `✅ 完成` 的版本章节，进行中版本不得归档
10. **归档完整性**：archive 文件保留原始详细内容，不裁剪；精简摘要仅存在于 ROADMAP.md 主文件
11. **摘要核心交付上限**：精简摘要中的「核心交付」条目最多保留 5 条 ✅ 完成项，超出部分在 archive 查看
12. **simplify 安全**：simplify 仅修改「里程碑概览」章节，不触碰其他章节（版本计划矩阵、当前执行状态、功能矩阵等）；自动检测已简化状态防止重复操作
13. **手动拆分/重排六段清单**：当人工决策将一个版本拆分为两个（如 v0.6.1→v0.6.1+v0.6.2）或对调版本顺序时，**必须逐一检查以下 6 段**并同步更新所有受影响版本号（含级联：被插入版本后的所有版本号自动 +1）：
    - ① **里程碑概览表格**——已交付 / 计划中 / P2 / P3 各表中的版本行
    - ② **版本计划矩阵**——矩阵行拆分 / 重排 / 版本号更新
    - ③ **版本依赖链**——P0 / P1 / P2 / P3 各链中受影响节点
    - ④ **重组说明文本**——段落中所有版本号引用与诉求链描述
    - ⑤ **模块交付矩阵**——增强列中的版本号引用
    - ⑥ **性能验收里程碑**——验收项的版本号引用
    
    另需更新头部元数据（当前版本 / 下一步 / 最后更新 / 版本号）+ 追加 changelog 条目记录拆分决策与完整改动清单。**此清单不适用于 `archive` 自动化操作，仅约束人工 `plan` 变更后的全局一致性。**
14. **矩阵行归档安全性**：`--target matrix` 仅删除版本计划矩阵的行，**不删除**「里程碑概览 ✅ 已交付」表中的简化摘要行（摘要行独立维护）；归档后在矩阵引导文本中补充阶段范围指引，指向 ROADMAP.archive.md 对应部分
15. **变更历史与矩阵归档幂等性**：`--target matrix` 和 `--target changelog` 均检查 ROADMAP.archive.md 是否已含目标版本范围的内容，已含则跳过并提示（幂等）；归档后两个文件的头部元信息 + 归档内容列表必须同步更新

---

## 错误处理

| 错误情况 | 处理方式 |
|:---|:---|
| 目标 ROADMAP 不存在 | 输出：`❌ 文件不存在：<路径>` |
| release --change 对应的 archive 不存在 | 输出：`❌ 归档不存在：xspec/archive/<change>/CHANGELOG.md` |
| plan 缺少必填参数 | 输出：`❌ 缺少必填参数：<参数名>` |
| archive --ver 缺少 | 输出：`❌ 缺少必填参数：--ver` |
| archive 版本未完成 | 输出：`⚠️ vX.Y.Z 状态非 ✅ 完成，跳过归档` |
| archive 版本在矩阵中不存在 | 输出：`❌ 版本计划矩阵中未找到版本：vX.Y.Z` |
| archive 版本已存在于 archive 文件 | 输出：`⚠️ vX.Y.Z 已归档，跳过（幂等）` |
| 模块名无法识别 | 输出：`❌ 模块不存在：<module>。可用模块：[列表]` |
| 重复 release 同一 change | 输出：`⚠️ 变更已存在于历史版本，跳过（幂等）` |
| 文件读写失败 | 输出：`❌ 文件操作失败：<错误信息>` |
| simplify 已为方案四格式 | 输出：`⚠️ 里程碑概览已为方案四格式，跳过（幂等）` |
| simplify 缺少版本计划矩阵 | 输出：`❌ 未找到版本计划矩阵章节，无法提取数据源` |
| `--target` 值非 version/matrix/changelog | 输出：`❌ 无效的 --target 值：<value>，可用：version / matrix / changelog` |
| `--target matrix` 缺少 --stage 或 --from/--to | 输出：`❌ --target matrix 需指定 --stage 或 --from/--to` |
| `--target changelog` 缺少 --from/--to | 输出：`❌ --target changelog 需指定 --from 和 --to` |
| `--target matrix --stage` 值非 P0/P1/P2/P3 | 输出：`❌ 无效的阶段：<value>，可用：P0 / P1 / P2 / P3` |
| `--target matrix` --from/--to 版本不在矩阵中 | 输出：`❌ 版本计划矩阵中未找到版本：vX.Y.Z` |
| `--target changelog` --from/--to 版本不在 changelog 中 | 输出：`❌ 文档变更历史中未找到版本：vX.Y.Z` |
| `--target matrix/changelog` 目标已归档 | 输出：`⚠️ <版本范围> 已归档，跳过（幂等）` |
