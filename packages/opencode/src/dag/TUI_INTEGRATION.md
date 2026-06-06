# DAG 工作流 × TUI 对接技术方案

> 目标读者：实现 DAG 可视化工作台的开发者。
> 范围：DAG 引擎功能 review + TUI 数据通路 + 新入口页面设计 + 分阶段落地计划。
> 关键结论先行（TL;DR）见 §0。

---

## 0. TL;DR（结论与决策）

1. **DAG 引擎已基本完备**（state-machine / scheduler / group-manager / worktree / session / query 六大模块，396 测试通过），但**缺一条生产数据通路**：`dag_workflow_*` 等 KV 键目前**只在测试里写入**，生产运行时没有任何代码把 DAG 状态推送给 TUI。这是对接的第一阻塞点。
2. **TUI 不是 Go，是 SolidJS + @opentui/solid**（终端 React）。已有插件体系：`route.register` / `slots.register` / `keymap.registerLayer` / `kv` / `state(sync)` / `event` / `client`。已有一个**半成品 `dag-console` 插件**（sidebar + 全屏 route + node-dialog），可直接复用改造。
3. **新入口采用「全屏 plugin route」**（`route.data.type === "plugin"`），不侵入 `Session()` 主组件。TOP BAR + Tab 作为该 route 内部组件实现，避免改动难维护的 session 主视图。
4. **节点地图用字符/盒子渲染**（opentui 是 flexbox 文本模型，无 canvas）。提供两档：`tree`（现成）与 `ascii-dag`（分层列布局）。
5. **「点进任务看内部上下文」直接复用 session 路由的父子会话递归**：DAG 节点通过 `chat_session_id` / 节点绑定的子会话 ID 跳转到 `session` route，子 agent 的递归展示、工具流、对话内容全部白嫖现有实现。
6. **实时性方案推荐 B（SDK + SSE）**：服务端把 DAG `IEventBus` 事件桥接为 server Bus 事件 + 新增只读 HTTP 查询路由，TUI 经 `sync`/`event` 实时刷新。KV 方案（A）仅作 MVP 兜底。

---

## 1. DAG 引擎功能 Review

### 1.1 模块盘点（源码：`src/dag/`）

| 模块 | 职责 | 对 TUI 的价值 |
|------|------|--------------|
| `state-machine` | Workflow/Node/ShadowNode 状态生命周期，四铁律承载层 | 状态枚举与合法转移的唯一真相源 |
| `scheduler` | 节点调度、执行槽位、错误恢复 | 「当前并发数 / queued 节点」数据来源 |
| `group-manager` | Group→SubGroup→Branch 层级 + 依赖图（拓扑+环检测） | 节点地图的**层级/分组**渲染依据 |
| `worktree-manager` | Git worktree 文件隔离 | 节点详情页「隔离环境/冲突」展示 |
| `session` | SQLite 持久化投影（`DAGSessionService` / `WorkflowEngine` / `RequiredNodesMonitor`） | **TUI 读数据的主入口** |
| `persistence` | Drizzle schema（6 表） | 历史 DAG 列表来源（`dag_workflow` 表） |
| `query` | 只读查询 API（`DAGQuery`） | **TUI 仪表盘的现成读模型** |

### 1.2 关键数据模型（`src/dag/session/types.ts`）

- `DAGWorkflowSession`：`id` / `chat_session_id`（**关联 OpenCode 对话会话**）/ `config(DAGConfig)` / `status` / `node_sessions: Record<id, DAGNodeSession>` / `violations` / 时间戳 / `current_node`。
- `DAGNodeSession`：`node_id` / `config(name, dependencies, required, worker_type, worker_config)` / `status` / `output` / `error_info` / `retry_count` / `dependencies` / `required_nodes` / `parent_node` / `logs[]` / `metrics` / 时间戳。
- `calculateWorkflowProgress(session)`：直接产出 required/all_nodes 的 total/completed/failed/skipped/running 与并发数、预计剩余时间 → **进度条与状态汇总直接用它**。
- 状态枚举：Workflow `pending|running|completed|failed|cancelled`；Node `pending|queued|running|completed|failed|skipped`。
- 四铁律（约束 TUI 只读、不可绕过状态机）：状态机不可绕过 / 终态不可逆 / 事件必广播 / 持久化优先。**TUI 永远是只读消费者**，任何「取消工作流」之类写操作必须走服务端 API，不得直接改状态。

### 1.3 现有读 API（`src/dag/query/dag-query.ts`，`DAGQuery`）

已提供（基于 `DAGSessionService`，Effect 包装）：
`listWorkflows()` / `getWorkflow(id)` / `getNodes(workflowId)` / `getNodeStatus(nodeId)` / `getExecutionTimeline(workflowId)` / `listWorkflowsByStatus(status)` / `searchWorkflows(query)` / `getGraphStatistics` / `getNodeDependencies` / `getWorkflowStatistics`。

→ **历史 DAG 列表、当前状态、时间线、依赖图、统计**这些 TUI 需求**读模型已齐全**，无需新写查询逻辑，只差「把它暴露给 TUI 进程」。

### 1.4 当前缺口（必须补齐）

| 缺口 | 现状 | 影响 |
|------|------|------|
| **生产数据桥接** | `dag_workflow_*`/`dag_nodes_*`/`dag_violations_*`/`dag_workflows_<session>` KV 键只在 `*.test.ts` 写入 | TUI 现在永远显示「No workflow data」 |
| **服务端暴露** | `src/server/` 无任何 DAG 路由/事件（grep 0 命中） | TUI 进程拿不到 DAG 数据 |
| **事件桥接** | DAG `IEventBus`（`workflow.*`/`node.*`）未接到 server Bus | 无法实时推送 |
| **节点↔会话绑定** | `DAGNodeSession` 无显式 `chat_session_id` 字段（仅 workflow 有） | 「点进节点看对话」需约定节点子会话 ID 的存放位置（见 §5.4） |

---

## 2. TUI 架构现状（关键事实）

### 2.1 技术栈与入口

- TUI = **SolidJS + @opentui/solid**（`packages/opencode/src/cli/cmd/tui/`），非 Go。
- 根组件 `app.tsx > App()`：`<box column>` → `<Switch>` 按 `route.data.type` 渲染 `<Home/>` / `<Session/>`，**外加 `plugin()`**：当 `route.data.type === "plugin"` 时全屏渲染插件 route。插件 route 覆盖在 Switch 之上。
- 路由模型（`context/route.tsx`）：`home | session(sessionID) | plugin(id, data)`。导航 `route.navigate(...)`；插件侧 `api.route.navigate(name, params)` → 非 home/session 即落到 `{type:"plugin", id:name, data:params}`。

### 2.2 插件 API（`plugin/api.tsx`，`TuiPluginApi`）

可用能力：
- `route.register([{name, render}])` / `route.navigate` / `route.current`
- `slots.register({order, slots})`（仅插件上下文）；宿主 `<TuiPluginRuntime.Slot name=...>`
- `keymap.registerLayer({commands})` — 注册命令面板项 + 快捷键
- `kv.get/set`（**文件级**，见 §3.1）
- `state`（= `sync` 投影）：session/message/part/todo/permission/question/status/lsp/mcp 的**实时**只读视图
- `event`（订阅 server Bus 事件，如 `message.part.updated` / `session.status`）
- `client`（SDK HTTP 客户端）/ `ui.dialog` / `ui.toast` / `theme` / `renderer`

### 2.3 现有 slot 插入点（无 top-bar slot）

`home_logo/home_prompt/home_bottom/home_footer` · `session_prompt/session_prompt_right` · `sidebar_title/sidebar_content/sidebar_footer` · `app_bottom/app`。

→ **没有 session 顶栏 slot**。要在对话区最上方加 TOP BAR，有两条路（§4.1 决策）。

### 2.4 子 agent 递归展示（可复用的金矿）

- 会话父子关系：`session.parentID`；`Session()` 用 `children()` 聚合同父会话。
- `task` 工具 spawn 子 agent = 创建 child session；`SubagentFooter` + 命令 `session.child.first/next/previous` / `session.parent` 在子会话间穿梭。
- 进入子 agent 上下文 = `route.navigate({type:"session", sessionID: childID})`，**整套消息/工具/思考/递归渲染全部现成**。
- → DAG「点节点进上下文，可继续往内递推」**直接映射到这套机制**，无需重写。

### 2.5 现有 `dag-console` 插件（半成品，复用基座）

`src/cli/cmd/tui/feature-plugins/dag-console/`：
- `index.tsx`：注册 `sidebar_content` slot + `dag-console` route + 命令 `dag.console.open`。
- `console-route.tsx`：全屏视图，从 `api.kv` 读 `dag_workflow_<id>`/`dag_nodes_<id>`/`dag_violations_<id>`，进度条 + 树形渲染 + 节点详情弹窗。
- `renderer.tsx`：`DAGRenderer`（树形节点 + 依赖展开）+ `DAGProgressBar`。
- `sidebar.tsx`：会话侧栏列出本会话的 workflow（读 `dag_workflows_<session>`）。
- `node-dialog.tsx`：节点详情大弹窗（状态/依赖/错误/日志/指标）。

→ **保留并改造**：把数据源从 KV 换成实时读模型（§3），把单一 console route 扩成「带 TOP BAR + Tab 的工作台」（§4）。

---

## 3. 数据通路方案（核心决策）

### 3.1 三个可用传输机制对比

| 机制 | 实时性 | 跨进程 | 适合 | 局限 |
|------|--------|--------|------|------|
| **A. KV**（`context/kv.tsx`） | ❌ 无推送（文件 `kv.json` + flock） | ✅ | MVP 快照、配置 | 非实时；需 server 进程写文件，hacky |
| **B. SDK + SSE**（`client` + `event`/`sync`） | ✅ 服务端事件流 | ✅ | **生产实时** | 需新增 server 路由 + 事件桥接 |
| **C. 混合** | ✅ | ✅ | 落地路径 | — |

### 3.2 推荐：方案 C（先 A 验证 UI，后 B 上实时）

**Phase 1（MVP，纯前端可验证）**：服务端在 DAG 状态变更后，把 `DAGQuery` 快照 `kv.set` 到约定键。TUI 复用现有 `dag-console` 读 KV。**零 server 路由改动**即可点亮整页 UI。
缺点：刷新靠轮询/KV 文件 mtime，不够「高级」。

**Phase 2（实时）**：
1. **服务端读路由**（`src/server/`，挂到现有 Hono app）：
   - `GET /dag/workflow` → `DAGQuery.listWorkflows()`
   - `GET /dag/workflow/:id` → `getWorkflow` + `getNodes` + `violations`
   - `GET /dag/workflow/:id/timeline` → `getExecutionTimeline`
2. **事件桥接**：在 DAG 共享 `IEventBus` 上挂 listener，把 `workflow.*` / `node.*` 透传为 server Bus 事件（如 `dag.workflow.updated` / `dag.node.updated`，payload 带 `workflow_id`）。
3. **TUI 侧**：`api.event.on("dag.node.updated", …)` 触发对应 workflow 的 `createResource` refetch（或维护本地 store 增量合并）。`sync` 已有的 SSE 通道直接复用，无需新连接。

> 决策理由：读模型（`DAGQuery`）已完备，B 的成本集中在「暴露」而非「实现」；A 能让 UI 与数据解耦并行开发。二者数据形状一致（都是 `DAGWorkflowSession`/`DAGNodeSession`），切换传输不改渲染层。

### 3.3 统一数据访问层（隔离传输细节）

新增 `dag-console/data.ts`，导出 hook `useDagData()`，内部封装「KV 或 SDK」二选一（按 `api.state.config` 或 flag 切换），对外只暴露：

```ts
useWorkflowList(sessionId?): () => DAGWorkflowSession[]      // 历史 + 当前
useWorkflow(workflowId): () => DAGWorkflowSession | null
useNodes(workflowId): () => DAGNodeSession[]
useViolations(workflowId): () => DAGViolation[]
useTimeline(workflowId): () => ExecutionTimeline | null
```

→ 渲染层只依赖该 hook；Phase1→Phase2 只换 `data.ts` 实现。

---

## 4. 新入口与页面设计

### 4.1 决策：TOP BAR 放哪？

**采用「全屏 plugin route + route 内自带 TOP BAR」**，理由：
- 不改 `Session()`（1186 行，难维护，用户明确「TUI 太难改」）。
- plugin route 已是全屏覆盖层（`app.tsx` 的 `plugin()`），天然适合「新页面」。

**入口触发**（两个，互补）：
1. 命令面板/快捷键：扩展现有 `dag.console.open`（已在 `index.tsx`），改名 `dag.workflow.open`，绑定一个顺手键（如 `<leader>d`）。
2. **对话区顶栏 Tab**：新增**一个 host slot** `session_topbar`（唯一需要动 session 主视图的改动，仅 1 行：在 `routes/session/index.tsx` 滚动区上方插 `<TuiPluginRuntime.Slot name="session_topbar" session_id=.../>`）。由 dag 插件注册该 slot，渲染 `[ 对话 | DAG Workflow ]` 切换条；点 DAG 即 `route.navigate("dag-workflow", {sessionID})`。
   - 若想**零侵入** session 主视图：退而用 `app_bottom`/命令入口，TOP BAR 只在 DAG route 内显示（牺牲「对话页顶部就有 Tab」体验）。**推荐接受 1 行改动换体验**。

### 4.2 DAG 工作台布局（`dag-workflow` route）

```
┌─ TOP BAR ───────────────────────────────────────────────────────────┐
│  [对话]  [▣ DAG Workflow]        workflow: 重构鉴权 · running 3/8     │  ← Tab + 全局状态
├─ 左：历史/列表栏 ──┬─ 中：节点地图（主区）──────────┬─ 右：详情/检查器 ─┤
│ ▸ wf-2026… ✓      │   ASCII-DAG / Tree 双视图        │ 选中节点：       │
│ ▸ wf-2026… ● run  │   ● plan ──┬─ ✓ impl-a          │  name/status     │
│ ▸ wf-2026… ✗ fail │            └─ ● impl-b (2 tools) │  tools: 5        │
│ [搜索/过滤]        │   ◌ review (queued)             │  最近: “调用 edit”│
│                    │                                 │  [Enter 进入会话] │
├────────────────────┴─────────────────────────────────┴──────────────┤
│ 实时活动行：node impl-b · 正在 “编辑 auth.ts” · tools=2 · 12.3s       │  ← live ticker
├──────────────────────────────────────────────────────────────────────┤
│ [Tab]切换面板 [↑↓]选节点 [Enter]进会话 [v]视图切换 [h]历史 [Esc]返回   │
└──────────────────────────────────────────────────────────────────────┘
```

窄屏（`dimensions().width <= 120`）：右侧详情改为弹窗（复用 `node-dialog.tsx`），左侧历史栏可折叠（复用 sidebar 折叠逻辑）。

### 4.3 四大功能区 ↔ 需求映射

| 用户需求 | 实现 | 复用 |
|----------|------|------|
| 历史记录 DAG 切换 | 左栏 `useWorkflowList()`，点选 `setActiveWorkflow(id)` | `sidebar.tsx` 列表样式 |
| 总任务状态 + 子任务状态 + 每子任务工具数 | `calculateWorkflowProgress` + 每节点统计；工具数见 §5.3 | `DAGProgressBar` / `renderer.tsx` |
| 「一行文字实时展示当前在说什么/召唤什么工具」 | 底部 **live ticker**（§5.3） | `state.part()` / `event` |
| 节点地图（node 图） | `ascii-dag` 分层视图（§5.1） | 新增；`tree` 复用 `DAGRenderer` |
| 点节点进上下文，可继续递推（同 subagent） | 节点→子会话→`session` route（§5.4） | **整套 session 递归** |

---

## 5. 关键实现细节

### 5.1 节点地图渲染（opentui 无 canvas → 字符地图）

opentui 是 flexbox + 文本盒子模型，**没有自由画布**。两档实现：

- **`tree` 视图（已有）**：`DAGRenderer` 按 `dependencies` 递归缩进，连接符 `├─ │`。直接复用，作默认。
- **`ascii-dag` 视图（新增）**：按拓扑层级（用 `group-manager` 的 `DependencyGraph` 拓扑序或对 `dependencies` 做 Kahn 分层）把节点排成「列 = 层级」，行内用 `flexDirection="row"` 排同层节点，节点间画 `──▶` 依赖箭头。每个节点是一个带 `border` 的小盒：
  ```
  ┌─●plan─┐     ┌─✓impl-a─┐
  │ 5 tools│──▶ │ 8 tools │──▶ ┌◌review┐
  └────────┘     └─────────┘     └───────┘
  ```
  - 状态色：复用 `renderer.tsx` 的 `statusIcon`/`workflowStatusColor`。
  - 选中：键盘 `↑↓←→` 在节点网格间移动 `selectedNodeId`，选中盒 `backgroundColor=theme.backgroundElement`。
  - 复杂图（节点≤20 是铁律上限）下，超宽时套 `scrollbox` 横向滚动。
- 视图切换键 `v` 在 `tree`/`ascii-dag` 间切，存 `kv.signal("dag_view_mode")`。

### 5.2 实时状态刷新

- Phase2：`event.on("dag.node.updated", e => { if (e.workflow_id===active) refetch() })`。
- 节点级局部更新优于整图重渲：用 SolidJS `createStore` 按 `node_id` 增量 `setNodes(id, reconcile(next))`，避免闪烁。
- 「看起来高级」的动效：running 节点图标用 `Spinner`（已有 `component/spinner`）或 `●` 呼吸（`app.toggle.animations` 已有开关，尊重它）。

### 5.3 子任务工具数 + Live Ticker（"在说什么/召唤什么工具"）

两类数据来源，取决于节点是否绑定了子会话：
- **绑定子会话**（推荐，见 §5.4）：节点工具数 = `state.session.messages(nodeSessionId)` 里 assistant 消息的 `part.type==="tool"` 计数；live ticker = 该会话最后一条 `message.part.updated` 的工具名/文本片段。直接复用 `sync` 实时流。
- **未绑定（纯 worker）**：退化用 `DAGNodeSession.logs[]` 末行 + `metrics`。工具数无法精确，显示 `logs.length` 或省略。

Live ticker 组件订阅 `event.on("message.part.updated")`，过滤 `part.sessionID ∈ 当前 workflow 的节点会话集合`，渲染「`<节点名> · <动作摘要> · tools=<n> · <运行时长>`」单行，节流 ~200ms。

### 5.4 点节点 → 递归上下文（复用 subagent 机制）

**前提改动**：DAG 节点执行 agent 时，把其 OpenCode 子会话 ID 落到 `DAGNodeSession.metadata.chat_session_id`（或新增显式字段）。`WorkflowEngine`/worker 在 spawn agent 时写入。

交互：
- 节点详情区 `[Enter 进入会话]` → `route.navigate({type:"session", sessionID: node.metadata.chat_session_id})`。
- 进入后**完全是普通 session 页**：子 agent 的工具流、思考、再下一层 `task` 子会话递归、`SubagentFooter`、`session.child.*` 全部现成可用。
- 返回：session 页 `Esc`/命令回到 DAG route（用 `params.returnRoute`，`console-route.tsx` 已有 `goBack()` 模式）。
- 若节点未绑定会话：`[Enter]` 退化为打开 `node-dialog`（日志/错误/指标）。

> 这一条是用户「该逻辑应当与 session 打开子 agent 展示内容一个样子」的精确落点：**不复制 UI，直接路由进 session route**。

### 5.5 历史 DAG 切换

- 左栏数据：`useWorkflowList()` → Phase1 读 `dag_workflows_<session>` KV；Phase2 读 `GET /dag/workflow`（可带 `chat_session_id` 过滤 + 全局历史两个 tab）。
- 选中写 `kv.signal("dag_active_workflow", id)`，中/右区响应。
- 支持搜索（`searchWorkflows`）与状态过滤（`listWorkflowsByStatus`），均已有 API。

---

## 6. 复用映射表（最大化复用）

| 新功能 | 复用现有 | 改动量 |
|--------|----------|--------|
| 全屏入口 | `dag-console/index.tsx` route 注册 + 命令 | 改名/扩展 |
| 进度条 | `DAGProgressBar` | 0 |
| 树视图 | `DAGRenderer` | 0（作为 `tree` 模式） |
| 节点详情弹窗 | `node-dialog.tsx` | 小改（加「进入会话」按钮） |
| 历史/列表栏 | `sidebar.tsx` 列表样式 | 中改（多 workflow + 搜索） |
| 进入节点上下文 | `routes/session/*` 全套 | 0（仅 navigate） |
| 实时流 | `context/sync*` + `event` | 0（订阅） |
| 主题/对话框/toast | `api.theme/ui` | 0 |
| **新增** | `ascii-dag` 视图、`data.ts` 抽象层、live ticker、TOP BAR/Tab | 主要工作量 |

---

## 7. 服务端改动清单（Phase 2）

1. `src/server/` 新增 DAG 只读路由（挂现有 app；鉴权沿用现有中间件）：
   - `GET /dag/workflow`（可选 `?chatSessionId=`）
   - `GET /dag/workflow/:id`
   - `GET /dag/workflow/:id/timeline`
   - 实现直接 `new DAGQuery(sessionService)` 调用，**无新业务逻辑**。
2. 事件桥接：在 DAG 共享 `IEventBus` 注册 listener → 转 server Bus（`dag.workflow.updated` / `dag.node.updated`，payload 含 `workflow_id`/`node_id`）。注意四铁律：**只读转发，不回写状态**。
3. （可选 Phase1 兜底）在 `WorkflowEngine` 状态变更后 `kv.set` 快照——但 server 进程写 `kv.json` 属临时手段，Phase2 上线后移除。

> 不得让 TUI 直接连 DAG 的 SQLite（跨进程、违反 server 边界）。一律经 server。

---

## 8. 分阶段落地计划

| 阶段 | 内容 | 验收 |
|------|------|------|
| **P0 数据抽象** | `dag-console/data.ts` + `useDagData()`；Mock 数据驱动 UI | 用假数据点亮整页 |
| **P1 工作台骨架** | `dag-workflow` route（TOP BAR + 三区布局），复用进度条/树视图/详情弹窗；历史栏 | KV/Mock 下完整可交互 |
| **P2 节点地图** | `ascii-dag` 视图 + 键盘导航 + 视图切换 | 节点网格渲染 + 选中 |
| **P3 进入上下文** | 节点→`metadata.chat_session_id`→session route 往返 | 点节点进子 agent 会话并能递归 |
| **P4 服务端暴露** | DAG 读路由 + 事件桥接；`data.ts` 切 SDK | 真实 workflow 实时刷新 |
| **P5 Live Ticker + 打磨** | 实时活动行、动效、窄屏适配、空态 | 「实时高级感」达成 |
| **P6 TOP BAR Tab** | 新增 `session_topbar` slot（session 主视图 1 行） | 对话页顶部可切到 DAG |

每阶段保持 TUI 可运行；P0–P3 不依赖服务端，可与 P4 并行。

---

## 9. 风险与取舍

- **节点↔会话绑定字段缺失**：P3 阻塞点。需 `WorkflowEngine`/worker 写 `metadata.chat_session_id`。未绑定节点降级为「只看日志」。
- **opentui 无图形**：节点地图只能字符化；节点数铁律 ≤20，ascii-dag 可控；超宽用横向 scrollbox。
- **实时性能**：`message.part.updated` 高频 → live ticker 必须节流 + 只订阅当前 workflow 节点会话集合。
- **KV 作为生产通路是反模式**：仅 P1 兜底，P4 必须切 SDK；避免 server 写 `kv.json` 长期存在。
- **TOP BAR slot 改动**：唯一侵入 session 主视图处，控制在 1 行 slot 插入，风险低；若评审不接受，退回命令入口。
- **只读纪律**：TUI 任何「取消/重试 workflow」必须经 server API + 状态机，禁止前端改状态（四铁律 #1/#2）。

---

## 10. 决策（2026-06-06 拍板）

| # | 问题 | 决策 | 影响 |
|---|------|------|------|
| 1 | 实时路径 | **一步到位上 SSE/SDK**，跳过 KV 兜底 | P0 直接建 sdk+event+路由三件套，无 Phase1 mock 阶段 |
| 2 | TOP BAR 入口 | **接受 `routes/session/index.tsx` 加 1 行 `session_topbar` slot** | P6 可落地 Tab 切换，体验最优 |
| 3 | 节点↔会话绑定 | **每个节点为其 agent 创建 OpenCode 子会话**，`metadata.chat_session_id` 由 worker 在 spawn 时写入 | "点节点进上下文并递归下钻" 复用整套 session 机制 |
| 4 | 历史 DAG 范围 | **默认当前 chat_session_id，可检索全局历史** | list API 需支持 `?chatSessionId=` + 全局模式 + 搜索 |

> 基线约束已同步到 `ARCHITECTURE.md` §9/§10（bridge 模块 + 节点子会话绑定字段），是后续 WP 的 archgate 输入。

## 11. WP 切分（待启动）

| WP | 名称 | 验收 | 前置 |
|----|------|------|------|
| WP1 | 桥接层骨架 + TDD | `src/dag/bridge/` 存在、单测 100% 绿 | archgate PASS on §9 |
| WP2 | Server 读路由 + 事件桥接挂载 | SDK 能拿到 workflow/nodes/timeline，`dag.node.updated` 事件能流到 SSE | WP1 verify PASS |
| WP3 | 工作台骨架 + 数据抽象 | dag-workflow route 可打开、三区布局可渲染 mock 数据 | WP2 verify PASS（依赖 SDK/event） |
| WP4 | 节点地图 + 下钻 + 历史 | ascii-dag 可选、点节点进 session 递归、左右栏功能完整 | WP3 verify PASS |

每 WP 完成后按 `doc-lifecycle` 退化对应条款至稳态简述。

---

*版本：v0.2（决策落地）*
