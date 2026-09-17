---
title: "[模块名] — AI Agent 模块设计"
module_type: ai-agent
version: "0.1"
status: draft
date: ""
---

# AI Agent 模块设计（Design）

> **用途：** 单个 AI Agent 模块的实现级设计，覆盖 Agent Loop 管线、Prompt 构建、工具调度、记忆操作和安全执行。
> HLD 级决策（Agent Loop 模式、Provider 策略、记忆分层方案）参见对应的 `ai-agent/hld` 文档。
> 本模板与 `systems/design` 互补：Agent 模块的运行时基础设施（vtable、内存所有权、错误联合体）用 `systems/design` 描述；Agent 行为逻辑用本模板描述。
> **裁剪原则：** `(必填)` 必须完成；`(适用时填)` 按触发条件决定。

---

## 1. 概览 (必填)

**模块职责（一句话）：** [如：实现大堂经理意图路由与专家调度逻辑。]

**源文件：** `src/[path/to/module].zig`

**上游依赖：**

| 文档类型 | 链接 |
|:--- | :--- |
| HLD | [关联 ai-agent/hld 文档] |
| Spec | [关联 spec 文档，如有] |
| Data Model | [关联 ai-agent/data-model 文档，如有] |

---

## 2. 模块职责边界 (必填)

**负责：**
- [职责 1，如：接收净化后的入站消息，执行意图分类并派发至专家 Agent]
- [职责 2，如：管理 Turn 内的工具调用循环，执行风险分级校验]

**不负责（显式排除）：**
- [排除项 1，如：不负责消息传输和鉴权（Gateway 职责）]
- [排除项 2，如：不负责 Provider API 调用细节（Provider 模块职责）]

**调用关系：**

| 方向 | 模块 | 方式 |
|:--- | :--- | :--- |
| 被调用 | [如：`src/bus/session.zig`] | [如：Bus 分发消息时调用 `handleTurn()`] |
| 调用 | [如：`src/provider/manager.zig`] | [如：通过 ProviderVTable 调用 `chat()`] |

---

## 3. Agent Turn 管线 (必填)

> 描述一次完整 Turn 从消息入站到响应出站的执行管线。HLD §4 定义了循环模式（ReAct / Plan-Execute）；本节描述管线各阶段的实现细节。

### DS-NNN 管线阶段
fr: FR-NNN
depends: DS-NNN, DS-NNN@other-module

```
入站净化 → 记忆加载 → Prompt 组装 → LLM 调用 → 工具调度（循环） → 记忆写入 → 输出净化
```

| 阶段 | 实现 | 关键数据结构 | 错误处理 |
|:--- | :--- | :--- | :--- |
| 入站净化 | [如：标记外部消息为 untrusted] | [如：`Message{ .role = .user, .trusted = false }`] | [如：空消息 → 返回错误] |
| 记忆加载 | [如：按 scope 从 Memory 模块检索] | [如：`[]MemoryEntry`] | [如：检索失败 → 降级为无记忆] |
| Prompt 组装 | [如：按 §4 规则拼接 System Prompt] | [如：`[]Message`] | [如：Token 超预算 → 触发压缩] |
| LLM 调用 | [如：通过 ProviderVTable.chat() ] | [如：`ChatResponse`] | [如：Provider 超时 → Fallback / 错误] |
| 工具调度 | [如：解析 tool_call → 风险校验 → 执行] | [如：`ToolCall`, `ToolResult`] | [如：沙箱失败 → 返回错误结果] |
| 记忆写入 | [如：Turn 摘要写入持久层] | [如：`MemoryEntry`] | [如：写入失败 → 日志告警，不阻塞] |
| 输出净化 | [如：正则移除 Key 格式字符串] | [如：净化后的 `Message`] | [如：无匹配 → 直接通过] |

### 3.2 循环控制

| 参数 | 值 | 说明 |
|:--- | :--- | :--- |
| `max_tool_iterations` | [N] | 单 Turn 最大工具调用轮次 |
| `max_history_messages` | [N] | 触发压缩前保留的最大消息条数 |
| `max_context_tokens` | [N] | Context Window 上限 |
| `turn_timeout_ms` | [N] | 单 Turn 超时硬截断 |

---

## 4. Prompt 构建管线 (必填)

> HLD §5 定义了 System Prompt 结构和 Token 预算策略；本节描述组装实现。

### 4.1 System Prompt 节与注入顺序

| 顺序 | 节名 | 来源 | 是否可覆盖 | 条件编译 |
|:---: | :--- | :--- | :---: | :---: |
| 1 | 身份文件 | [如：硬编码 / 配置文件] | 否 | — |
| 2 | 安全规则 | [如：硬编码] | 否 | — |
| 3 | Skills 指令 | [如：Skill 模块加载] | 否 | `enable_skills` |
| 4 | 工具列表 | [如：Tool 模块注册表] | 否 | `enable_tools` |
| 5 | 记忆注入 | [如：Memory 模块检索] | 否 | — |
| 6 | 当前时间 | [如：运行时生成] | 否 | — |
| 7 | 用户消息 | [如：入站消息] | 是 | — |

### 4.2 Context Window 管理

**Token 计数方式：** [如：Provider 返回的 usage 字段 / 本地 tiktoken 估算 / 固定上限预估]

**预算分配：**

| 区域 | 预算占比 | 说明 |
|:--- | :--- | :--- |
| System Prompt | [如：30%] | 身份 + 安全 + Skills + 工具列表 |
| 历史消息 | [如：50%] | 按 FIFO 裁剪 |
| 输出保留 | [如：20%] | Agent 响应 + 工具调用 |

**压缩策略：**

| 触发条件 | 压缩方式 | 说明 |
|:--- | :--- | :--- |
| 消息数 > `max_history` | [Trim / Summarize / 混合] | [选择原因] |
| Token 接近上限 | [Trim / Summarize / 混合] | [选择原因] |

---

## 5. 工具调度机制 (必填)

> HLD §7 定义了工具分级和执行管道；本节描述调度实现。

### 5.1 工具调用解析

[描述从 LLM 输出中解析 tool_call 的实现，如：JSON 解析 → 参数校验 → 风险分级判定]

### 5.2 风险分级校验

| 风险级别 | 判定规则 | 执行路径 |
|:--- | :--- | :--- |
| 低（只读） | [如：工具名在只读白名单中] | 直接执行 |
| 中（写操作） | [如：工具涉及文件/状态修改] | 沙箱执行 |
| 高（不可逆） | [如：工具涉及删除/外部写入] | 沙箱 + Human-in-the-Loop |

### 5.3 执行管道

```
解析 tool_call → 参数校验 → 风险分级 → 安全策略校验 → 沙箱/直接执行 → 结果净化 → 注入消息历史
```

**结果净化规则：**
- [规则 1，如：移除响应中的 API Key 格式字符串]
- [规则 2，如：截断超长工具输出，保留前 N 字符 + 截断标记]

### 5.4 Human-in-the-Loop 实现

| 项 | 说明 |
|:--- | :--- |
| 审批通道 | [如：IM 渠道内联按钮 / Web UI 审批页 / CLI 确认] |
| 超时处理 | [如：超时 [X] 分钟 → 自动拒绝（default-deny）] |
| 批量审批 | [如：同一会话内相同工具连续调用时，允许首次审批后自动放行 N 次] |

---

## 6. 记忆操作实现 (适用时填)

> 触发条件：模块涉及记忆读写逻辑时填写。
> HLD §8 定义了记忆分层和 Scope 隔离规则；本节描述读写管线实现。

### 6.1 记忆读取管线

```
Turn 开始 → 按 scope 过滤 → 检索（精确 / 全文 / 向量） → 去重 → 截断至预算 → 注入 Prompt
```

**检索策略选择：**

| 场景 | 检索方式 | 说明 |
|:--- | :--- | :--- |
| 精确召回 | [如：key + scope 精确查询] | [如：读取特定配置/偏好] |
| 关键词召回 | [如：FTS5 全文搜索] | [如：用户提及关键词时] |
| 语义召回 | [如：向量相似度检索] | [如：模糊问题匹配] |

### 6.2 记忆写入管线

```
Turn 结束 → 提取关键信息 → 写入闸门校验 → 持久化 → 索引更新
```

**写入闸门规则：**

| 规则 | 实现 | 说明 |
|:--- | :--- | :--- |
| Scope 校验 | [如：验证写入身份与 scope 匹配] | [如：personal scope 只能当前用户写入] |
| 去重 / 覆盖 | [如：同 key + scope 执行 Upsert] | [如：偏好类记忆覆盖更新] |
| Scratchpad GC | [如：任务结束后标记为可回收] | [如：Scratchpad 不进入 Main Bus 叙事] |

### 6.3 Scope 隔离实现

| Scope | 可读 | 可写 | 检索过滤条件 |
|:--- | :--- | :--- | :--- |
| global | 所有用户 | 管理员 | `WHERE scope = 'global'` |
| team | 团队成员 | 团队管理员 | `WHERE scope = 'team' AND team_id = ?` |
| personal | 本人 | 本人 | `WHERE scope = 'personal' AND user_id = ?` |
| role | 角色持有者 | 角色管理员 | `WHERE scope = 'role' AND role_id = ?` |

---

## 7. 安全执行 (必填)

> HLD §9 定义了安全威胁和防御措施；本节描述 Agent 层面的安全执行实现。

### 7.1 Prompt Injection 防御

| 防御层 | 实现 | 说明 |
|:--- | :--- | :--- |
| 消息标记 | [如：外部消息标记 `untrusted = true`] | [如：Channel 入站消息一律标记] |
| System Prompt 硬编码 | [如：安全节不可被用户消息覆盖] | [如：组装时固定在位置 2] |
| 前置过滤 | [如：正则检测注入模式] | [如：检测 "ignore previous" 等模式] |

### 7.2 输出净化 (Scrub)

| 规则 | 正则/逻辑 | 说明 |
|:--- | :--- | :--- |
| API Key 移除 | [如：`/sk-[a-zA-Z0-9]{20,}/`] | [如：匹配 OpenAI Key 格式] |
| 内部路径移除 | [如：`/\/(src|internal)\/.*/`] | [如：不暴露内部文件路径] |
| 内部 Key 名移除 | [如：移除 `memory_key://` 前缀] | [如：不暴露记忆键名] |

### 7.3 Token 硬 Budget

| 项 | 值 | 说明 |
|:--- | :--- | :--- |
| 每用户 Token 上限 | [如：100K / 天] | 硬截断，不可绕过 |
| 每 Session Token 上限 | [如：50K] | 硬截断，防止 Denial of Wallet |
| Budget 耗尽行为 | [如：拒绝新请求 + 提示用户] | [如：不静默降级] |

---

## 8. 测试要求 (必填)

### 8.1 Agent 行为测试

| 测试目标 | 测试类型 | 通过条件 |
|:--- | :--- | :--- |
| 正常路径 | 集成测试 | 用户提问 → Agent 正确路由至专家 → 返回响应 |
| 工具调用循环 | 集成测试 | Agent 调用工具 → 获取结果 → 继续推理 |
| 工具调用超限 | 单元测试 | 超过 `max_tool_iterations` → 强制终止并返回摘要 |
| Context 压缩 | 单元测试 | 历史消息超限 → 触发压缩 → Agent 继续正常工作 |

### 8.2 安全测试

| 测试目标 | 测试类型 | 通过条件 |
|:--- | :--- | :--- |
| Prompt Injection 防御 | 单元测试 | 外部消息包含指令覆盖 → Agent 不执行覆盖指令 |
| 输出净化 | 单元测试 | LLM 返回含 API Key → 净化后 Key 被移除 |
| Scope 隔离 | 集成测试 | 用户 A 不可检索用户 B 的 personal 记忆 |
| Token Budget 强制截断 | 单元测试 | 达到上限 → 拒绝新请求 |

### 8.3 记忆操作测试（适用时填）

| 测试目标 | 测试类型 | 通过条件 |
|:--- | :--- | :--- |
| 精确召回 | 集成测试 | 按 key + scope 查询 → 返回正确记忆 |
| 跨 Scope 隔离 | 集成测试 | global 与 personal 同名 key 独立存在 |
| 写入闸门 | 集成测试 | 跨 scope 写入被拒绝，返回错误 |

### 8.4 降级与失败测试

| 测试目标 | 测试类型 | 通过条件 |
|:--- | :--- | :--- |
| Provider 超时 | 单元测试（Mock）| LLM 调用超时 → Fallback / 返回错误 |
| 记忆后端不可达 | 单元测试（Mock）| 降级为纯 Working Memory → 明确告知用户 |
| 沙箱启动失败 | 单元测试（Mock）| 拒绝工具执行 → 返回审批失败 |
| HITL 超时 | 单元测试 | 审批超时 → 自动拒绝（default-deny）|
