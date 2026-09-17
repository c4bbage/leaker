---
title: "[模块名] 原生 App 任务清单"
module_type: native-app
status: draft
date: ""
---

# [MODULE_NAME] 原生 App 任务清单

## 文档信息

| 属性 | 内容 |
| :--- | :--- |
| **所属变更** | [CHANGE_ID] |
| **模块名称** | [MODULE_NAME] |
| **模块类型** | native-app |
| **创建时间** | [CREATED_AT] |

---

## 任务格式

```
- [ ] T{NNN} [P?] {优先级} 任务描述（含具体文件路径）
  depends: T{NNN}, T{NNN}@{other-module}
  ds: DS-NNN
```

| 标记 | 含义 |
| :--- | :--- |
| `T{NNN}` | 模块内唯一编号，从 TNNN 起编 |
| `[P]` | 可并行：操作不同文件、无依赖未完成任务 |
| 优先级 | P0（必须）/ P1（重要）/ P2（可选） |
| `depends:` | 依赖标注（缩进换行）。模块内：`TNNN`；跨模块：`TNNN@login-page`。无依赖则不写此行 |
| `ds:` | 设计追溯（缩进换行）。指向实现该任务的 `DS-NNN`；纯工程任务可不写此行 |

---

## 阶段 1：环境与基础

**目标**：工程配置、依赖管理、CI 流水线、公共基础设施就绪，App 可在真机 / 模拟器运行

- [ ] TNNN [P] P0 工程初始化（Xcode Project / Android Gradle 配置）
- [ ] TNNN [P] P0 依赖管理配置（SPM / CocoaPods / Gradle dependencies）
- [ ] TNNN [P] P0 依赖注入容器 / 服务定位器配置
- [ ] TNNN [P] P0 网络客户端基础（URLSession / Retrofit / Ktor，含拦截器）
- [ ] TNNN [P] P0 本地存储初始化（Core Data / Room / SQLite schema 创建）
- [ ] TNNN [P] P1 深色模式 / 主题系统配置
- [ ] TNNN [P] P1 CI 流水线：编译 + 单元测试（Fastlane / GitHub Actions）

**✓ 检查点**：App 可在模拟器启动，空白主界面正常显示

---

## 阶段 2：数据层

**目标**：本地数据库 Schema、Repository 实现、远程数据同步基础设施就绪

- [ ] TNNN [P] P0 数据库 Schema 迁移脚本（参照 data-model.md）
- [ ] TNNN [P] P0 Entity / Model 定义（`Models/[Entity].swift` / `data/model/`）
- [ ] TNNN P0 Repository 实现（本地读写 + 远程同步逻辑）
  depends: TNNN, TNNN
- [ ] TNNN [P] P0 API DTO 定义与 Codable / Serializable 配置
- [ ] TNNN [P] P1 离线缓存策略（Cache-first / Network-first / Stale-while-revalidate）
- [ ] TNNN [P] P1 数据同步冲突解决策略

**✓ 检查点**：本地 CRUD 操作正常，远程 API 调用可返回数据

---

## 阶段 3：功能实现

**目标**：按业务功能模块实现 ViewModel、UI Screen 和导航流程

<!-- 按 spec.md 中的功能模块/用户故事组织子节 -->

### 功能模块 1 — [功能名称]

**对应验收标准**：AC-NN, AC-NN

- [ ] TNNN P0 ViewModel / Presenter `ViewModels/[Feature]ViewModel.swift`
  depends: TNNN
- [ ] TNNN P0 UI Screen 实现 `Views/[Feature]/[Feature]View.swift`
  depends: TNNN
- [ ] TNNN P0 导航路由注册
- [ ] TNNN P1 加载态 / 错误态 / 空态 UI
- [ ] TNNN P2 动画与过渡效果

**✓ 检查点**：[功能模块 1] 完整用户流程可走通

### 功能模块 2 — [功能名称]

**对应验收标准**：AC-NN

- [ ] TNNN P0 ViewModel `ViewModels/[Feature]ViewModel.swift`
- [ ] TNNN P0 UI Screen 实现
- [ ] TNNN P1 [其他任务]

**✓ 检查点**：[功能模块 2] 完整用户流程可走通

---

## 阶段 4：收尾与质量

**目标**：UI 自动化测试、内存安全、性能优化、发布构建验证

- [ ] TNNN P0 UI 自动化测试（XCUITest / Espresso 核心流程覆盖）
- [ ] TNNN [P] P0 内存泄漏检测（Instruments Leaks / LeakCanary）
- [ ] TNNN [P] P1 性能分析（启动时间 / 帧率 / 内存峰值 Instruments / Android Profiler）
- [ ] TNNN [P] P1 网络安全验证（Certificate Pinning / TLS 配置）
- [ ] TNNN [P] P1 权限声明审核（Info.plist / AndroidManifest.xml 最小化权限）
- [ ] TNNN [P] P2 发布构建验证（Release / Archive，签名与混淆配置）
- [ ] TNNN [P] P2 深色模式 / 动态字体 UI 验收

**✓ 检查点**：UI 测试全通过，内存无泄漏，Release 构建可安装

---

## 任务统计

| 指标 | 数值 |
| :--- | :--- |
| 总任务数 | 0 |
| P0（必须） | 0 |
| P1（重要） | 0 |
| P2（可选） | 0 |
| 可并行任务 | 0 |
| 预计工时 | 0h |
