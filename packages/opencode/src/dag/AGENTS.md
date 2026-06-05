# DAG 工作流引擎 - 开发者指南

## 概述

DAG 工作流引擎是 opencode 的核心扩展模块，实现了基于有向无环图的任务编排系统。本文档为开发者提供二次开发和维护的指导。

## 架构约束

### 四条铁律（不可违反）

DAG 引擎遵循严格的铁律约束，任何代码修改都必须遵守：

1. **铁律 #1: 状态机不可绕过**
   - 所有状态变更必须通过状态机 API（`StateMachine.emit()`）
   - 禁止直接修改状态变量
   - 违反将导致状态不一致和难以调试的 bug

2. **铁律 #2: 终态不可逆**
   - 一旦进入终态（`completed`, `failed`, `cancelled`），禁止状态回退
   - 状态转换必须通过 `STATE_TRANSITIONS` 表验证
   - 非法转换抛出 `WorkflowError`

3. **铁律 #3: 事件必须广播**
   - 每个状态变更必须发出对应事件
   - 事件包含完整上下文（old_state, new_state, trigger, timestamp）
   - 事件通过 `event_bus` 传播到所有订阅者

4. **铁律 #4: 状态持久化优先**
   - 内存状态变更之前必须先持久化到 SQLite
   - 持久化失败时回滚内存状态
   - 使用 rollback 模式确保一致性

### 跨模块设计模式

所有 DAG 模块遵循统一的设计模式（详见 `ARCHITECTURE.md` §0）：

#### §0.1 构造函数依赖注入
```typescript
// 正确模式
constructor(
  required: IRequiredDep,
  optional?: IOptionalDep
)

// 禁止硬编码依赖
constructor() {
  this.dep = new ConcreteDep() // ❌ 禁止
}
```

#### §0.2 事件广播统一模式
```typescript
// 正确模式（所有模块）
this.eventBus.emit({
  type: 'module.entity.event_type',
  entity_id: id,
  old_state: oldState,
  new_state: newState,
  trigger: trigger,
  timestamp: Date.now()
})

// 禁止自建事件通道
this.listeners.forEach(fn => fn(event)) // ❌ 禁止
```

#### §0.3 状态持久化优先模式
```typescript
// 正确模式（rollback 模式）
async setState(id: string, newState: State) {
  const oldState = await this.getState(id)
  try {
    await this.persister.setState(id, newState) // 先持久化
    this.memoryState.set(id, newState)          // 后更新内存
    this.eventBus.emit(...)                     // 最后广播
  } catch (error) {
    // 持久化失败时内存状态保持不变（rollback 自动生效）
    throw new StateError(id, error)
  }
}
```

#### §0.4 跨模块类型桥接
```typescript
// 正确模式（类型桥接）
this.eventBus.emit({
  type: 'group.state_changed',
  // ... group-specific fields
} as unknown as WorkflowEvent | NodeEvent)

// 禁止类型断言绕过
this.eventBus.emit(event as any) // ❌ 禁止
```

## 模块开发清单

### 创建新模块前检查

在开发新的 DAG 模块之前，必须完成以下检查清单：

- [ ] **阅读 `ARCHITECTURE.md` §0-§3**，理解现有模块的设计模式
- [ ] **检查依赖关系图**（`ARCHITECTURE.md` §5），避免循环依赖
- [ ] **定义清晰的接口边界**（参考 `IStateManager.ts`）
- [ ] **确认事件类型命名规范**（`module.entity.event_type`）
- [ ] **准备单元测试框架**（Jest + SQLite mock）

### 模块开发流程

#### 1. 定义接口
```typescript
// types.ts
export interface IMyModule {
  // 只读操作
  getState(id: string): Promise<Readonly<EntityState>>
  
  // 写入操作（必须返回新状态）
  setState(id: string, newState: EntityState): Promise<void>
  
  // 查询操作
  getAll(): Promise<ReadonlyArray<EntityState>>
}
```

#### 2. 实现模块骨架
```typescript
// MyModule.ts
export class MyModule implements IMyModule {
  private memoryState: Map<string, EntityState>
  private persister: IStatePersister
  private eventBus: IEventBus

  constructor(
    persister: IStatePersister,
    eventBus: IEventBus
  ) {
    this.memoryState = new Map()
    this.persister = persister
    this.eventBus = eventBus
  }

  async setState(id: string, newState: EntityState): Promise<void> {
    // 实现铁律 #4: 持久化优先
    const oldState = this.memoryState.get(id)
    try {
      await this.persister.setState(id, newState)
      this.memoryState.set(id, newState)
      this.eventBus.emit({
        type: 'my_module.state_changed',
        entity_id: id,
        old_state: oldState ?? null,
        new_state: newState,
        trigger: 'api_call',
        timestamp: Date.now()
      } as unknown as WorkflowEvent | NodeEvent)
    } catch (error) {
      throw new StateError(id, error)
    }
  }
}
```

#### 3. 编写测试
```typescript
// __tests__/MyModule.test.ts
describe('MyModule', () => {
  describe('铁律 #1: 状态机不可绕过', () => {
    it('should emit events for all state changes', async () => {
      const events: any[] = []
      const eventBus = createMockEventBus(events)
      const module = new MyModule(createMockPersister(), eventBus)
      
      await module.setState('1', { status: 'running' })
      
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('my_module.state_changed')
    })
  })

  describe('铁律 #4: 状态持久化优先', () => {
    it('should persist state before updating memory', async () => {
      const calls: string[] = []
      const persister = {
        setState: async () => { calls.push('persist') }
      }
      const module = new MyModule(persister, createMockEventBus())
      
      await module.setState('1', { status: 'running' })
      
      expect(calls).toEqual(['persist'])
    })
  })
})
```

#### 4. 文档化
- 在 `ARCHITECTURE.md` 中添加模块章节（§X）
- 更新依赖关系图（§5）
- 在设计模式检查表中添加模块（§0.5）

## 测试指南

### 测试命名规范

```typescript
// 正确命名（清晰描述测试内容）
it('should emit events for all state changes (Iron Law #1)', ...)
it('should reject terminal state reversal (Iron Law #2)', ...)
it('should persist state before updating memory (Iron Law #4)', ...)

// 禁止模糊命名
it('should work', ...)        // ❌ 太模糊
it('test state transition', ...) // ❌ 缺少铁律参考
```

### 测试组织

```typescript
describe('StateMachine', () => {
  // 按铁律组织测试
  describe('铁律 #1: 状态机不可绕过', () => { ... })
  describe('铁律 #2: 终态不可逆', () => { ... })
  describe('铁律 #3: 事件必须广播', () => { ... })
  describe('铁律 #4: 状态持久化优先', () => { ... })
  
  // 按功能组织测试
  describe('状态转换验证', () => { ... })
  describe('并发安全', () => { ... })
  describe('错误恢复', () => { ... })
})
```

### SQLite Mock 模式

```typescript
// 创建 SQLite mock
function createSQLiteMock() {
  const db = new Map<string, any>()
  return {
    query: async (sql: string, params: any[]) => {
      // 模拟查询
      if (sql.includes('SELECT')) {
        return db.get(params[0])
      }
      if (sql.includes('INSERT')) {
        db.set(params[0], params[1])
      }
    },
    exec: async (sql: string) => {
      // 模拟 schema 初始化
    }
  }
}
```

## 调试指南

### 状态不一致问题

当发现内存状态与 SQLite 不一致时：

1. **检查铁律 #4 实现**
   ```typescript
   // 确认 rollback 模式
   async setState(id, newState) {
     try {
       await persister.setState(id, newState)  // ✓ 先持久化
       memory.set(id, newState)                 // ✓ 后内存
     } catch (error) {
       // ✓ 持久化失败时内存不变
       throw error
     }
   }
   ```

2. **检查持久化失败处理**
   - 是否捕获了所有错误类型？
   - 是否正确抛出 `StateError`？
   - 是否有日志记录？

3. **检查事件广播**
   - 事件是否在持久化成功后发出？
   - 事件是否包含完整的 `old_state` 和 `new_state`？

### 事件丢失问题

当发现事件未到达订阅者时：

1. **检查事件总线配置**
   ```typescript
   // 确认所有模块使用相同的 eventBus 实例
   const module1 = new Module1(persister, sharedEventBus) // ✓
   const module2 = new Module2(persister, new EventBus()) // ❌ 禁止
   ```

2. **检查事件类型**
   ```typescript
   // 确认类型桥接正确
   eventBus.emit({
     type: 'group.state_changed',
     // ...
   } as unknown as WorkflowEvent | NodeEvent) // ✓
   ```

3. **检查订阅者注册**
   ```typescript
   // 确认订阅者在事件发出前注册
   eventBus.subscribe('group.state_changed', handler) // 必须先于 emit
   eventBus.emit(...)
   ```

### 死锁问题

当系统挂起或超时，可能原因：

1. **循环依赖**
   - 检查 `ARCHITECTURE.md` §5 依赖关系图
   - 确认没有 A → B → C → A 的循环
   - 使用 `codegraph_codegraph_impact` 工具检测

2. **持久化阻塞**
   - 检查 SQLite 锁
   - 确认事务是否提交
   - 使用 `bun:sqlite` 的 `PRAGMA journal_mode=WAL` 模式

3. **事件风暴**
   - 状态变更触发事件 → 事件处理器修改状态 → 触发更多事件
   - 使用 `max_propagation_depth` 限制递归深度
   - 添加事件去重逻辑

## 性能优化

### SQLite 优化

```typescript
// 使用 WAL 模式（Write-Ahead Logging）
db.exec('PRAGMA journal_mode=WAL')

// 批量操作
db.exec('BEGIN TRANSACTION')
await Promise.all(states.map(s => persister.setState(s.id, s)))
db.exec('COMMIT')

// 索引优化
db.exec('CREATE INDEX idx_workflow_state ON workflows(state)')
```

### 内存优化

```typescript
// 使用 Map 而非 Array（O(1) 查找）
const stateMap = new Map<string, EntityState>()

// 定期清理过期状态
setInterval(() => {
  const now = Date.now()
  for (const [id, state] of stateMap) {
    if (now - state.timestamp > 3600000) { // 1 小时
      stateMap.delete(id)
    }
  }
}, 60000) // 每分钟清理一次
```

### 事件优化

```typescript
// 事件去重
const recentEvents = new Set<string>()
eventBus.subscribe('state_changed', (event) => {
  const key = `${event.entity_id}:${event.new_state}`
  if (recentEvents.has(key)) return
  recentEvents.add(key)
  setTimeout(() => recentEvents.delete(key), 1000) // 1 秒去重窗口
  
  // 处理事件
  handler(event)
})
```

## 代码审查清单

在提交 PR 之前，请确保：

### 架构合规
- [ ] 所有状态变更通过状态机 API（铁律 #1）
- [ ] 终态不可逆（铁律 #2）
- [ ] 所有状态变更发出事件（铁律 #3）
- [ ] 持久化优先于内存更新（铁律 #4）
- [ ] 遵循跨模块设计模式（ARCHITECTURE.md §0）

### 代码质量
- [ ] 无 `any` 类型（使用具体类型或 `unknown`）
- [ ] 无硬编码依赖（使用依赖注入）
- [ ] 无循环依赖（检查 §5 依赖关系图）
- [ ] 错误处理完整（捕获所有可能的错误类型）

### 测试覆盖（最新）

### 当前测试状态（262 pass, 5 skip）

#### state-machine (64 tests)
- StateMachine 核心逻辑
- 状态转移规则验证
- 铁律 #1-#4 合规性验证

#### scheduler (43 tests)
- Scheduler.test.ts: 35 tests（单元测试）
- Scheduler.Integration.test.ts: 8 tests（集成测试）
  - 3 节点串行工作流
  - 3 节点并行工作流
  - 复杂 DAG 工作流（菱形依赖图）
  - Worker 失败场景
  - 事件广播
  - 持久化验证
  - 并发限制
  - 多工作流交叉调度

#### worktree-manager (15 tests)
- Worktree 创建/删除
- 并行 Worktree 管理
- 状态更新和事件广播

#### group-manager (39 tests)
- Group 创建/删除
- 依赖图管理
- 状态更新和事件广播

#### group-manager (4 tests)
- Group 依赖关系验证
- 并行 Group 执行
- 状态转移验证

#### dag-integration (24 tests)
- 串行工作流集成
- 并行工作流集成
- 复杂 DAG 集成
- 多模块协同测试

#### dag-smoke (5 tests)
- 快速烟雾测试
- Mock 环境下的基础功能验证

#### dag-deepseek-e2e (10 tests)
- 真实 deepseek-v4-pro 模型调用
- 真实工作流执行
- 事件广播验证
- 持久化验证

### 测试文件清单

```
packages/opencode/src/dag/
├── state-machine/
│   └── state-machine.test.ts          (64 tests)
├── scheduler/
│   ├── Scheduler.test.ts              (35 tests)
│   └── __tests__/
│       └── Scheduler.Integration.test.ts  (8 tests)
├── worktree-manager/
│   └── __tests__/
│       └── WorktreeManager.test.ts    (15 tests)
├── group-manager/
│   ├── GroupManager.test.ts           (39 tests)
│   └── __tests__/
│       └── GroupManager.test.ts       (4 tests)
├── __tests__/
│   ├── dag-integration.test.ts        (24 tests)
│   ├── dag-smoke.test.ts              (5 tests)
│   └── dag-deepseek-e2e.test.ts       (10 tests)
└── AGENTS.md  (本文档)
```

### DAG 集成测试要求

使用 Mock Worker Executor 模拟真实的任务执行：

```typescript
interface MockWorkerExecutorState {
  executionHistory: Array<{
    workerId: string;
    startTime: number;
    endTime: number;
    status: string;
  }>;
  failureScenarios: Set<string>;
  delayScenarios: Map<string, number>;
}
```

**功能**：
- 支持成功、失败、超时场景
- 追踪执行历史
- 支持依赖关系模拟

### CI 集成配置

GitHub Actions CI 已在 `.github/workflows/test.yml` 中配置：
- DAG smoke 测试（mock 环境）
- DAG 集成测试（真实实现）
- DAG 模块单元测试
- DAG 覆盖率报告生成

**CI 运行命令**：
```bash
# 运行所有 DAG 测试
cd packages/opencode && bun test src/dag

# 运行特定测试套件
bun test src/dag/scheduler/__tests__/Scheduler.Integration.test.ts
bun test src/dag/__tests__/dag-smoke.test.ts
bun test src/dag/__tests__/dag-integration.test.ts
```
- [ ] 所有铁律有对应测试
- [ ] 测试涵盖成功和失败场景
- [ ] 使用 SQLite mock 进行集成测试
- [ ] 测试命名清晰（包含铁律参考）

### 文档化
- [ ] 更新 `ARCHITECTURE.md`（如有模块变更）
- [ ] 添加 JSDoc 注释（公共 API）
- [ ] 更新 README.md（如有用户可见变更）

## 常见问题解答

### Q: 为什么不能使用直接状态赋值？

**A**: 直接状态赋值（`state.status = 'completed'`）无法保证：
- 状态转换合法性（可能违反铁律 #2）
- 事件广播（违反铁律 #3）
- 状态一致性（违反铁律 #4）

必须使用 `setState()` API，它内置了所有铁律的执行逻辑。

### Q: 可以在持久化失败时回滚内存状态吗？

**A**: 不需要手动回滚。使用 rollback 模式（见 §0.3），持久化失败时异常会阻止后续代码执行，内存状态自然保持不变。

```typescript
try {
  await persister.setState(id, newState) // 失败时抛出异常
  memory.set(id, newState)               // 不会执行
} catch (error) {
  // 内存状态保持不变（未执行 memory.set）
  throw error
}
```

### Q: 事件广播可以异步吗？

**A**: 可以，但必须确保：
- 事件在持久化成功后发出
- 事件发出失败不影响主流程
- 使用 `fire-and-forget` 模式（不 await）

```typescript
// 推荐模式
await persister.setState(id, newState)
memory.set(id, newState)
eventBus.emit(event).catch(err => console.error(err)) // 异步不阻塞
```

### Q: 如何处理循环依赖？

**A**: 如果发现循环依赖，立即停止：
1. 检查 `ARCHITECTURE.md` §5 依赖关系图
2. 使用 `codegraph_codegraph_impact` 工具检测
3. 重构代码打破循环（使用接口抽象或依赖注入）
4. 更新架构文档

## 参考资料

- **架构文档**: `packages/opencode/src/dag/ARCHITECTURE.md`
- **用户指南**: `packages/opencode/src/dag/README.md`
- **项目总览**: `docs/dag/OVERVIEW.md`
- **贡献指南**: `CONTRIBUTING.md`
- **项目级开发规范**: `AGENTS.md`（项目根目录）

## 联系与支持

如有问题或需要支持：

1. 查阅现有文档（ARCHITECTURE.md, README.md, OVERVIEW.md）
2. 检查测试用例（`__tests__/` 目录）
3. 联系项目维护者（见 OVERVIEW.md "维护者"章节）

---

*文档版本: 1.0*  
*创建时间: 2026-06-04*  
*最后更新: 2026-06-04*  
*维护者: OpenCode DAG 团队*
