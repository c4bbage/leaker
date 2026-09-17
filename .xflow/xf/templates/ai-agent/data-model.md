---
title: "[模块名] — AI Agent 数据模型"
module_type: ai-agent
version: "0.1"
status: draft
date: ""
---

# AI Agent 数据模型（Data Model）

> **用途：** AI Agent 系统持久化层的逻辑数据模型设计，与实现语言和数据库方言无关。  
> 本模板只描述 Agent 架构特有的实体（会话、记忆、向量、用量）；DDL 规范、PRAGMA、迁移工具链参见 `systems/data-model`。  
> **裁剪原则：** `(必填)` 必须完成；`(适用时填)` 按触发条件决定。

---

## 1. 概览 (必填)

**本数据模型覆盖：** [模块名，如：对话持久化 / 记忆子系统]

**持久化后端：**

| 后端 | 适用场景 |
|:--- | :--- |
| SQLite（WAL 模式）| 单实例 / 本地 / 嵌入式部署 |
| PostgreSQL | 多实例 / 云端 / 共享存储 |
| [其他] | [说明] |

**与 HLD 的关系：** 参见 `[hld 文档链接]` §[记忆架构章节]

---

## 2. 实体关系总览 (必填)

> **填写顺序：** 本节是汇总视图，建议完成 §3–§7 的设计决策后再回填此处。

[说明各实体之间的关系和数据流向，1–2 段。]

```
[根据 §3–§7 的实际决策填写，以下为常见起点，按需增减]

sessions  ──< messages          （1 个 session 对应 N 条消息）
sessions  ──  session_usage     （1 个 session 对应 1 条用量记录，适用时填）
memories  >─  session_id        （NULL = 全局；非 NULL = 归属某 session）
memories  ──< memory_embeddings （适用时填）
```

**实体清单（根据设计决策裁剪）：**

| 实体 | 用途 | 是否必填 |
|:--- | :--- | :---: |
| `sessions` | 会话元数据，隔离边界 | 必填 |
| `messages` | 对话消息历史 | 必填 |
| `memories` | 跨会话持久化知识 | 必填 |
| `memory_embeddings` | 语义向量，支持相似度检索 | 适用时填 |
| `session_usage` | Token 用量 / 费用追踪 | 适用时填 |
| `kv` | Agent 内部状态键值对 | 适用时填 |

---

## 3. sessions — 会话元数据 (必填)

**用途：** 一次完整的用户-Agent 对话生命周期，是消息历史和记忆隔离的核心边界。

**字段语义：**

| 字段 | 逻辑类型 | 约束 | 说明 |
|:--- | :--- | :--- | :--- |
| `id` | `uuid` | PK，非空 | 会话唯一标识 |
| `[provider]` | `string` | 可空 | 本次会话使用的 LLM Provider |
| `[model]` | `string` | 可空 | 使用的模型标识 |
| `created_at` | `datetime` | 非空，UTC | 会话创建时间 |
| `updated_at` | `datetime` | 非空，UTC | 最后活跃时间 |

**设计决策：**

- 需要哪些额外元数据字段？（如 `channel`、`agent_name`、`user_id`）[说明]
- 会话保留策略：多久清理过期会话？[说明]

---

## 4. messages — 对话消息 (必填)

**用途：** Agent 与用户之间的完整对话历史，按 session 隔离。

**字段语义：**

| 字段 | 逻辑类型 | 约束 | 说明 |
|:--- | :--- | :--- | :--- |
| `id` | `uuid` / `integer` | PK，非空 | 消息唯一标识（自增或 UUID）|
| `session_id` | `uuid` | FK → sessions.id，非空 | 所属会话 |
| `role` | `enum` | 非空 | 消息角色：system / user / assistant / tool |
| `content` | `text` | 非空 | 消息正文 |
| `created_at` | `datetime` | 非空，UTC | 消息发送时间 |

**访问模式：**

- 高频：按 `session_id` 顺序读取全部消息（上下文重建）
- 低频：按时间范围查询（历史检索）

**设计决策：**

- 是否记录每条消息的 Token 数（用于 context window 管理）？[说明]
- 消息修剪策略：最多保留 N 条 / 按时间 / 按 token 总数？[说明]
- 工具调用消息（tool role）是否与普通消息同表，还是单独存储？[说明]

---

## 5. memories — 持久化记忆 (必填)

**用途：** Agent 的长期知识库，支持跨会话的结构化记忆存取。

**字段语义：**

| 字段 | 逻辑类型 | 约束 | 说明 |
|:--- | :--- | :--- | :--- |
| `id` | `uuid` | PK，非空 | 记忆条目唯一标识 |
| `key` | `string` | 同 scope 内唯一，非空 | 人类可读的记忆键名 |
| `content` | `text` | 非空 | 记忆内容正文 |
| `category` | `enum` | 非空 | 记忆分类（填写可选值）|
| `session_id` | `uuid` | 可空 | 作用域：NULL = 全局，非 NULL = session 级 |
| `created_at` | `datetime` | 非空，UTC | 创建时间 |
| `updated_at` | `datetime` | 非空，UTC | 最后更新时间 |

**访问模式：**

- 高频：按 `key + session_id` 精确查找（读取特定记忆）
- 中频：按 `category` 列举（批量加载某类记忆）
- 低频：全文关键词搜索（探索式召回）

**设计决策：**

- 使用哪些 `category` 值，各自代表什么语义？[如 core / episodic / semantic]
- 唯一性边界：`key` 全局唯一，还是 `(key, session_id)` 组合唯一？[说明]
- 写入语义：Upsert（同 key 覆盖更新）还是 Append（保留全部历史）？[说明]
- 是否需要 `namespace` 字段隔离不同 Agent 实例的记忆？[说明]
- 是否启用全文检索？若是，索引哪些字段？用什么检索引擎？[说明]

---

## 6. memory_embeddings — 向量记忆（适用时填）

> **触发条件：** 需要语义搜索（RAG）或相似度匹配时填写。

**用途：** 为记忆条目存储向量表示，支持语义相似度召回。

**字段语义：**

| 字段 | 逻辑类型 | 约束 | 说明 |
|:--- | :--- | :--- | :--- |
| `memory_key` | `string` | PK，FK → memories.key，非空 | 关联的记忆键名 |
| `embedding` | `float32[]` | 非空 | 向量数据（float32 数组或 pgvector 类型）|
| `updated_at` | `datetime` | 非空，UTC | 向量最后更新时间 |

**设计决策：**

- Embedding 模型及向量维度？[如 text-embedding-3-small → 1536 维]
- 相似度度量：余弦相似度 / L2 距离？[说明]
- 向量与记忆同表存储（PostgreSQL 列），还是独立关联表（SQLite）？[说明]
- **外键选择：** 关联 `memories.key`（按内容名称索引，key 变更需级联更新）还是 `memories.id`（按 UUID 索引，更稳定但需多一次 join）？[说明]
- 是否缓存 Embedding 计算结果？若是，缓存键设计？过期策略？[说明]

---

## 7. session_usage / kv — 用量与状态（适用时填）

> **触发条件：** 需要限流、费用追踪或持久化 Agent 内部状态时填写。

### session_usage — Token 用量

**用途：** 按会话累计 Token 消耗，用于限流或费用核算。

| 字段 | 逻辑类型 | 约束 | 说明 |
|:--- | :--- | :--- | :--- |
| `session_id` | `uuid` | PK，FK → sessions.id，非空 | 关联会话 |
| `total_tokens` | `integer` | 非空，默认 0 | 累计 Token 总数 |
| `updated_at` | `datetime` | 非空，UTC | 最后更新时间 |

**设计决策：** 是否需要拆分 `tokens_input` / `tokens_output` / `cost_usd`？[说明]

> **冗余提示：** 若 §4 messages 已记录每条消息的 Token 数，则 `total_tokens` 可由 `SUM(messages.tokens)` 实时查询得到。选择预聚合（本表）还是实时计算，取决于查询频率和写入开销，需明确决策。

### kv — Agent 内部键值状态

**用途：** 存储 Agent 运行时的跨请求内部状态，结构简单、写少读少。

| 字段 | 逻辑类型 | 约束 | 说明 |
|:--- | :--- | :--- | :--- |
| `key` | `string` | PK，非空 | 状态键名 |
| `value` | `text` | 非空 | 状态值，JSON 或纯文本 |

**设计决策：** 说明哪些内部状态使用此表，以及 value 的序列化格式。

---

## 8. 索引设计 (必填)

> 基于各实体的访问模式汇总索引需求，明确每个索引的查询目标和取舍。

| 索引名 | 所在实体 | 覆盖字段 | 访问模式 | 取舍说明 |
|:--- | :--- | :--- | :--- | :--- |
| `idx_messages_session` | messages | `session_id` | 按 session 重建上下文（高频）| 写入开销小，必建 |
| `idx_memories_key_session` | memories | `(key, session_id)` | 精确查找特定记忆（高频）| 复合唯一索引，同时保证约束 |
| `idx_memories_category` | memories | `category` | 批量加载某类记忆（中频）| 选择性低时效果有限，按实际评估 |
| [自定义索引] | [实体] | [字段] | [访问场景] | [取舍说明] |

**全文检索索引（适用时填）：** [索引类型（FTS5 / GIN / Elasticsearch）、索引字段、与主表的同步方式]

**向量索引（适用时填）：** [索引算法（IVFFlat / HNSW）、距离度量、`lists` 参数选择依据]

---

## 9. 迁移策略 (必填)

> DDL 规范与工具链参见 `systems/data-model-template.md` §迁移策略。此处记录 Agent 数据层的迁移要点。

| 迁移编号 | 触发原因 | 操作类型 | 幂等保证方式 |
|:--- | :--- | :--- | :--- |
| `[migration_001]` | [如：初始化 schema] | CREATE TABLE | `IF NOT EXISTS` |
| `[migration_002]` | [如：新增 session 隔离字段] | `ALTER TABLE ADD COLUMN` | 检查列是否已存在 |
| `[migration_003]` | [如：唯一约束从单列改为复合] | rebuild-table | 事务包裹 + schema version 检查 |

---

## 10. 测试要求 (必填)

| 测试目标 | 测试类型 | 通过条件 |
|:--- | :--- | :--- |
| Upsert 语义 | 集成测试（§5 选 Upsert 时）| 重复写入同 scope 下同 key，更新内容，不产生重复行 |
| Append 语义 | 集成测试（§5 选 Append 时）| 重复写入同 key，保留所有历史条目 |
| 跨 scope 共存 | 集成测试 | global 与 session 级同名 key 可独立存在 |
| 全文检索 | 集成测试（§5 启用全文检索时）| 写入后可通过关键词召回 |
| 向量召回 | 集成测试（§6 适用时）| 写入 embedding 后可按相似度排序返回结果 |
| Session 隔离 | 集成测试 | Session A 的 scoped 记忆不可被 Session B 读取 |
| 迁移幂等 | 集成测试 | 重复执行不报错、不产生重复数据 |

---

## 附录：物理 Schema 参考（可选）

> 以下为参考实现，仅供 DDL 编写时参考，**不作为设计约束**。  
> 实际 DDL 以第 3–7 节的逻辑设计为准，并按项目所用 DB 方言调整。  
> SQLite 完整规范（PRAGMA、WAL、类型映射）参见 `systems/data-model-template.md`。

[在此粘贴最终确定的 DDL，或链接到代码库中的 schema 文件]
