---
title: "[App 名] — 原生 App 本地数据模型"
module_type: native-app
version: "0.1"
status: draft
date: ""
---

# 原生 App 本地数据模型（Data Model）

> **模板用途：** 定义原生 App 本地持久化层的 Schema 结构、关系、迁移策略、离线队列和云同步元数据。
> **不包含：** App 整体架构和云同步策略决策（→ `hld`）；ViewModel 数据流（→ `design`）；服务端 Schema（→ `web/data-model`）；接口字段定义（→ `universal/contracts`）。

---

## 1. 概览（必填）

| 字段 | 内容 |
|:--- | :--- |
| 所属 App | [引用 hld 中的 App 名] |
| 本地数据库引擎 | [SwiftData / SQLite（Room）/ SQLite（Drift）/ SQLite.NET（EF Core）/ Realm / ...] |
| 迁移方式 | [SwiftData 轻量迁移 / Room Migration / Drift Schema Migrations / EF Core Migrations / ...] |
| 核心实体 | [列出主要实体名，如：User、Item、SyncQueue] |
| 离线优先 | [是 / 否（见 §6 离线队列）] |
| 云同步 | [是 / 否（见 §7 云同步元数据）；同步服务：CloudKit / Firebase / Azure / 自建] |

> **填写顺序：** 建议先完成 §3 实体定义和 §4 关系定义，再回填 §2 总览图；有离线需求时同步填写 §6。

---

## 2. 实体关系总览（必填）

> 用文字或简易 ERD 描述实体间关系；详细字段见 §3。

```
[实体 A] ──── 1:N ──── [实体 B]
              │
              M:N
              │
         [实体 C]（通过关联表 [A_C]）

[SyncQueue]  ← 离线写入队列（见 §6）
```

**关系说明：**

| 关系 | 类型 | 说明 |
|:--- | :---: | :--- |
| [实体 A] → [实体 B] | 1:N | [如：一个 User 有多个 Item] |
| [实体 A] ↔ [实体 C] | M:N | [如：Item 包含多个 Tag，通过 item_tags 关联] |
| [实体 B] → [实体 D] | 1:1 | [如：Item 有一个本地附件记录] |

---

## 3. 实体定义（必填）

> 字段类型使用逻辑类型（`string`、`integer`、`boolean`、`datetime`、`uuid`、`blob`），不绑定具体数据库方言。
>
> **技术栈注（主键类型）：**
> - SwiftData：`@Attribute(.unique) var id: UUID`
> - Room：`@PrimaryKey val id: String`（UUID 字符串）或 `@PrimaryKey(autoGenerate = true) val id: Long`
> - Drift：`TextColumn get id => text()();`
> - EF Core：`[Key] public Guid Id { get; set; }`

### 3.1 [实体名，如：Item]

**用途：** [一句话描述这个实体存储什么]

| 字段 | 逻辑类型 | 约束 | 说明 |
|:--- | :--- | :--- | :--- |
| `id` | `uuid` | PK，非空 | 本地生成（UUID v4）；服务端也使用此 ID |
| `[field_1]` | `string(N)` | 非空 | [如：标题，最大 255 字符] |
| `[field_2]` | `string` | 可空 | [如：备注] |
| `[status]` | `enum` | 非空，默认 `active` | 枚举值：`active` / `archived`（如需软删除加 `deleted`）|
| `created_at` | `datetime` | 非空，自动填充 | 本地创建时间，UTC |
| `updated_at` | `datetime` | 非空，自动更新 | 最后更新时间，UTC；用于同步冲突检测 |

**软删除策略（三选一，选定后全模型保持一致）：**

| 策略 | 需要添加的字段 | 查询过滤条件 |
|:--- | :--- | :--- |
| `deleted_at` 时间戳 | `deleted_at datetime 可空` | `WHERE deleted_at IS NULL` |
| `status = deleted` | status 枚举加 `deleted` 值 | `WHERE status != 'deleted'` |
| 物理删除 | 无 | 无需过滤 |

本模型选择：**[策略名称]**，理由：[填写]

> **云同步提示：** 若 §1 "云同步 = 是"，需将 §7.1 中定义的同步元数据字段（`server_id`、`sync_status`、`server_updated_at`、`etag / version`）追加到本实体的字段表中，并在迁移脚本中包含这些字段。

---

### 3.2 [实体名，如：LocalAttachment]

**用途：** [描述]

| 字段 | 逻辑类型 | 约束 | 说明 |
|:--- | :--- | :--- | :--- |
| `id` | `uuid` | PK，非空 | |
| `item_id` | `uuid` | FK → Item.id，非空 | 所属 Item |
| `file_path` | `string` | 非空 | 相对于 App 沙盒的路径 |
| `mime_type` | `string(50)` | 非空 | [如：`image/jpeg`] |
| `size_bytes` | `integer` | 非空，≥ 0 | 文件大小 |
| `created_at` | `datetime` | 非空，自动填充 | |

> **设计决策：** 文件 blob 不存入 SQLite，只存路径，避免数据库膨胀；文件实际存储在 App 文档目录。

---

### 3.N [继续添加实体...]

---

## 4. 关系定义（必填）

> **SQLite 外键注意：** SQLite 默认不启用外键约束，需在连接初始化时执行 `PRAGMA foreign_keys = ON`（Room 默认已启用；SwiftData 使用 `@Relationship` 注解；Drift 使用 `references()`）。

### 4.1 外键约束

| 外键字段 | 引用表.字段 | ON DELETE | ON UPDATE | 说明 |
|:--- | :--- | :---: | :---: | :--- |
| `[实体 B].item_id` | `Item.id` | CASCADE | CASCADE | [删除 Item 时级联删除附件] |
| [自定义] | [引用] | [规则] | [规则] | [说明] |

### 4.2 关联表（M:N 时填）

**表名：** `[entity_a]_[entity_b]`（如：`item_tags`）

| 字段 | 类型 | 约束 | 说明 |
|:--- | :--- | :--- | :--- |
| `[entity_a_id]` | `uuid` | FK → [实体 A].id，PK 组合键 | ON DELETE CASCADE |
| `[entity_b_id]` | `uuid` | FK → [实体 B].id，PK 组合键 | ON DELETE CASCADE |
| `[extra_field]` | `[类型]` | [约束] | [如：排序权重] |
| `created_at` | `datetime` | 非空 | |

---

## 5. 索引设计（必填）

### 5.1 必要索引

| 索引名 | 所在实体 | 覆盖字段 | 访问模式 | 取舍说明 |
|:--- | :--- | :--- | :--- | :--- |
| `idx_[table]_[field]` | `[实体 B]` | `item_id` | 按父级 ID 查询子列表（高频）| 写入开销低，必建 |
| `idx_[table]_updated_at` | `[实体 A]` | `updated_at` | 增量同步查询（`WHERE updated_at > last_sync`，中频）| 同步场景必建 |
| `uniq_[table]_[field]` | `[实体 A]` | `[唯一字段]` | 唯一性约束保证 | 配合软删除策略（见 §5.3）|
| [自定义] | [实体] | [字段] | [访问场景] | [取舍说明] |

### 5.2 全文搜索索引（适用时填）

> SQLite 使用 FTS5（`CREATE VIRTUAL TABLE ... USING fts5`），Room / Drift 有对应注解支持。

| 索引名 | 表 | 字段 | 说明 |
|:--- | :--- | :--- | :--- |
| `fts_[table]_[field]` | [表] | [字段] | [搜索场景，如：本地全文搜索笔记内容] |

### 5.3 索引维护注意事项

- [注意 1，如：唯一索引配合软删除：`deleted_at` 方案用部分索引 `WHERE deleted_at IS NULL`；`status = deleted` 用条件索引 `WHERE status != 'deleted'`]
- [注意 2，如：SQLite 不支持 `CREATE INDEX CONCURRENTLY`；大表加索引在后台线程执行，避免阻塞主线程]

---

## 6. 离线队列 Schema（离线优先时必填）

> 离线写入队列用于缓存在无网络时产生的变更操作，待网络恢复后按序同步至服务端。云同步策略决策见 `hld §9`。

**表名：** `sync_queue`

| 字段 | 逻辑类型 | 约束 | 说明 |
|:--- | :--- | :--- | :--- |
| `id` | `uuid` | PK，非空 | 队列条目 ID |
| `entity_type` | `string(50)` | 非空 | 操作对象类型，如：`"Item"` / `"Attachment"` |
| `entity_id` | `uuid` | 非空 | 目标实体的本地 ID |
| `operation` | `enum` | 非空 | 操作类型：`CREATE` / `UPDATE` / `DELETE` |
| `payload` | `blob` / `string` | 可空 | 序列化的变更数据（JSON / Protobuf）；`DELETE` 操作时为 null；其他操作（`CREATE` / `UPDATE`）不允许为空 |
| `status` | `enum` | 非空，默认 `pending` | `pending` / `in_flight` / `success` / `failed` |
| `retry_count` | `integer` | 非空，默认 0 | 已重试次数；达到上限后置 `failed` |
| `max_retries` | `integer` | 非空，默认 3 | [可配置；超出后需人工介入或丢弃] |
| `error_message` | `string` | 可空 | 最后一次失败的错误信息，供调试 |
| `created_at` | `datetime` | 非空，自动填充 | 入队时间 |
| `last_attempted_at` | `datetime` | 可空 | 最后一次尝试同步的时间 |

**队列处理规则：**

| 规则 | 说明 |
|:--- | :--- |
| FIFO 顺序 | 按 `created_at` 升序处理，同一实体的操作不乱序 |
| 崩溃恢复 | App 启动时，将所有 `in_flight` 状态的条目重置为 `pending`，防止崩溃后条目永久卡住无法重试 |
| 同一实体合并 | [可选：同一 `entity_id` 的多个 `UPDATE` 可合并为最新一条，减少 API 调用] |
| 上限控制 | [如：队列最大条目数 1 000；超出时拒绝入队或丢弃最旧 `failed` 条目] |
| 幂等性 | 服务端接口必须支持幂等（见 `universal/contracts §2`）；`entity_id` 作为幂等键 |

**`sync_queue` 建议索引：**

| 索引名 | 字段 | 类型 | 原因 |
|:--- | :--- | :---: | :--- |
| `idx_sync_queue_status_created_at` | `status, created_at` | 复合 | 查询待处理条目（`WHERE status = 'pending' ORDER BY created_at`）为高频操作 |
| `idx_sync_queue_entity_id` | `entity_id` | 普通 | 查找同一实体的操作以支持合并逻辑 |

---

## 7. 云同步元数据（有云同步时必填）

> 需要云同步时，在各实体中添加以下元数据字段（与 §3 实体定义保持一致）。云同步策略决策见 `hld §9`。

### 7.1 各实体需添加的同步字段

| 字段 | 逻辑类型 | 约束 | 说明 |
|:--- | :--- | :--- | :--- |
| `server_id` | `string` / `uuid` | 可空（未同步前为 null）| 服务端分配的 ID；用于与服务端记录匹配 |
| `sync_status` | `enum` | 非空，默认 `local_only` | `local_only` / `synced` / `pending_upload` / `conflict` |
| `server_updated_at` | `datetime` | 可空 | 服务端最后更新时间；用于冲突检测（比较 `updated_at` 与 `server_updated_at`）|
| `etag` / `version` | `string` / `integer` | 可空 | 服务端版本标识；用于条件请求（`If-Match` / 乐观锁）|

### 7.2 冲突处理策略

| 冲突场景 | 策略 | 说明 |
|:--- | :--- | :--- |
| 本地修改 vs 服务端修改（同一字段）| [Last-Write-Wins / 服务端优先 / 本地优先 / 用户手动解决] | [填写选定策略及理由] |
| 本地删除 vs 服务端修改 | [本地删除优先 / 恢复为服务端最新版] | [填写选定策略] |
| 同一记录并发创建 | [以 `entity_id` 作为幂等键，服务端返回已存在记录] | |

> **`conflict` 状态处理：**
> - **UI 要求：** `sync_status = conflict` 时，App 需在界面上显著提示用户（如：列表项标记冲突图标 / 推送通知），引导进入冲突解决界面查看本地版本与服务端版本的差异。
> - **解决后状态转换：** 用户选定保留版本后，将对应数据写入本地 DB → 将 `sync_status` 重置为 `pending_upload`（若保留本地版本）或 `synced`（若接受服务端版本）→ 触发同步流程。
> - **无法自动解决的字段** 应列在此处：`[字段名 1]`、`[字段名 2]`。

---

## 8. 迁移策略（必填）

### 8.1 版本管理

| 字段 | 内容 |
|:--- | :--- |
| 当前 Schema 版本 | [如：1] |
| 版本追踪方式 | [SwiftData：`ModelConfiguration(schema:)`；Room：`@Database(version = N)`；Drift：`schemaVersion`；EF Core：Migrations 文件夹] |

### 8.2 迁移规则

- **所有 Schema 变更通过迁移代码完成，禁止手动修改本地 SQLite 文件**
- 新增可空字段或有默认值的字段可使用**轻量迁移**（SwiftData `MigrationStage.lightweight` / Room AutoMigration）
- 字段改名、类型变更、数据迁移须使用**手动迁移**，并在迁移代码中验证数据完整性
- 迁移脚本需在测试环境模拟从最低支持版本到当前版本的完整升级路径

### 8.3 各平台迁移方式

> **技术栈注：**

| 平台 | 轻量迁移 | 手动迁移 | 迁移触发时机 |
|:--- | :--- | :--- | :--- |
| SwiftData | `MigrationStage.lightweight` | `MigrationStage.custom` | App 启动，`ModelContainer` 初始化时 |
| Room（Android）| `AutoMigration(from, to)` | `Migration(from, to)` 对象 | App 启动，`Room.databaseBuilder().build()` |
| Drift（Flutter）| `MigrationStrategy.recreateAllViews` | `Migrator.createTable / alterTable` | App 启动，`LazyDatabase` 初始化时 |
| EF Core（.NET）| — | `Add-Migration` + `database.Migrate()` | App 启动或手动触发 |

### 8.4 常用操作模式

| 操作 | 安全做法 | 风险做法（禁止）|
|:--- | :--- | :--- |
| 新增字段 | 加可空字段或有默认值的字段（轻量迁移可处理）| 直接加非空无默认值字段（旧版本数据无法迁移）|
| 删除字段 | 先废弃（不再读写）→ 下一版本迁移脚本删除 | 直接删除仍在使用的字段 |
| 字段改名 | 手动迁移：新建字段 → 迁移数据 → 删除旧字段 | 直接改名（SQLite ALTER 不支持改名，各 ORM 策略不同）|
| 表改名 | 手动迁移，更新所有 FK 引用 | 直接改名 |

---

## 9. 线程安全规则（必填）

> 本地 SQLite 并发模型因平台不同，需明确线程使用规则。

| 规则 | 说明 |
|:--- | :--- |
| **禁止在主线程执行写操作** | 写操作统一在后台线程（Swift `Task.detached` / Kotlin `Dispatchers.IO` / Dart `Isolate`）|
| **读操作在主线程允许（仅限快速查询）** | 避免大查询或带 JOIN 的复杂查询阻塞 UI；复杂查询移到后台线程 |
| **WAL 模式（SQLite）** | 启用 WAL（`PRAGMA journal_mode = WAL`）以支持并发读；Room 默认已启用 |
| **单一写入通道** | 避免多线程同时写入同一表；使用串行队列（Swift `actor` / Kotlin `Mutex` / Dart `Mutex`）保护写操作 |

---

## 10. 测试要求（必填）

| 测试目标 | 测试类型 | 通过条件 |
|:--- | :--- | :--- |
| Schema 迁移成功（N-1 → N）| 集成测试 | 从最低支持版本升级后所有表结构与预期一致，历史数据完整 |
| 外键约束 | 集成测试 | 插入无效 FK 值时抛出约束错误（需确认 `PRAGMA foreign_keys = ON`）|
| 唯一约束 | 集成测试 | 插入重复唯一字段时抛出约束错误 |
| 软删除过滤 | 集成测试（适用时填）| 默认查询不返回已软删除的记录 |
| 离线队列入队 / 出队 | 集成测试（适用时填）| 操作按 FIFO 顺序处理；`status` 转换正确 |
| 迁移后同步元数据字段存在 | 集成测试（适用时填）| 云同步字段在迁移后可正常读写 |
| 并发写入线程安全 | 集成测试 | 多线程并发写入不产生数据损坏或崩溃 |
