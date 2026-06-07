# TUI 与 DAG Worker 系统集成设计报告

> **文档状态**: 草稿（待讨论）  
> **创建时间**: 2026-01-XX  
> **作者**: Main Agent  
> **依赖**: 007-dag-session-integration.md

## 1. 用户需求梳理

### 1.1 核心功能

#### 功能 1: SlashCommand 触发
- **入口**: 用户在 Chat Session 中输入 `/dag-worker` 命令
- **执行**: 异步执行，不阻塞原始对话
- **反馈**: Hooks 写入 synthetic message（巨型工具调用）到 Chat Session
- **目的**: 让 Chat Session 的 LLM 可以"感知" DAG 执行过程

#### 功能 2: DAG 总控台
- **位置**: TUI 上的独立界面（或 Sidebar 插件）
- **路线图展示**:
  - AI 生成结构化路线图语言
  - TUI 层渲染为可视化结构
  - 必须通过"语法审批单元"验证才可放行
- **交互**:
  - 如果路线图无法配置按钮 → 提供层级列表
  - 点击列表项 → 弹窗查看内部 Session 详情
  - 弹窗可以点 X 关闭

### 1.2 渲染方案优先级
1. **优先**: DAG 可视化方案（如果有 TUI 库支持）
2. **备选 1**: Unicode Box Drawing（`┌─┐│└┘`）
3. **备选 2**: Braille 字符（`⠁⠉⠋⠛` 等盲文点阵）
4. **Fallback**: 分层文本列表

---

## 2. 现有 TUI 技术栈分析

基于调研 `packages/opencode/src/cli/cmd/tui/` 目录：

### 2.1 核心渲染库
- **@opentui/solid**: 终端渲染引擎，基于 SolidJS
- **SolidJS**: 响应式 UI 框架
- **JSX**: 声明式布局语法

### 2.2 已验证的组件模式

#### Dialog 弹窗系统
- 文件: `ui/dialog.tsx`
- 支持:
  - 栈管理（多层弹窗）
  - 三种尺寸: `medium`（60 宽）/ `large`（88 宽）/ `xlarge`（116 宽）
  - Escape / Ctrl+C 关闭
  - 背景遮罩（半透明黑色）
  - 自动焦点管理

**示例用法**（来自 `dialog-subagent.tsx`）:
```tsx
<DialogSelect
  title="Subagent Actions"
  options={[
    { title: "Open", value: "view", onSelect: (dialog) => {...} }
  ]}
/>
```

#### Sidebar 插槽系统
- 文件: `feature-plugins/sidebar/*.tsx`
- 已有插件:
  - `todo.tsx`: 任务列表
  - `mcp.tsx`: MCP 服务状态
  - `lsp.tsx`: LSP 状态
  - `files.tsx`: 文件树
  - `context.tsx`: 上下文信息

**注册模式**:
```tsx
api.slots.register({
  order: 400,
  slots: {
    sidebar_content(ctx, props) {
      return <View api={api} session_id={props.session_id} />
    }
  }
})
```

#### Footer 组件
- 文件: `routes/session/footer.tsx`
- 示例: `subagent-footer.tsx`（SubagentFooter）
- 支持:
  - 点击弹出 Dialog
  - 显示状态信息
  - 主题适配

#### Diff Viewer（复杂渲染示例）
- 文件: `feature-plugins/system/diff-viewer-ui.tsx`
- 证明:
  - Box Drawing 边框（`border="left"` / `border="top"`）
  - 自定义颜色（`fg`, `backgroundColor`）
  - 嵌套布局（box 嵌套实现树状结构）
  - flexShrink 控制布局

---

## 3. TUI 集成方案设计

### 3.1 方案 A: Sidebar 插件（推荐）

**理由**:
- 复用现有插槽机制
- 不侵入主界面
- 与 Todo/MCP/LSP 等插件平级

**结构**:
```
src/cli/cmd/tui/feature-plugins/sidebar/
├── dag-console.tsx          # DAG 总控台主组件
├── dag-dialog.tsx           # 弹窗查看 Session 详情
├── dag-renderer.ts          # DAG 渲染器（纯逻辑）
└── dag-theme.ts             # DAG 专属主题色
```

**界面布局**:
```
┌─────────────────────────────────────────────┐
│  Chat Session                               │
│  ├─ Messages...                             │
│  ├─ Synthetic: DAG Started (tool_call)      │
│  └─ Synthetic: Node Completed (tool_call)   │
└─────────────────────────────────────────────┘
         ↓ SlashCommand 触发

┌─────────────────────────────────────────────┐
│  Sidebar (右侧)                             │
│                                             │
│  [Todo]                                     │
│  ├─ 分析需求                                │
│  └─ 设计方案                                │
│                                             │
│  ▼ DAG Workflow                    [展开]   │
│  ├─ ┌─ analyze     ✓ completed    12.5s   │
│  │  └─ (click to view details)            │
│  ├─ ┌─ design      ● running      8.2s    │
│  │  └─ (click to view details)            │
│  ├─ ├─ implement   ○ pending              │
│  │  └─ depends on: design                 │
│  └─ └─ test        ○ pending              │
│     └─ depends on: implement              │
│                                             │
│  Progress: 2/10 nodes completed            │
│  Violations: 0                             │
└─────────────────────────────────────────────┘
```

### 3.2 方案 B: 独立路由页面

**理由**:
- 提供全屏视图
- 可以展示更复杂的 DAG 图

**结构**:
```
src/cli/cmd/tui/routes/
├── dag-console.tsx          # DAG 总控台页面
├── dag-detail.tsx           # Session 详情页
└── dag-visualizer.tsx       # DAG 可视化组件
```

**界面布局**:
```
┌─────────────────────────────────────────────┐
│  DAG Console                          [Esc] │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─ analyze ──────┐  ┌─ design ──────┐    │
│  │ ✓ completed    │──│ ● running     │    │
│  │ 12.5s          │  │ 8.2s          │    │
│  └────────────────┘  └───────┬───────┘    │
│                              │             │
│                              ↓             │
│                    ┌─ implement ─────┐    │
│                    │ ○ pending       │    │
│                    └───────┬─────────┘    │
│                            │               │
│                            ↓               │
│                    ┌─ test ──────────┐    │
│                    │ ○ pending       │    │
│                    └─────────────────┘    │
│                                             │
│  Progress: 2/10 | Violations: 0 | ETA: 3m │
├─────────────────────────────────────────────┤
│  [Tab] Session List  |  [Enter] View Node  │
└─────────────────────────────────────────────┘
```

### 3.3 方案 C: 混合模式（最灵活）

**结构**:
- **Sidebar**: 简要进度 + 折叠详情
- **Dialog**: 点击展开完整 DAG 可视化 + 节点列表
- **路由切换**: `Ctrl+G` 切换到 DAG 总控台

**界面布局**:

**Sidebar（简略）**:
```
▼ DAG Workflow
● running (2/10 nodes, 3 violations)
  [View Details →]
```

**Dialog（详细）**:
```
┌─────────────────────────────────────────┐
│  DAG: refactor-module                   │
├─────────────────────────────────────────┤
│                                         │
│  Status: running  Started: 2 min ago   │
│                                         │
│  ┌─ Nodes ──────────────────────────┐  │
│  │ ✓ analyze        12.5s  [View]  │  │
│  │ ● design         8.2s   [View]  │  │
│  │ ○ implement      pending [View] │  │
│  │ ○ test           pending [View] │  │
│  └──────────────────────────────────┘  │
│                                         │
│  ┌─ Violations ─────────────────────┐  │
│  │ ⚠ required_node_skipped:        │  │
│  │   'design' skipped at 2026-01-XX│  │
│  │ [Dismiss]                        │  │
│  └──────────────────────────────────┘  │
│                                         │
│           [Close - Esc]                 │
└─────────────────────────────────────────┘
```

---

## 4. 关键技术实现

### 4.1 DAG 渲染器实现

#### 语言设计（AI 生成的结构化格式）

```markdown
# DAG Route Map

## Nodes
- name: analyze
  status: completed
  duration: 12.5s
  dependencies: []
  
- name: design
  status: running
  duration: 8.2s
  dependencies: [analyze]

## Edges
- from: analyze
  to: design
  label: "completed → running"

## Violations
- type: required_node_skipped
  node: design
  reason: "User forced skip"
```

#### 语法审批单元（Parser + Validator）

```typescript
// src/dag/tui/dag-language-parser.ts

interface DAGNode {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  duration?: number; // 秒
  dependencies: string[];
}

interface DAGEdge {
  from: string;
  to: string;
  label?: string;
}

interface DAViolation {
  type: string;
  node: string;
  reason: string;
  timestamp: number;
}

interface DAGRouteMap {
  nodes: DAGNode[];
  edges: DAGEdge[];
  violations: DAViolation[];
}

class DAGLanguageParser {
  parse(input: string): DAGRouteMap | { error: string } {
    const ast = this.tokenize(input);
    const validated = this.validate(ast);
    if (validated.error) return validated;
    return this.transform(ast);
  }

  private tokenize(input: string): unknown {
    // Markdown-like tokenization
    // 支持 ## Nodes, ## Edges, ## Violations 段落
    // 支持 - name: xxx 列表项
    // 支持嵌套属性
  }

  private validate(ast: unknown): { error?: string } {
    // 验证:
    // 1. 节点名唯一
    // 2. dependencies 引用的节点存在
    // 3. 状态合法
    // 4. 无循环依赖
  }

  private transform(ast: unknown): DAGRouteMap {
    // 转换 AST 为最终数据结构
  }
}
```

#### TUI 渲染器

```typescript
// src/dag/tui/dag-renderer.ts

import { Box, Text } from "@opentui/solid";

class DAGRenderer {
  render(routeMap: DAGRouteMap, options: RenderOptions) {
    if (options.style === 'box-drawing') {
      return this.renderBoxDrawing(routeMap);
    } else if (options.style === 'list') {
      return this.renderList(routeMap);
    } else if (options.style === 'braille') {
      return this.renderBrailleGrid(routeMap);
    }
  }

  private renderBoxDrawing(routeMap: DAGRouteMap) {
    // 使用 Unicode Box Drawing 字符
    // ┌─┐│└┘├┤┬┴┼
    // 示例:
    // ┌─ analyze ─┐  ┌─ design ─┐
    // │ ✓ done    │──│ ● run    │
    // └───────────┘  └────┬─────┘
    //                      │
    //                      ↓
    //              ┌─ implement ─┐
    //              │ ○ pending   │
    //              └─────────────┘
  }

  private renderList(routeMap: DAGRouteMap) {
    // 分层列表（最稳妥）
    // ├─ ✓ analyze (12.5s)
    // ├─ ● design (8.2s)
    // │  └─ depends on: analyze
    // ├─ ○ implement (pending)
    // │  └─ depends on: design
    // └─ ○ test (pending)
    //    └─ depends on: implement
  }

  private renderBrailleGrid(routeMap: DAGRouteMap) {
    // 使用 Braille 字符点阵（复杂但最灵活）
    // ⠁⠉⠋⠛⠟⠿⡿⣿ 等盲文字符
    // 可以渲染任意形状的曲线连接
    // 但需要精确计算每个字符的像素
  }
}
```

### 4.2 Sidebar 插件实现

```typescript
// src/cli/cmd/tui/feature-plugins/sidebar/dag-console.tsx

const id = "internal:sidebar-dag";

interface DAGSummary {
  workflow_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: { completed: number; total: number };
  violations: number;
  nodes: DAGNode[];
}

function DAGSidebarView(props: { api: TuiPluginApi; session_id: string }) {
  const [expanded, setExpanded] = createSignal(false);
  const theme = () => props.api.theme.current;

  // 监听 DAG 状态变更
  const summary = createMemo(() => {
    return props.api.state.session.dag(props.session_id);
  });

  if (!summary()) return null;

  return (
    <box padding={1} border="rounded" borderColor={theme()..primary}>
      <box flexDirection="row" justifyContent="space-between">
        <text bold>▼ DAG Workflow</text>
        <text>{summary().status}</text>
      </box>

      <box flexDirection="row" gap={2}>
        <text color={theme().success}>
          ✓ {summary().progress.completed}
        </text>
        <text color={theme().warning}>
          ● {summary().progress.total - summary().progress.completed}
        </text>
        {summary().violations > 0 && (
          <text color={theme().danger}>
            ⚠ {summary().violations} violations
          </text>
        )}
      </box>

      <Show when={expanded()}>
        <box marginTop={1}>
          <For each={summary().nodes}>
            {(node) => (
              <NodeRow
                node={node}
                theme={theme()}
                onClick={() => props.api.dialog.open(DAGNodeDetail(node))}
              />
            )}
          </For>
        </box>
      </Show>

      <box flexDirection="row" marginTop={1}>
        <text
          color={theme().muted}
          onClick={() => setExpanded(!expanded())}
        >
          [{expanded() ? 'Collapse' : 'Expand'}]
        </text>
      </box>
    </box>
  );
}

function NodeRow(props: {
  node: DAGNode;
  theme: any;
  onClick: () => void;
}) {
  const statusIcon = {
    'completed': '✓',
    'running': '●',
    'pending': '○',
    'failed': '✗',
  }[props.node.status];

  const statusColor = {
    'completed': props.theme.success,
    'running': props.theme.warning,
    'pending': props.theme.muted,
    'failed': props.theme.danger,
  }[props.node.status];

  return (
    <box
      flexDirection="row"
      gap={1}
      onClick={props.onClick}
      hoverable
    >
      <text color={statusColor}>{statusIcon}</text>
      <text>{props.node.name}</text>
      {props.node.duration && (
        <text color={props.theme.muted}>
          ({props.node.duration.toFixed(1)}s)
        </text>
      )}
    </box>
  );
}

const plugin: InternalTuiPlugin = {
  id,
  tui: async (api) => {
    api.slots.register({
      order: 500,
      slots: {
        sidebar_content(ctx, props) {
          return <DAGSidebarView api={api} session_id={props.session_id} />;
        }
      }
    });

    // 注册全局快捷键
    api.keybindings.register({
      key: "ctrl+g",
      desc: "Open DAG Console",
      command: () => {
        api.route.navigate({ type: 'dag-console' });
      }
    });
  }
};

export default plugin;
```

### 4.3 Dialog 弹窗实现

```typescript
// src/cli/cmd/tui/feature-plugins/sidebar/dag-dialog.tsx

import { Dialog } from "@tui/ui/dialog";

function DAGNodeDetail(props: { node: DAGNode }) {
  const close = useDialog().clear;

  return (
    <box padding={2}>
      <text bold size="large">Node: {props.node.name}</text>

      <box marginTop={1}>
        <text>Status: <text color={theme.success}>{props.node.status}</text></text>
        <text>Duration: {props.node.duration?.toFixed(2)}s</text>
        <text>Depends on: {props.node.dependencies.join(', ')}</text>
      </box>

      <box marginTop={2}>
        <text bold>Execution Log:</text>
        <box maxHeight={10} overflow="scroll">
          <text>{props.node.output}</text>
        </box>
      </box>

      {props.node.error_info && (
        <box marginTop={2} backgroundColor={theme.error_background}>
          <text color={theme.error}>Error:</text>
          <text>{props.node.error_info.message}</text>
          <text>{props.node.error_info.stack}</text>
        </box>
      )}

      <box flexDirection="row" marginTop={2} justifyContent="space-between">
        <text
          color={theme.muted}
          onClick={() => {
            navigator.clipboard(props.node.output);
            alert('Output copied!');
          }}
        >
          [Copy Output]
        </text>
        <text color={theme.primary} onClick={close}>
          [Close - Esc]
        </text>
      </box>
    </box>
  );
}
```

### 4.4 实时状态更新（SyncEvent 桥接）

```typescript
// src/cli/cmd/tui/feature-plugins/sidebar/dag-sync.ts

export function setupDAGSync(api: TuiPluginAPI, session_id: string) {
  // 监听 DAG 状态变更事件
  api.sync.on('dag.node.state_changed', (event) => {
    if (event.session_id !== session_id) return;

    // 更新本地状态
    const current = api.state.session.dag(session_id);
    const nodeIndex = current.nodes.findIndex(n => n.name === event.node_name);
    current.nodes[nodeIndex].status = event.new_state;

    api.state.set(session_id, 'dag', current);
  });

  // 监听违规事件
  api.sync.on('dag.violation_recorded', (event) => {
    if (event.session_id !== session_id) return;

    const current = api.state.session.dag(session_id);
    current.violations.push(event.violation);

    api.state.set(session_id, 'dag', current);
  });
}
```

---

## 5. 与 Phase 8 的集成点

### 5.1 数据流图

```
用户输入 /dag-worker
    ↓
SlashCommmand 解析
    ↓
DAG Session 创建（SessionService）
    ↓
DAG ExecutionContext 生成（ContextExtractor）
    ↓
DAGScheduler 启动（Scheduler + StateMachine）
    ↓
每个 Node 执行
    ├─→ 更新 DAG Session（NodeSession 状态）
    ├─→ 发布 SyncEvent (dag.node.state_changed)
    ├─→ TUI Sidebar 实时更新（SolidJS reactive）
    └─→ Hooks 写入 synthetic message（Chat Session）
        ↓
    Chat LLM 感知 DAG 执行过程
```

### 5.2 Phase 8 子阶段调整

| 子阶段 | 调整内容 |
|--------|----------|
| **Phase 8.1** | 增加 `dag-console.tsx` 组件 |
| **Phase 8.2** | 增加 Sidebar 插件注册 |
| **Phase 8.3** | 增加 Dialog 弹窗组件 |
| **Phase 8.4** | 增加 DAG 渲染器（Box Drawing + List） |
| **Phase 8.5** | 增加 SyncEvent TUI 桥接 |
| **Phase 8.6** | 增加 TUI 交互测试 |

---

## 6. 需要与您确认的关键决策

### 决策 1: TUI 集成模式

**选项**:
- **A. Sidebar 插件**（推荐）: 右侧边栏显示，不侵入主界面
- **B. 独立路由页面**: 全屏视图，按 `Ctrl+G` 切换
- **C. 混合模式**: Sidebar 简略 + Dialog 详细 + 路由切换

**我的建议**: **方案 C（混合模式）**

**理由**:
- Sidebar 提供快速概览
- Dialog 提供节点详情弹窗
- 路由切换提供完整 DAG 可视化
- 满足不同场景需求

---

### 决策 2: DAG 渲染方案

**选项**:
- **A. Box Drawing（`┌─┐│└┘`）**: 清晰直观，但交互难
- **B. 分层列表**: 简单可靠，但信息密度低
- **C. Braille 点阵（`⠁⠉⠋`）**: 灵活但复杂
- **D. 纯文本 + 颜色**: 最简，但视觉冲击力弱

**我的建议**: **A + D 混合**

**理由**:
- Box Drawing 用于结构展示（依赖关系）
- 颜色用于状态区分（✓ 绿 / ● 橙 / ○ 灰 / ✗ 红）
- 避免 Braille（学习成本高，兼容性差）

---

### 决策 3: 语法审批机制

**问题**: AI 生成的结构化路线图如何验证？

**选项**:
- **A. 严格校验**: Parser 失败直接拒绝，用户手动修正
- **B. 容错展示**: 失败时 fallback 为原始 Markdown
- **C. 实时预览**: AI 生成后显示预览，用户确认后保存
- **D. 多轮迭代**: AI 生成 → 预览 → 用户反馈 → AI 修正

**我的建议**: **B + C 混合**

**理由**:
- 先容错展示，确保不阻塞用户
- 同时提供预览，让用户审查
- 如果发现语法错误，AI 可以重新生成

---

### 决策 4: Synthetic Message 的可见性

**问题**: Chat Session 中的 synthetic message（DAG 状态通知）是否对用户可见？

**选项**:
- **A. 对 LLM 可见，对用户隐藏**: 只在消息流中注入，不显示在聊天界面
- **B. 对 LLM 和用户都可见**: 在聊天界面显示 DAG 状态卡片
- **C. 可配置**: 用户可以选择显示/隐藏

**我的建议**: **方案 B（对用户也可见）**

**理由**:
- 用户可以看到 DAG 进度
- 增加透明度
- 用户可以直接点击卡片跳转到 DAG 总控台

---

### 决策 5: 多工作流并行支持

**问题**: 是否支持在一个 Chat Session 中触发多个 DAG Workflow？

**选项**:
- **A. 仅支持单个**: 触发新 Workflow 时提示用户关闭现有
- **B. 支持多个**: Sidebar 显示所有 Workflow 列表
- **C. 有限多个**: 最多 N 个，超出时提示

**我的建议**: **方案 B（支持多个）**

**理由**:
- DAG 本身就是异步执行
- 多个并行可以提升效率
- Sidebar 用列表展示足够清晰

---

### 决策 6: 历史 Workflow 查看

**问题**: 如何查看已完成的 Workflow？

**选项**:
- **A. 仅在 Sidebar 显示运行中**: 完成后自动隐藏
- **B. Sidebar 显示全部**: 包含历史 Workflow
- **C. 单独历史页面**: 按 Session / 时间 / 状态筛选

**我的建议**: **方案 B（Sidebar 显示全部）**

**理由**:
- 用户可能想快速回顾已完成的 Workflow
- 历史页面功能复杂，可留到 Phase 9+
- Sidebar 用时间排序，最新的在前

---

## 7. 我的补充建议

基于调研，我想补充以下想法：

### 补充 1: Toast 通知

- 当 Workflow 完成/失败时，显示全局 Toast
- 示例:
  ```
  ✓ DAG completed: refactor-module (3m 45s)
  ✗ DAG failed: implement-feature (required_node_skipped)
  ```

### 补充 2: 进度条组件

- Sidebar 顶部显示整体进度条
- 用不同颜色区分状态（绿色=完成，橙色=运行中，红色=失败）
- 示例:
  ```
  Progress: [✓✓■■■■■■■■□□□□□□□□] 40%
  ```

### 补充 3: 快捷键支持

- `Ctrl+G`: 打开/关闭 DAG Console
- `Ctrl+Shift+D`: 快速查看所有 Violations
- `Ctrl+N`: 在 Dialog 中快速跳转到下一个 Node

### 补充 4: 导出功能

- 将 DAG 执行记录导出为 Markdown / JSON
- 方便分享给其他 Agent 或人类审查

### 补充 5: DAG 可视化降级策略

- 如果终端太小（< 80 宽），自动降级到列表视图
- 如果终端非常小（< 60 宽），只显示进度条

### 补充 6: 与 Todo 插件联动

- DAG 节点的 `required_nodes` 自动同步到 Todo
- 状态变更时同步更新 Todo

---

## 8. 最终架构决策

### 8.1 TUI 集成模式：最小侵入（独立模块）

**核心原则**: 不修改现有 TUI 代码，通过两个新入口访问 DAG Console。

#### 入口 1: Chat Session 中的 DAG Worker 工具调用条
```typescript
// src/dag/integration/chat-tool-call.ts

export function createDAGWorkerToolCall(workflowId: string): SyntheticMessage {
  return {
    type: 'tool_call',
    tool_name: 'dag_worker',
    workflow_id: workflowId,
    status: 'background_started',
    message: `DAG Worker 已启动 (${workflowId})\n` +
             `使用 dag_status("${workflowId}") 查询进度\n` +
             `[点击查看详情 → DAG Console]`,  // 可点击
  };
}
```

**实现方式**:
- 在 `ChatSession.messages` 中插入 synthetic tool_call 消息
- 前端渲染时，给这条消息添加点击事件:
  ```tsx
  <box onClick={() => navigate('/dag-console', { workflowId })}>
    {renderToolCall(message)}
  </box>
  ```

#### 入口 2: TUI 右侧 DAG-Worker 按钮
```typescript
// src/tui/layout/right-panel.ts

export function renderRightPanel() {
  return (
    <box class="right-panel">
      {/* 现有的 Context、MCP、LSP 按钮 */}
      <button onClick={() => navigate('/dag-console')}>
        🌐 DAG-Worker
      </button>
    </box>
  );
}
```

**实现方式**:
- 在 TUI 右侧面板添加一个独立按钮
- 点击后进入 `/dag-console` 路由
- **不依赖** Sidebar 插槽机制

#### 独立路由: `/dag-console`
```typescript
// src/tui/routes/dag-console.ts

export const DAGConsoleRoute = createRoute('/dag-console', (route) => {
  const workflowId = route.query.workflowId;

  return (
    <DAGConsole
      workflowId={workflowId}
      onClose={() => navigate('/chat')}
    />
  );
});

export function DAGConsole(props: { workflowId?: string; onClose: () => void }) {
  return (
    <modal class="dag-console" onClose={props.onClose}>
      <header>
        <h1>🌐 DAG Console</h1>
        <button onClick={props.onClose}>✕ 关闭</button>
      </header>
      <DAGView workflowId={props.workflowId} />
    </modal>
  );
}
```

**架构隔离**:
```
原版 TUI 代码 (不修改)          我们的独立模块
┌─────────────────────┐       ┌─────────────────────┐
│ /chat               │       │ /dag-console        │
│ /session/:id        │       │   - DAGConsole      │
│ /settings           │       │   - DAGView         │
│ ...                 │       │   - DAGNode         │
│ Sidebar             │       │                     │
│   - Context         │       │ src/tui/routes/     │
│   - MCP             │       │   └── dag-console.ts│
│   - LSP             │       │                     │
│                     │       │ src/dag/integration/ │
│ (完全不动)          │       │   - chat-tool-call.ts│
│                     │       │   - status-injection.ts│
│                     │       │ (完全独立)          │
└─────────────────────┘       └─────────────────────┘
```

**维护优势**:
- ✅ 原版 OpenCode 升级时，只需合并少量代码
- ✅ 我们的改动集中在 `src/dag/` 和 `src/tui/routes/dag-console.ts`
- ✅ 如果原版 TUI 重构，我们只需调整入口，不影响 DAG Console 本身

### 8.2 Synthetic Message: 工具调用形式

**参考实现**: `src/tool/task.ts` 的 `output()` 函数

```typescript
// src/dag/integration/status-injection.ts

export class StatusInjector {
  constructor(
    private eventBus: EventInjectionBridge,
    private sessionService: SessionService,
    private messageService: MessagePartService
  ) {}

  async onWorkflowStarted(event: WorkflowStartedEvent) {
    const workflowId = event.workflow_id;
    const chatSessionId = event.chat_session_id;

    const message: SyntheticToolCall = {
      type: 'tool_call',
      tool_name: 'dag_worker',
      workflow_id: workflowId,
      status: 'background_started',
      output: this.formatStartMessage(workflowId, event),
    };

    // 插入到 Chat Session 消息流
    await this.messageService.insert(chatSessionId, message);
  }

  private formatStartMessage(workflowId: string, event: WorkflowStartedEvent): string {
    const requiredCount = event.required.nodes.length;
    const totalCount = event.all_nodes.length;

    return [
      `🚀 DAG Worker 已启动 (${workflowId})`,
      ``,
      `**Workflow**: ${event.name}`,
      `**Nodes**: ${requiredCount}/${totalCount} required`,
      `**Max Concurrency**: ${event.max_concurrency}`,
      ``,
      `Use \`dag_status("${workflowId}")\` to check progress.`,
      `[Click here to open DAG Console →](/dag-console?workflowId=${workflowId})`,
    ].join('\n');
  }

  async onNodeStateChanged(event: NodeStateChangedEvent) {
    const { workflow_id, node_name, old_state, new_state } = event;

    if (new_state === 'completed') {
      await this.messageService.insert(event.chat_session_id, {
        type: 'tool_call',
        tool_name: 'dag_worker',
        workflow_id,
        status: 'node_completed',
        node_name,
        output: `✓ Node \`${node_name}\` completed (${event.duration_ms}ms)`,
      });
    } else if (new_state === 'failed') {
      await this.messageService.insert(event.chat_session_id, {
        type: 'tool_call',
        tool_name: 'dag_worker',
        workflow_id,
        status: 'node_failed',
        node_name,
        output: `✗ Node \`${node_name}\` failed: ${event.error?.message || 'Unknown error'}`,
      });
    }
  }
}
```

**LLM 可见性**:
- LLM 在消息流中看到这些 tool_call 消息
- 可以主动调用 `dag_status()` 工具查询详细进度
- 用户可以在 Chat 中看到工具调用条，点击打开 DAG Console

**渲染示例**:
```
User: /dag-worker refactor-module
AI: 🚀 DAG Worker 已启动 (wf-3f2a1c)

    Workflow: refactor-module
    Nodes: 8/10 required
    Max Concurrency: 3

    Use dag_status("wf-3f2a1c") to check progress.
    [Click here to open DAG Console →]

    [✓] dag_status("wf-3f2a1c")  ← LLM 调用工具
    Result:
      Nodes: 3 completed, 2 running, 3 pending
      Progress: 30%
      ETA: 4m 30s

    [✓] Node `analyze-code` completed (12.3s)  ← StatusInjector 插入
    [✗] Node `write-docs` failed: Timeout  ← StatusInjector 插入
    ...
```

### 8.3 修改后的实现优先级

| 优先级 | Phase | 任务 |
|--------|-------|------|
| **P0** | Phase 8.1 | DAG Session 核心 API (create, list, get, delete) |
| **P0** | Phase 8.1 | DAG Persistence (SQLite schema + operations) |
| **P0** | Phase 8.1 | DAG EventBus 事件定义 |
| **P1** | Phase 8.2 | RequiredNodesValidator + Monitor |
| **P1** | Phase 8.4 | `/dag-worker` slashcommand + 状态注入 |
| **P1** | Phase 8.4 | Chat tool_call 插入（StatusInjector） |
| **P1** | Phase 8.4 | TUI 入口 1: tool_call 点击事件 |
| **P1** | Phase 8.4 | TUI 入口 2: 右侧 DAG-Worker 按钮 |
| **P1** | Phase 8.4 | DAG Console 路由 + 基础 UI |
| **P2** | Phase 8.2 | 违规检测 + DAG 状态转换验证 |
| **P2** | Phase 8.3 | Worker 级日志捕获（capture stdout/stderr） |
| **P2** | Phase 8.5 | 图查询 API + TUI 树状渲染 |
| **P3** | Phase 8.3 | Metrics 捕获（可选） |
| **P3** | Phase 8.5 | 高级 DAG 可视化（Mermaid / D3 降级） |
| **P3** | Phase 8.6 | 单元测试 + 集成测试 |
| **P4** | Phase 9 | 历史 Workflow 查看 + 导出功能 |

### 8.4 TAB 页标题系统

**核心设计**: 每个 DAG Workflow TAB 显示 AI 生成的语义化标题

| 维度 | 设计 |
|------|------|
| **默认 SESSION TAB** | 显示当前 Chat Session 的标题（已有） |
| **DAG TAB 标题** | 由 AI 根据 Workflow 目标自动生成（3-5 词摘要） |
| **标题格式** | `🚀 [Action] [Target]`（如 "🚀 Refactor auth module"、"🚀 Fix CI pipeline"） |
| **标题更新** | Workflow 执行过程中可动态优化（如进度 >50% 时细化描述） |
| **用户编辑** | 支持双击 TAB 手动修改标题 |

**UI 布局**:
```
┌─────────────────────────────────────────────────────────────────────┐
│ [SESSION]  🚀 Refactor auth  🚀 Fix CI pipe  🚀 Write tests  ◀ ▶  │◄── TAB 栏（横向滚动）
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                   (当前选中 TAB 的内容视图)                          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**标题生成策略**:
```typescript
interface DAGTitleGenerator {
  generate(config: DAGWorkflowConfig): Promise<string>
  // 输入: Workflow 的完整配置（包含 required_nodes、max_concurrency 等）
  // 输出: "🚀 Refactor auth module" 格式的标题
}

// 实现示例:
// - 提取 config.name 中的关键词
// - 识别动作模式（refactor/fix/implement/test）
// - 添加 emoji 前缀标识 Workflow 类型
```

**实现优先级**: **P1**（Phase 8.4 - 核心体验增强）

---

## 9. 实现优先级（建议）

| 优先级 | 功能 |
|--------|------|
| **P0** | 独立 `DAGConsole` 组件 + `/dag-console` 路由 |
| **P0** | TUI 入口 1: Chat 消息 tool_call 点击事件 |
| **P0** | TUI 入口 2: 右侧 DAG-Worker 按钮（最小侵入） |
| **P0** | 工具调用形式的 Synthetic Message 插入（参考 `task.ts`） |
| **P0** | DAG 状态实时更新到 DAG Console |
| **P1** | DAG 渲染器（Box Drawing + 颜色） |
| **P1** | Dialog 弹窗查看节点详情 |
| **P2** | Toast 通知（可选） |
| **P2** | 进度条组件（可选） |
| **P2** | 全局快捷键（可选） |
| **P3** | 导出功能（可选） |

---

## 9. 待讨论问题清单

1. **TUI 集成模式**: 方案 C（混合模式）是否适合？
2. **DAG 渲染**: Box Drawing + 颜色是否足够？还是需要 Braille？
3. **语法审批**: B + C 混合（容错 + 预览）是否符合预期？
4. **Synthetic Message 可见性**: 方案 B（对用户可见）是否合适？
5. **多工作流并行**: 支持多个并行是否会导致混乱？
6. **历史 Workflow**: 是否在 Phase 8 就需要？
7. **补充建议**: 您如何看待我的 6 个补充建议？哪些需要优先实现？

---

**下一步**:
- 请您审查这份报告
- 针对上述 7 个问题反馈决策
- 我将根据反馈细化设计，然后进入 Phase 8 实施
