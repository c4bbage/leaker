---
title: "[模块名] — 系统数据模型"
module_type: systems
version: "0.1"
status: draft
date: ""
---

# 系统数据模型（Data Model）

> **用途：** 系统级模块（Zig / C / Rust）的持久化数据模型设计，针对 SQLite (WAL) 为主、PostgreSQL 为可选的存储架构。
> 与 `ai-agent/data-model` 的区别：本模板关注系统基础设施的数据实体（配置、审计日志、运行时状态等）；Agent 专有实体（sessions、memories、embeddings）参见 `ai-agent/data-model`。
> **裁剪原则：** `(必填)` 必须完成；`(适用时填)` 按触发条件决定。

---

## 1. 概览 (必填)

**本数据模型覆盖：** [模块名，如：配置存储 / 审计日志 / 运行时状态]

**持久化后端：**

| 后端 | 适用场景 | 启用条件 |
|:--- | :--- | :--- |
| SQLite (WAL 模式) | 单实例 / 本地 / 嵌入式部署 | 默认 |
| PostgreSQL | 多实例 / 云端 / 共享存储 | 编译标志 + 配置 |

**与 HLD 的关系：** 参见 `[hld 文档链接]` §[数据存储层]

---

## 2. 实体关系总览 (必填)

> **填写顺序：** 本节是汇总视图，建议完成 §3 的设计决策后再回填此处。

[说明各实体之间的关系和数据流向，1–2 段。]

```
[根据 §3 的实际决策填写，以下为常见起点，按需增减]

config_entries  —  配置键值对（单表）
audit_log       ──< audit_details    （1 条审计日志对应 N 个详情条目，适用时填）
runtime_state   —  运行时键值状态（单表）
```

**实体清单（根据设计决策裁剪）：**

| 实体 | 用途 | 是否必填 |
|:--- | :--- | :---: |
| `config_entries` | 声明式配置持久化 | 适用时填 |
| `audit_log` | 安全相关操作审计记录 | 适用时填 |
| `runtime_state` | 进程重启后恢复的运行时状态 | 适用时填 |
| [自定义实体] | [说明] | [必填/适用时填] |

---

## 3. 实体定义 (必填)

> 每个核心实体一节。字段类型使用 SQLite 逻辑类型（`INTEGER`、`TEXT`、`REAL`、`BLOB`），并在 §6 物理映射中标注 PostgreSQL 对应类型。

### 3.1 [实体名，如：config_entries]

**用途：** [一句话描述这个实体存储什么]

**字段语义：**

| 字段 | 逻辑类型 | 约束 | 说明 |
|:--- | :--- | :--- | :--- |
| `key` | `TEXT` | PK，非空 | 配置键名，点分路径如 `gateway.max_connections` |
| `value` | `TEXT` | 非空 | 配置值，JSON 序列化存储复杂结构 |
| `updated_at` | `INTEGER` | 非空 | Unix 时间戳，UTC |
| `schema_version` | `INTEGER` | 非空，默认 1 | 配置迁移版本号 |

**访问模式：**

- 高频：按 `key` 精确读取（进程启动时全量加载到内存）
- 低频：按 `schema_version` 批量查询（迁移检查）
- 写入：启动时写默认值；配置变更时 Upsert

**设计决策：**

- 复杂配置值的序列化格式：[JSON / TOML / 自定义二进制]
- 启动时是否全量加载到内存？[是/否，原因]
- 配置变更是否需要持久化？[是/否，原因]

---

### 3.2 [实体名，如：audit_log]

**用途：** [一句话描述]

**字段语义：**

| 字段 | 逻辑类型 | 约束 | 说明 |
|:--- | :--- | :--- | :--- |
| `id` | `INTEGER` | PK，自增 | 审计日志 ID |
| `timestamp` | `INTEGER` | 非空，索引 | Unix 时间戳，UTC |
| `action` | `TEXT` | 非空 | 操作类型，如 `tool.execute` / `config.update` |
| `actor` | `TEXT` | 非空 | 操作者标识，如 `user:alice` / `system:cron` |
| `target` | `TEXT` | 可空 | 操作目标，如 `tool:shell` / `key:gateway.port` |
| `outcome` | `TEXT` | 非空 | 结果枚举：`success` / `denied` / `failed` |
| `details` | `TEXT` | 可空 | JSON 格式详情 |

**访问模式：**

- 高频：按时间范围 + actor 查询（审计报表）
- 低频：按 action 类型查询（安全分析）
- 写入：仅 Append，不更新不删除

**设计决策：**

- 日志保留策略：[如：保留 90 天，超期自动清理]
- 是否需要分表（按月/按 action 类型）？[是/否，原因]
- 是否需要实时订阅通知？[是/否，实现方式]

---

### 3.N [继续添加实体...]

---

## 4. 索引设计 (必填)

> 基于各实体的访问模式汇总索引需求。

| 索引名 | 所在实体 | 覆盖字段 | 访问模式 | 取舍说明 |
|:--- | :--- | :--- | :--- | :--- |
| `idx_[entity]_[field]` | [实体] | `[field]` | [查询场景] | [取舍说明] |

**全文检索索引（适用时填）：** [FTS5 / GIN / Elasticsearch，索引字段，同步方式]

---

## 5. 迁移策略 (必填)

### 5.1 迁移规则

- 所有结构变更通过迁移函数完成，迁移函数须**幂等**（`IF NOT EXISTS` / `IF EXISTS`）
- 每个迁移函数只做一件事
- 迁移函数在事务内执行
- Schema 版本记录在 `_meta` 表中

### 5.2 版本追踪

```zig
// 迁移函数注册表
const migrations = [_]Migration{
    .{ .version = 1, .up = migration_001_init },
    .{ .version = 2, .up = migration_002_add_column },
};
```

| 迁移编号 | 触发原因 | 操作类型 | 幂等保证方式 |
|:--- | :--- | :--- | :--- |
| `001` | [如：初始化 schema] | CREATE TABLE | `IF NOT EXISTS` |
| `002` | [如：新增字段] | ALTER TABLE ADD COLUMN | 检查列是否已存在 |
| `003` | [如：修改约束] | rebuild-table | 事务包裹 + schema version 检查 |

---

## 6. 物理 Schema 与 PRAGMA (必填)

> SQLite 物理层配置，影响性能和数据安全。PostgreSQL 方言差异在此标注。

### 6.1 SQLite PRAGMA 设置

| PRAGMA | 值 | 原因 |
|:--- | :--- | :--- |
| `journal_mode` | `WAL` | 并发读写不阻塞，单实例首选 |
| `synchronous` | `NORMAL` | WAL 模式下安全且高性能 |
| `cache_size` | [如：`-2000`] | 负值=KB，2MB 缓存（适配 RSS 预算） |
| `foreign_keys` | `ON` | 启用外键约束 |
| `busy_timeout` | [如：`5000`] | ms，并发写入时等待而非立即失败 |
| `page_size` | [如：`4096`] | 默认 4KB；大量文本可考虑 8KB |

### 6.2 SQLite 类型映射

| 逻辑类型 | SQLite 存储 | Zig 类型 | PostgreSQL 对应 |
|:--- | :--- | :--- | :--- |
| `TEXT` | TEXT | `[]const u8` | `TEXT` / `VARCHAR(N)` |
| `INTEGER` | INTEGER | `i64` | `BIGINT` |
| `REAL` | REAL | `f64` | `DOUBLE PRECISION` |
| `BLOB` | BLOB | `[]const u8` | `BYTEA` |

### 6.3 并发安全规则

- 写操作：单一写入通道（主线程或 Mutex 保护的写入队列）
- 读操作：WAL 模式下与写操作不阻塞
- 不得在持有锁时执行 I/O 操作（防止死锁）
- 连接池：每个线程独立连接，或使用共享缓存模式

---

## 7. 测试要求 (必填)

> 所有数据库测试使用 `std.testing.allocator` 以启用泄漏检测。

| 测试目标 | 测试类型 | 通过条件 |
|:--- | :--- | :--- |
| 迁移幂等 | 集成测试 | 重复执行不报错、不产生重复数据 |
| CRUD 正确性 | 集成测试 | 插入 → 查询 → 更新 → 查询 → 删除 → 查询为空 |
| 并发安全 | 集成测试 | 多线程并发读写不出现数据损坏（WAL 模式下）|
| 外键约束 | 集成测试 | 无效外键值插入失败 |
| 唯一约束 | 集成测试 | 重复唯一键插入失败 |
| PRAGMA 验证 | 集成测试 | 启动后检查 `journal_mode = wal`、`foreign_keys = on` |
| 内存安全 | 单元测试（`std.testing.allocator`）| 所有分配在 `deinit` 时正确释放，0 bytes leaked |
