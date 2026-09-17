---
title: "[App 名] — 原生 App 高层设计"
module_type: native-app
version: "0.1"
status: Draft
date: "[DATE]"
---

# 原生 App 高层设计（HLD）

> **模板用途：** 描述声明式 UI 原生 App 的整体架构，包括状态管理、导航、内存/并发模型、网络层和本地持久化策略。
> **主要技术栈：** SwiftUI（Swift）。其他栈（Kotlin/Compose、Flutter、WinUI）使用时，将各节"技术栈注"中的术语替换为对应技术，其余约 80% 内容可直接复用。
> 不包含：单个 ViewModel / 页面的实现细节（→ `design`）；本地 Schema 和迁移（→ `data-model`）；对外接口字段（→ `universal/contracts`）。

---

## 1. 概览（必填）

| 字段 | 内容 |
|:--- | :--- |
| App 名称 | [如：AideBot / MyApp] |
| 目标平台 | [iOS / macOS / watchOS / Android / Windows / 跨平台] |
| 实现语言 / 框架 | [Swift + SwiftUI / Kotlin + Compose / Flutter / WinUI 3 / ...] |
| 发布渠道 | [App Store / Google Play / Microsoft Store / 企业分发 / ...] |
| 对外职责 | [一句话描述 App 为用户做什么] |
| 主要后端依赖 | [REST API 地址 / GraphQL / 无（纯本地）] |

---

## 2. 技术上下文（必填）

| 维度 | 决策 | 备注 |
|:--- | :--- | :--- |
| 语言 / SDK 版本 | [Swift 5.10 / Kotlin 2.0 / Dart 3.x / ...] | |
| 最低支持系统版本 | [iOS 17 / Android 10 / ...] | |
| 构建工具 | [Xcode / Gradle / Flutter CLI / ...] | |
| 本地持久化方案 | [SwiftData / Room / Drift / SQLite.NET / CoreData] | |
| 云同步方案 | [CloudKit / Firebase / Azure / 无] | |
| 网络库 | [URLSession / Ktor / Dio / HttpClient / ...] | |
| CI / CD | [Xcode Cloud / GitHub Actions / Fastlane / ...] | |

---

## 3. 状态管理架构（必填）

> 定义数据如何在 App 中流动，以及各层级状态容器的职责。

### 3.1 状态层级

```
[全局状态]     AppStore / @Observable ViewModel（跨多页面共享）
    │
[页面状态]     @State / ViewModel（单页面生命周期）
    │
[组件状态]     @State / 局部变量（组件内部，不对外暴露）
```

> **技术栈注：**
> - SwiftUI：`@Observable` / `@State` / `@Environment`
> - Kotlin/Compose：`ViewModel` + `StateFlow` / `remember`
> - Flutter：`Provider` / `Riverpod` / `Bloc` + `StatefulWidget`
> - WinUI / MAUI：`ObservableObject` + `INotifyPropertyChanged`

### 3.2 状态容器职责

| 层级 | 容器类型 | 职责 | 生命周期 |
|:--- | :--- | :--- | :--- |
| 全局 | `[AppStore / AppViewModel]` | [跨页面共享数据，如：用户登录状态、主题、全局配置] | App 生命周期 |
| 页面 | `[PageViewModel]` | [单页面的 UI 状态、加载状态、错误状态] | 页面生命周期 |
| 组件 | `[局部 @State]` | [仅影响当前组件的瞬态，如：展开/折叠] | 组件生命周期 |

### 3.3 单向数据流

```
用户操作 → ViewModel.action() → 更新 State → View 重新渲染
                │
           副作用（网络 / DB）→ 结果回写 State
```

---

## 4. 导航架构（必填）

### 4.1 导航方案选型

| 字段 | 内容 |
|:--- | :--- |
| 主导航结构 | [Tab 切换 / 侧边栏 / 单栈导航] |
| 导航实现 | [NavigationStack / NavHost / go_router / NavigationView] |
| Deep Link | [支持 / 不支持；URL Scheme：`[app-scheme://]`] |
| HTTPS 深度链接（Universal Links / App Links）| [支持 / 不支持；域名：`[domain]`；iOS 用 Universal Links，Android 用 App Links] |

### 4.2 页面栈结构

```
[根视图 / 主 Tab]
    ├─ [Tab 1：功能模块 A]
    │       └─ [详情页] → [编辑页]
    ├─ [Tab 2：功能模块 B]
    │       └─ [列表页] → [详情页]
    └─ [Tab 3：设置]
            └─ [子设置页]

[模态展示（Sheet / Dialog）]：[登录 / 权限申请 / 操作确认]
```

> 根据实际页面结构修改；填写触发全局 Sheet 的场景。

---

## 5. 内存管理规则（必填）

> **技术栈注：**
> - Swift（ARC）：填写 `weak` / `unowned` 使用规则，防止循环引用
> - Kotlin / Dart / .NET（GC）：填写对象生命周期和 Dispose 规则，防止内存泄漏
> - Flutter：填写 `dispose()` 调用规范

| 场景 | 规则 |
|:--- | :--- |
| ViewModel → View 引用（**Swift ARC Only**：其他 GC 栈跳过此行）| `weak` capture；闭包中用 `[weak self]` 防止循环引用 |
| Combine / 响应式订阅 | 存储在 `Set<AnyCancellable>` / `viewModelScope`；页面消亡时自动取消 |
| 大图 / 缓存资源 | 使用 `NSCache` / `LRU Cache`；设置 countLimit / totalCostLimit |
| 外部资源（文件 / 网络流）| 使用 `defer` / `using` / `try-with-resources` 确保释放 |
| [自定义规则] | [描述] |

**内存泄漏检测：** [Instruments Leaks / LeakCanary / Dart DevTools / 定期 Profile 节点]

---

## 6. 并发模型（必填）

> **技术栈注：**
> - Swift：MainActor 保护 UI，async/await + structured concurrency
> - Kotlin：Coroutines + Dispatcher（Main / IO / Default）
> - Flutter：Dart Isolates（CPU 密集）+ async/await（I/O）
> - .NET MAUI：STA 线程 + Task.Run / await

### 6.1 线程规则

| 操作类型 | 执行线程 | 规则 |
|:--- | :--- | :--- |
| UI 更新 | 主线程 | [所有 State 写入必须在主线程；Swift 用 `@MainActor`，Kotlin 用 `withContext(Dispatchers.Main)`] |
| 网络请求 | 后台线程 | 需显式调度到后台：Swift 在非 `@MainActor` 上下文调用，或使用 `Task { }` + 后台执行器；Kotlin 用 `withContext(Dispatchers.IO)`；Flutter async/await 天然非阻塞主线程 |
| 数据库读写 | 后台线程 | [避免主线程阻塞；ORM 框架通常内置后台调度] |
| 大量计算 | 后台线程 | [Swift `Task.detached` / Kotlin `Dispatchers.Default` / Dart `Isolate`] |

### 6.2 并发安全规则

- [规则 1，如：所有 @Observable 对象只在主线程修改]
- [规则 2，如：跨 Isolate 的数据通过 SendPort 传递，不共享可变状态]
- [规则 3，如：避免在 viewModelScope 外启动不受管理的协程]

---

## 7. 网络层架构（必填）

### 7.1 网络层选型

| 字段 | 内容 |
|:--- | :--- |
| 网络库 | [URLSession / Ktor / Dio / Retrofit / ...] |
| 序列化 | [Codable（Swift）/ kotlinx.serialization / json_serializable / System.Text.Json] |
| 认证方式 | [Bearer Token / API Key / OAuth2；Token 存储：Keychain / EncryptedSharedPreferences / SecureStorage] |
| 基础 URL | [如：`https://api.[domain].com/v1`] |
| 超时配置 | [连接超时：[X] s；读取超时：[X] s] |

### 7.2 请求 / 响应拦截器

| 拦截器 | 用途 |
|:--- | :--- |
| 认证注入 | 每个请求自动附加 Authorization Header |
| Token 刷新 | 收到 401 时静默刷新 Token 并重试原请求（最多 1 次）|
| 错误统一处理 | 网络错误 / 超时 / 5xx 转换为统一 AppError 类型 |
| 请求日志 | Debug 模式下打印请求 / 响应摘要（不含敏感字段）|

### 7.3 离线与缓存策略（适用时填）

| 策略 | 说明 |
|:--- | :--- |
| 离线读 | [读本地缓存；无缓存时展示空状态 / 错误提示] |
| 离线写 | [写入本地队列；网络恢复后批量同步（见 §9）] |
| 缓存过期 | [缓存有效期：[X] min；超时强制刷新] |

---

## 8. 本地持久化策略（必填）

| 数据类型 | 存储方案 | 说明 |
|:--- | :--- | :--- |
| 用户偏好 / 配置 | [UserDefaults / SharedPreferences / AppStorage] | 轻量 KV，不放敏感数据 |
| 结构化业务数据 | [SwiftData / Room / Drift / SQLite.NET] | 详细 Schema 见 `data-model` |
| 敏感数据（Token / 密码）| [Keychain / EncryptedSharedPreferences / SecureStorage] | 系统级加密存储 |
| 大文件 / 媒体缓存 | [FileManager / 缓存目录 / 平台文件 API] | 设置容量上限，定期清理 |

---

## 9. 云同步与离线策略（适用时填）

> 适用条件：App 有跨设备数据同步或离线写入需求时填写。

| 字段 | 内容 |
|:--- | :--- |
| 同步方案 | [CloudKit / Firebase Firestore / Azure Cosmos DB / 自研 REST 同步 / 无] |
| 同步模型 | [实时增量同步 / 定时批量同步 / 用户手动触发] |
| 冲突解决策略 | [Last-Write-Wins / Server-Wins / Client-Wins / 手动合并] |
| 离线写入队列 | [写入本地 DB 队列表 → 网络恢复后同步；失败重试次数：[N]；**队列表 Schema 设计见 `data-model`**] |
| 数据一致性保证 | [最终一致性 / 强一致性（仅支持在线操作）] |

---

## 10. 扩展点与权限声明（必填）

> 列出 App 使用的系统权限和扩展能力，在发布前确认已在 Manifest / Info.plist 中声明。

| 权限 / 扩展 | 用途 | 申请时机 |
|:--- | :--- | :--- |
| [推送通知] | [如：任务完成提醒] | [用户首次进入设置页时申请] |
| [相机 / 麦克风] | [如：扫码 / 语音输入] | [用户触发相关功能时申请] |
| [位置] | [如：就近搜索] | [用户触发地图功能时申请；精度：精确 / 模糊] |
| [后台刷新] | [如：同步数据] | [App 安装后自动配置] |
| [Widget / App Extension] | [如：主屏小组件] | — |
| [自定义] | [描述] | [时机] |

---

## 11. 安全设计（必填）

| 威胁 | 防御措施 |
|:--- | :--- |
| 敏感数据明文存储 | Token / 密码只存 Keychain / SecureStorage，不存 UserDefaults |
| 网络中间人攻击 | 强制 TLS 1.2+；启用 Certificate Pinning（适用时）|
| 逆向工程 / 注入 | 混淆敏感逻辑；不在客户端存储 API 私钥 |
| 越权访问 | Server 端校验权限，客户端仅做 UI 隐藏，不作安全边界 |
| 截屏 / 录屏泄漏 | 敏感页面（支付、密码）进入后台时模糊屏幕内容 |
| 深度链接劫持 | 使用 Universal Links（HTTPS）代替纯 URL Scheme；校验来源 |
| 路径遍历 | 文件路径操作前规范化并验证是否在应用沙箱目录内；拒绝 `../` 序列 |

---

## 12. 观测与运维（必填）

### 质量目标

| 指标 | 目标值 | 说明 |
|:--- | :---: | :--- |
| 冷启动时间 | ≤ [X] s | 从点击图标到首帧可交互 |
| 崩溃率（Crash-free sessions）| ≥ [X]% | 滚动 7 天 |
| ANR / 主线程卡顿（> 16 ms）| ≤ [X]% | 使用 Instruments / Profiler 检测 |
| 内存峰值 | ≤ [X] MB | 典型使用场景下 |

### 崩溃与错误收集

| 维度 | 方案 |
|:--- | :--- |
| 崩溃收集 | [Firebase Crashlytics / Sentry / Bugsnag / Xcode Organizer] |
| 性能监控 | [Firebase Performance / Datadog / Xcode Instruments] |
| 用户行为分析 | [Firebase Analytics / Mixpanel / 无] |

### 日志与追踪

| 维度 | 方案 |
|:--- | :--- |
| 设备日志 | [系统日志框架，如 `os_log`（iOS）/ `Logcat`（Android）；Debug 模式详细，Release 模式仅 Error+] |
| 网络请求日志 | [Debug 模式下记录请求/响应摘要，不含 Token 或敏感 Body] |
| 用户行为追踪 | [Firebase Analytics / Mixpanel / 无；PII 字段不入事件属性] |

### 健康检查

| 检查项 | 判定条件 | 失败行为 |
|:--- | :--- | :--- |
| 本地数据库可用 | App 启动时执行完整性检查，返回 ok | 提示用户重置 / 重新初始化 |
| 必要权限状态 | 检查核心功能所需权限是否已授予 | 引导用户授权，降级展示功能 |
| 本地配置完整性 | 必填配置项非空且格式合法 | 引导用户完成初始配置 |

---

## 13. 失败模式与降级（必填）

| 失败场景 | 影响 | 降级策略 | 恢复方式 |
|:--- | :--- | :--- | :--- |
| 本地数据库不可用 | [关键功能失效] | [只读模式展示缓存；禁用写操作，提示用户] | [App 重启后重新初始化 DB] |
| 网络长期中断 | [数据无法同步] | [维持离线状态，操作写入本地队列；UI 展示离线标识] | [网络恢复后自动触发批量同步] |
| 云同步冲突无法自动解决 | [数据不一致] | [标记冲突条目，展示差异供用户手动选择；不静默覆盖] | [用户解决后状态回归正常同步] |
| Token 过期且刷新失败 | [用户被登出] | [清除本地凭证，跳转登录页；本地数据保留不清除] | [重新登录后恢复会话] |
| 系统权限被永久拒绝 | [相关功能不可用] | [引导用户到系统设置；降级展示功能占位，不崩溃] | [用户重新授权后自动生效] |
| App 从后台唤醒状态异常 | [UI 状态不一致] | [强制刷新当前页面数据；重置不稳定的临时状态] | [自动恢复] |
| [自定义场景] | [描述] | [策略] | [恢复] |
