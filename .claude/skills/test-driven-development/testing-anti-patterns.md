# 测试反模式

**在以下情况加载此参考：** 编写或修改测试、添加 mock、或想往生产代码里加测试专用方法时。

## 概述

测试必须验证真实行为，而非 mock 行为。Mock 是隔离的手段，不是被测的对象。

**核心原则：** 测代码做了什么，而非测 mock 做了什么。

**严格遵循 TDD 可以防止这些反模式。**

## 铁律

```
1. 永远不要测试 mock 行为
2. 永远不要在生产类中添加测试专用方法
3. 永远不要在不理解依赖的情况下 mock
```

## 反模式 1：测试 Mock 行为

**违规写法：**
```typescript
// ❌ 错误：测试 mock 是否存在
test('renders sidebar', () => {
  render(<Page />);
  expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
});
```

**错在哪里：**
- 你在验证 mock 能工作，而非组件能工作
- mock 在则通过，mock 不在则失败
- 对真实行为什么都说明不了

**用户的纠正：** "我们是在测试 mock 的行为吗？"

**正确写法：**
```typescript
// ✅ 正确：测试真实组件，或者不要 mock 它
test('renders sidebar', () => {
  render(<Page />);  // 不要 mock sidebar
  expect(screen.getByRole('navigation')).toBeInTheDocument();
});

// 或者如果 sidebar 必须被 mock 以实现隔离：
// 不要断言 mock —— 测试 Page 在 sidebar 存在时的行为
```

### 门控函数

```
在对任何 mock 元素做断言之前：
  问自己："我是在测试真实组件行为，还是只是在测试 mock 的存在？"

  如果在测试 mock 的存在：
    停 —— 删掉这个断言，或者取消 mock 这个组件

  改为测试真实行为
```

## 反模式 2：生产代码中的测试专用方法

**违规写法：**
```typescript
// ❌ 错误：destroy() 只在测试中使用
class Session {
  async destroy() {  // 看起来像生产 API！
    await this._workspaceManager?.destroyWorkspace(this.id);
    // ... 清理
  }
}

// 在测试中
afterEach(() => session.destroy());
```

**错在哪里：**
- 生产类被测试专用代码污染
- 在生产环境被意外调用会很危险
- 违反 YAGNI 和关注点分离
- 混淆了对象生命周期与实体生命周期

**正确写法：**
```typescript
// ✅ 正确：测试工具处理测试清理
// Session 没有 destroy() —— 在生产环境中它是无状态的

// 在 test-utils/ 中
export async function cleanupSession(session: Session) {
  const workspace = session.getWorkspaceInfo();
  if (workspace) {
    await workspaceManager.destroyWorkspace(workspace.id);
  }
}

// 在测试中
afterEach(() => cleanupSession(session));
```

### 门控函数

```
在给生产类添加任何方法之前：
  问自己："这个方法只有测试在用吗？"

  如果是：
    停 —— 不要加
    放到测试工具里

  问自己："这个类拥有这个资源的生命周期吗？"

  如果否：
    停 —— 这个方法放错类了
```

## 反模式 3：不理解依赖就 Mock

**违规写法：**
```typescript
// ❌ 错误：Mock 破坏了测试逻辑
test('detects duplicate server', () => {
  // Mock 阻止了测试依赖的配置写入！
  vi.mock('ToolCatalog', () => ({
    discoverAndCacheTools: vi.fn().mockResolvedValue(undefined)
  }));

  await addServer(config);
  await addServer(config);  // 应该抛异常 —— 但不会！
});
```

**错在哪里：**
- 被 mock 的方法有测试依赖的副作用（写配置）
- 为了"安全"而过度 mock，破坏了实际行为
- 测试因错误的原因通过，或莫名其妙地失败

**正确写法：**
```typescript
// ✅ 正确：在正确的层级 mock
test('detects duplicate server', () => {
  // Mock 慢的部分，保留测试需要的行为
  vi.mock('MCPServerManager'); // 只 mock 慢的服务器启动

  await addServer(config);  // 配置被写入
  await addServer(config);  // 检测到重复 ✓
});
```

### 门控函数

```
在 mock 任何方法之前：
  停 —— 先不要 mock

  1. 问自己："真实方法有什么副作用？"
  2. 问自己："这个测试依赖其中任何副作用吗？"
  3. 问自己："我完全理解这个测试需要什么吗？"

  如果依赖副作用：
    在更低的层级 mock（实际慢的/外部的操作）
    或者使用保留必要行为的测试替身
    不要 mock 测试依赖的高层方法

  如果不确定测试依赖什么：
    先用真实实现跑测试
    观察实际需要什么发生
    然后在正确的层级添加最少的 mock

  红旗信号：
    - "我 mock 这个以防万一"
    - "这个可能很慢，最好 mock 掉"
    - 不理解依赖链就 mock
```

## 反模式 4：不完整的 Mock

**违规写法：**
```typescript
// ❌ 错误：部分 mock —— 只有你认为需要的字段
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' }
  // 缺少：下游代码使用的 metadata
};

// 之后：当代码访问 response.metadata.requestId 时崩溃
```

**错在哪里：**
- **部分 mock 隐藏了结构假设** —— 你只 mock 了你知道的字段
- **下游代码可能依赖你没包含的字段** —— 静默失败
- **测试通过但集成失败** —— mock 不完整，真实 API 完整
- **虚假的信心** —— 测试对真实行为什么都证明不了

**铁律：** Mock 要镜像现实中完整的真实数据结构，而非只包含你当前测试用的字段。

**正确写法：**
```typescript
// ✅ 正确：镜像真实 API 的完整性
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' },
  metadata: { requestId: 'req-789', timestamp: 1234567890 }
  // 真实 API 返回的所有字段
};
```

### 门控函数

```
在创建 mock 响应之前：
  检查："真实 API 响应包含哪些字段？"

  操作：
    1. 从文档/示例中查看实际 API 响应
    2. 包含系统下游可能消费的所有字段
    3. 验证 mock 完全匹配真实响应的 schema

  关键：
    如果你在创建 mock，你必须理解完整的结构
    部分 mock 在代码依赖被省略的字段时会静默失败

  如果不确定：包含所有文档记录的字段
```

## 反模式 5：集成测试是事后补的

**违规写法：**
```
✅ 实现完成
❌ 没有写测试
"准备好测试了"
```

**错在哪里：**
- 测试是实现的一部分，不是可选的后续步骤
- TDD 会防止这种情况
- 没有测试就不能声称完成

**正确写法：**
```
TDD 循环：
1. 写失败测试
2. 实现让它通过
3. 重构
4. 然后才能声称完成
```

## 反模式 6：同义反复测试

**违规写法：**
```typescript
// ❌ 错误：期望值用和代码相同的逻辑算出来
test('calculateTotal sums line items', () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});
```

**错在哪里：**
- 期望值是对实现的复述，测试天生就通过
- 代码错了，测试也跟着错，永远抓不到 bug
- 快照测试手工用同样方式推导，也是同义反复

**正确写法：**
```typescript
// ✅ 正确：期望值是独立的已知字面量
test('calculateTotal sums line items', () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```

### 门控函数

```
在写断言之前：
  问自己："这个期望值是从哪里来的？"

  如果它是用和被测代码相同的逻辑算出来的：
    停 —— 换一个独立的来源
    用已知正确的字面量、手算的例子、或规格文档

  期望值必须来自独立的真相来源，永远不能来自实现本身
```

## 反模式 7：水平切片

**违规写法：**
```
先写完所有测试（10 个）
再写完所有实现
```

**错在哪里：**
- 批量测试验证的是**想象中的行为**：你测的是事情的形状，而非用户可见的行为
- 测试对真实变化变得迟钝
- 在理解实现之前就锁定了测试结构
- 第一个测试发现的问题，后面的测试无法响应

**正确写法：**
```
垂直切片，一次一个：
  一个测试 → 一个最小实现 → 下一个测试 → ...
每个测试是曳光弹，响应上一个循环学到的东西
```

### 门控函数

```
在写第二个测试之前：
  问自己："上一个测试的实现完成了吗？"

  如果否：
    停 —— 先完成当前循环
    一个 seam，一个测试，一个最小实现

  如果你发现自己在批量写测试：
    停 —— 你在测想象中的行为
    回到垂直切片
```

## 当 Mock 变得太复杂时

**警告信号：**
- Mock 准备代码比测试逻辑还长
- 为了让测试通过而 mock 所有东西
- Mock 缺少真实组件拥有的方法
- 移除 mock 后测试就挂了

**用户的追问：** "我们在这里需要用 mock 吗？"

**考虑：** 用真实组件的集成测试，通常比复杂的 mock 更简单

## TDD 防止这些反模式

**为什么 TDD 有效：**
1. **先写测试** → 迫使你思考你实际在测什么
2. **看它失败** → 确认测试测的是真实行为，不是 mock
3. **最小实现** → 测试专用方法不会偷偷混进来
4. **真实依赖** → 在 mock 之前你能看到测试实际需要什么

**如果你在测试 mock 行为，你违反了 TDD** —— 你在没有先看测试对真实代码失败的情况下就添加了 mock。

## 快速参考

| 反模式 | 修正 |
|--------|------|
| 断言 mock 元素 | 测试真实组件或取消 mock |
| 生产代码中的测试专用方法 | 移到测试工具里 |
| 不理解依赖就 mock | 先理解依赖，最少化 mock |
| 不完整的 mock | 完整镜像真实 API |
| 测试是事后补的 | TDD —— 测试先行 |
| 过于复杂的 mock | 考虑集成测试 |
| 同义反复测试 | 期望值用独立字面量，不复述实现逻辑 |
| 水平切片（批量写测试） | 垂直切片：一个测试 → 一个实现 → 循环 |

## 红旗信号

- 断言检查 `*-mock` 测试 ID
- 方法只在测试文件中被调用
- Mock 准备代码占测试的 50% 以上
- 移除 mock 后测试就失败
- 说不清为什么需要 mock
- "以防万一"而 mock
- 期望值是用和被测代码相同的逻辑算出来的
- 一次性写了多个测试，还没有任何实现

## 底线

**Mock 是用来隔离的工具，不是被测的对象。**

如果 TDD 揭示你在测试 mock 行为，说明你走错了。

修正：测试真实行为，或者质疑你为什么要 mock。
