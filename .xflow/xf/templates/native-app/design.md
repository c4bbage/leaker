---
title: "[模块名] — 原生 App 模块设计"
module_type: native-app
version: "0.1"
status: draft
date: ""
---

# 原生 App 模块设计（Design）

> **模板用途：** 描述单个功能模块的 ViewModel 设计、View 绑定模式、副作用隔离和网络层实现。
> **主要技术栈：** SwiftUI（Swift）。其他栈在各节"技术栈注"中替换对应术语。
> 不包含：App 整体状态架构和导航（→ `hld`）；本地 Schema 定义和迁移（→ `data-model`）；对外接口字段（→ `universal/contracts`）。

---

## 1. 概览（必填）

| 字段 | 内容 |
|:--- | :--- |
| 模块名称 | [如：HomeModule / ChatFeature] |
| 所属 App | [引用 hld 中的 App 名] |
| 职责一句话 | [这个模块为用户提供什么功能] |
| 涉及页面 | [列出模块内的页面，如：列表页、详情页、编辑页] |
| 上游依赖 | [依赖哪些 Service / Repository / 网络端点] |

### 1.2 模块职责边界

**负责：**
- ViewModel 设计与 UI 状态管理
- View 与 ViewModel 绑定模式
- 副作用隔离（网络 / DB / 传感器）
- 本地模型引用与网络层封装

**不负责（显式排除）：**
- App 整体状态架构和导航（→ `hld`）
- 本地 Schema 定义和迁移（→ `data-model`）
- 对外接口字段（→ `contracts`）

**调用关系：**

| 方向 | 模块 | 方式 |
|:--- | :--- | :--- |
| 被调用 | [如：导航层 / App 根视图] | 页面跳转后生命周期回调 |
| 调用 | [如：`[NetworkService]`] | 通过 protocol / interface 注入，ViewModel 发起请求 |
| 调用 | [如：`[ItemRepository]`] | 通过 protocol / interface 注入，本地 DB 读写 |

---

## 2. ViewModel 设计（必填）

> ViewModel 持有 UI 状态，处理用户动作，协调副作用（网络 / DB / 传感器）。不持有 View 的引用。

### DS-NNN 状态定义
fr: FR-NNN
depends: DS-NNN, DS-NNN@other-module

> **技术栈注：**
> - SwiftUI：`@Observable` class 或 `@State` struct
> - Kotlin/Compose：`data class UiState` + `StateFlow`
> - Flutter：`ChangeNotifier` / `Riverpod StateNotifier`

| 状态字段 | 类型 | 初始值 | 说明 |
|:--- | :--- | :--- | :--- |
| `[items]` | `[Entity][]` | `[]` | [列表数据] |
| `isLoading` | `boolean` | `false` | 加载中标志 |
| `error` | `AppError \| null` | `null` | 当前错误；nil/null 表示无错误（`AppError` 类型定义见 `hld §错误处理` 或共享 domain 层）|
| `[selectedItem]` | `[Entity] \| null` | `null` | [当前选中项] |
| `[自定义字段]` | `[类型]` | `[初始值]` | `[说明]` |

### 2.2 用户动作（Actions）

| 动作 | 触发来源 | 执行内容 | 副作用 |
|:--- | :--- | :--- | :--- |
| `onAppear()` | 页面出现 | 加载初始数据 | 网络请求 / DB 读取 |
| `onRefresh()` | 下拉刷新 | 重新拉取数据 | 网络请求 |
| `onSelect([item])` | 用户点击 | 更新 selectedItem | 无 |
| `onDelete([id])` | 用户滑动删除 | 删除本地 + 同步远端 | DB 写 + 网络请求 |
| `[自定义动作]` | `[来源]` | `[内容]` | `[副作用类型]` |

> **删除策略（二选一，填写时明确）：**
> - **乐观删除**：立即从本地 UI 移除 → 异步同步服务端 → 失败时回滚（将条目重新插入列表并展示错误）。适用于网络稳定、用户体验优先的场景。
> - **悲观删除**：先请求服务端 → 成功后再删除本地记录。适用于数据一致性要求高的场景。
>
> 本模块选择：**[乐观 / 悲观]**，理由：[填写]

### 2.3 生命周期

| 时机 | 行为 |
|:--- | :--- |
| 初始化（init）| [注入依赖；不发起副作用] |
| 页面出现（onAppear / LaunchedEffect）| [触发 `onAppear()`；启动订阅] |
| 页面消失（onDisappear / DisposableEffect）| [取消订阅；释放资源] |
| App 进入后台 | [暂停非必要任务；保存草稿（适用时）] |

---

## 3. View 与 ViewModel 绑定模式（必填）

> **技术栈注：**
> - SwiftUI：`@Bindable` / `@Environment` / `@State`
> - Kotlin/Compose：`collectAsStateWithLifecycle()` / `remember`
> - Flutter：`Consumer<T>` / `ref.watch()` / `BlocBuilder`

### 3.1 绑定规则

| 规则 | 说明 |
|:--- | :--- |
| **三态渲染优先级：`isLoading > error > empty > 有数据`** | 同时满足多个条件时按此优先级展示：刷新中仍显示 Skeleton（而非旧错误）；有数据时不显示空态 |
| View 只读取状态，不直接修改 | 所有修改通过 ViewModel 动作方法进行 |
| 加载 / 错误 / 空状态三态展示 | `isLoading` → Skeleton；`error != null` → 错误提示；`items.isEmpty` → 空态 |
| 避免在 View 中做业务判断 | if/else 业务逻辑放 ViewModel，View 只做 UI 分支 |
| 大列表使用懒加载组件 | `LazyVStack` / `LazyColumn` / `ListView.builder`；不全量渲染 |

### 3.2 状态更新时机

| 场景 | 更新方式 | 说明 |
|:--- | :--- | :--- |
| 网络请求完成 | 在主线程写入 State | [Swift `@MainActor`；Kotlin `withContext(Main)`；Flutter setState] |
| 用户输入（实时响应）| 本地 `@State` / `remember` | 不经过 ViewModel；适用于纯 UI 状态 |
| 跨页面数据共享 | 通过 App 级 Store / `@Environment` 传递 | 不用全局变量；不用 Singleton（除非有充分理由）|

---

## 4. 副作用隔离（必填）

> 副作用（网络、DB、传感器）通过依赖注入的 Service / Repository 接口调用，不直接在 ViewModel 中操作底层 API。

### 4.1 依赖注入

| 依赖 | 接口类型 | 注入方式 | 说明 |
|:--- | :--- | :--- | :--- |
| `[NetworkService]` | `protocol [NetworkServiceProtocol]` | [初始化注入 / @Environment / DI Container] | [网络请求抽象] |
| `[ItemRepository]` | `protocol [ItemRepositoryProtocol]` | [同上] | [本地 DB 访问抽象] |
| `[自定义依赖]` | `[接口]` | `[方式]` | `[说明]` |

> **技术栈注（接口语法）：**
> - Swift：`protocol XxxProtocol`
> - Kotlin：`interface XxxRepository`
> - Dart/Flutter：`abstract class XxxService`

> **为什么用接口：** 便于单元测试时注入 Mock；便于切换实现（如：从网络切换到本地缓存）。

### 4.2 副作用执行规则

| 副作用类型 | 发起位置 | 取消时机 | 错误处理 |
|:--- | :--- | :--- | :--- |
| 网络请求 | ViewModel 动作方法内 | 页面消失 / 用户取消 | 捕获后写入 `error` 状态 |
| DB 读写 | Repository 封装；ViewModel 异步调用 | 页面消失 | 捕获后写入 `error` 状态 |
| 传感器 / 位置 / 蓝牙 | Service 封装；ViewModel 订阅 | 页面消失时取消订阅 | 捕获后写入 `error` 状态 |
| 定时器 | ViewModel 内部管理 | `deinit` / `onDisappear` 取消 | — |

---

## 5. 网络层实现（有网络调用时必填）

> 网络层选型见 `hld §7`；本节记录本模块具体用到的端点和请求封装。

### 5.1 本模块使用的端点

| 端点 | 方法 | 路径 | 触发动作 | 契约文档 |
|:--- | :---: | :--- | :--- | :--- |
| [获取列表] | GET | `/[resource]` | `onAppear()` | [contracts §4.N] |
| [删除资源] | DELETE | `/[resource]/{id}` | `onDelete()` | [contracts §4.N] |
| [自定义] | [方法] | [路径] | [动作] | [引用] |

### 5.2 请求封装

```
// 示例：封装网络调用，统一处理加载状态和错误
func fetchItems() async {
    isLoading = true
    defer { isLoading = false }
    do {
        items = try await networkService.getItems()
    } catch {
        self.error = AppError(from: error)
    }
}
```

> 将以上伪代码替换为对应技术栈语法（Kotlin suspend fun / Flutter async-await / C# async Task）。

### 5.3 响应缓存策略（适用时填）

| 策略 | 说明 |
|:--- | :--- |
| 首次加载 | [先展示缓存 → 再刷新网络（stale-while-revalidate）/ 直接请求网络] |
| 下拉刷新 | [强制网络请求，刷新成功后更新缓存] |
| 缓存存储位置 | [内存（ViewModel 生命周期）/ 本地 DB（见 `data-model`）] |

---

## 6. 本地 Model 引用（适用时填）

> 本模块使用的本地持久化实体，Schema 详见 `data-model`，此处只记录模块级访问规则。

| 实体 | 操作 | Repository 方法 | 说明 |
|:--- | :--- | :--- | :--- |
| `[Entity]` | 读 | `findBy([条件])` | [如：加载用户收藏列表] |
| `[Entity]` | 写 | `save([item])` | [如：本地缓存网络返回数据] |
| `[Entity]` | 删 | `delete([id])` | [如：软删除] |

---

## 7. 单元测试要求（必填）

| 测试目标 | 测试方式 | 通过条件 |
|:--- | :--- | :--- |
| 动作触发后状态正确更新 | 单元测试（Mock Service）| `onAppear()` 完成后 `items` 非空，`isLoading = false` |
| 网络请求失败时错误状态正确 | 单元测试（Mock 抛异常）| `error != null`，`isLoading = false` |
| 副作用通过接口调用，不直接依赖网络 | 单元测试（注入 Mock）| 无需真实网络即可运行测试 |
| 状态更新在主线程执行 | 单元测试 | 并发场景下 UI 更新不崩溃 |
| 页面消失时副作用被取消 | 单元测试 | onDisappear 后无挂起任务继续执行 |
