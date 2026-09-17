---
name: code-parsing
description: CodeGraph 代码结构查询规范。在需要定位符号、分析影响、追踪调用链、审计引用、查找死代码候选时使用。CodeGraph 只提供代码结构事实，Agent 负责解释和决策。
---

# CodeGraph 代码结构查询规范

CodeGraph MCP 提供代码结构事实（符号、引用、调用链、依赖、死代码候选）。**Agent 负责解释这些事实并做出判断**——CodeGraph 不替代源码阅读、文本搜索和正式测试。

## 核心原则

1. **CodeGraph 只提供代码结构事实，Agent 负责解释。** 工具返回的节点、边、计数是原始数据；严重度、分类、修改建议由 Agent 根据上下文判断。
2. **符号级查询必须走确定性两步定位流程（避免 OpenCode 自动填充可选 node_id 导致查错符号）：**
   1. 已知符号名时，先调用 `ast_search(query=<真实符号名>, type=<已知类型>, limit=5)`。
   2. 根据返回结果核对：name 精确一致；file_path 与目标文件一致；获取工具真实返回的 node_id。
   3. 再调用 `get_ast_node(node_id=<ast_search 真实返回值>, include_impact=true, include_references=true)`。
   4. 第二步不得继续传 symbol_name，不得猜测、递增或尝试 node_id。
   5. ast_search 无唯一匹配时，读取候选源码消歧；仍无法确定则降级，不调用 get_ast_node。
   6. 禁止 node_id=0、-1、顺序递增和任何未由工具返回的值。
3. **不需要的可选参数必须省略，禁止传空字符串。** 空字符串不等于"不过滤"，会导致无结果或错误。
4. **`include_deps=true` 只对单文件使用。** 对目录传此参数无意义。

## 最小调用顺序

按需选择，不要无脑调用全部工具：

| 场景 | 工具 | 关键参数 |
|------|------|----------|
| 不熟悉项目结构 | `project_map` | 可选 `include_centrality=true` |
| 已知目录或文件 | `module_overview` | `path` |
| 不知道准确符号 | `ast_search` | `query` 或 `type`/`returns`/`params` 过滤 |
| 修改前影响评估 | `get_ast_node` | `include_impact=true, include_references=true` |
| 多跳调用链 | `get_call_graph` | `symbol_name` + `direction` + `depth` |
| 重命名或删除审计 | `find_references` | `symbol_name` + 可选 `relation` |
| 死代码候选 | `module_overview` | `include_dead=true` |

## 调用纪律

- **发现型查询**（`project_map`、`module_overview`、`ast_search`）首次可使用 `compact=true` 减少噪音。
- **`get_ast_node` 需要完整影响和引用证据时，不得因 compact 丢失必要结果**——影响分析和引用审计必须使用完整输出。
- 调用深度不超过 2～3。
- 证据不足时再扩大范围（去掉 compact、增加 depth、加 include_tests）。
- **禁止**一次性对所有工具发起调用；按上表顺序逐步深入。
- **不允许为完成形式而重复查询相同事实**——已获取的结果直接复用。

## 死代码候选复核

`module_overview(include_dead=true)` 返回的是**候选**，不是结论。标记为死代码前必须复核：

1. `package.json` 的 `exports` / `main` / `bin` 字段；
2. 插件注册、路由表、DI 容器、配置文件中的引用；
3. 动态 `import()` / `require()` 调用；
4. 依赖注入、反射、装饰器注册；
5. 测试文件和外部消费者（其他包、脚本、CI）。

任何一条命中 → **不得判定为可安全删除**；标记为公共 API、动态入口或外部使用风险，保留在人工确认清单中。只有源码、配置、测试和对外入口均无使用证据时，才能保留为高可信死代码候选；**仍禁止自动删除**。

## 隐藏目录与索引覆盖

涉及 `.xflow`、`.opencode`、`.cursor` 等隐藏目录时，必须使用明确路径 Read 和 Grep；如果平台搜索仍忽略点目录，使用安全的只读 Bash 定位。不得依赖 Glob 发现隐藏目录，也不得仅依赖 CodeGraph。

## 影响分析的局限性

`get_ast_node(include_impact=true)` 没有结果**不等于一定无影响**。以下场景可能漏报：

- 动态调用（`obj[methodName]()`、`import()` 变量路径）
- 跨语言 / 跨进程调用（CLI → 脚本、HTTP → handler）
- 配置驱动的注册（YAML/JSON 中引用的符号名）

影响分析无结果时，仍需文本搜索确认。

## Windows 索引时效性

Windows 已验证：**修改、删除事件可能未及时刷新索引**（10 秒内未触发 incremental index）。

- 若 CodeGraph 结果与当前源码不一致 → **不得继续引用旧结果**。
- 改用源码读取、文本搜索和正式测试获取事实。
- **本轮不执行手工 `incremental-index` 重建。**

## 平台工具调用规则（强制）

必须通过当前平台暴露的 CodeGraph MCP 工具调用。OpenCode 中对应名称为 `code-graph_ast_search`、`code-graph_get_ast_node`、`code-graph_get_call_graph`、`code-graph_module_overview`；其他平台使用其暴露的同名 CodeGraph MCP 工具。

**禁令（不可违反）：**
- 禁止通过 Bash 执行 `code-graph-mcp`、`npx` 或任何 CodeGraph CLI 命令。
- 降级必须发生在真实 MCP 调用返回 unavailable/error 之后；没有发起 MCP 调用不算降级。
- 修改已有共享符号前未获得 MCP 结果时，不得把"CodeGraph 已参与"写入报告。

## 降级策略

CodeGraph 不可用（MCP 工具调用返回 unavailable/error/超时）时：

- **自动降级**到原有定位方式（Grep、Glob、Read、git diff）。
- **不阻塞**当前节点流程。
- 在输出中注明降级情况。
- **前提**：必须已经发起过至少一次真实 MCP 工具调用并收到错误响应。未发起调用直接跳过不算降级。

## 输出分类

所有涉及 CodeGraph 的分析输出必须区分四类：

| 分类 | 含义 |
|------|------|
| **已确认影响** | CodeGraph + 源码/测试双重验证 |
| **可能影响** | CodeGraph 显示但未经源码/测试确认 |
| **未覆盖范围** | 隐藏目录、动态调用、跨进程等 CodeGraph 不覆盖的部分 |
| **降级情况** | CodeGraph 不可用，使用了替代定位方式 |
