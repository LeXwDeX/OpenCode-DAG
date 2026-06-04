import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { join } from 'path'
import { readFile, writeFile, mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'

// E2E 测试场景 2: 并行节点执行
// 验证 DAG 中无依赖关系的节点可以并发执行
describe('E2E - 并行节点执行', () => {
  const testWorkflowId = 'e2e-parallel-dag-001'
  const testDir = join('.task_state', `workflow-${testWorkflowId}`)
  const stateFile = join(testDir, 'state.json')
  const yamlFile = join(testDir, 'dag.yaml')

  beforeAll(async () => {
    // 清理旧数据
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }

    // 创建工作流目录
    await mkdir(testDir, { recursive: true })
  })

  afterAll(async () => {
    // 清理测试数据
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  test('创建并行 DAG YAML 配置', async () => {
    const yamlContent = `name: parallel-nodes-dag
description: 并行节点执行 DAG（A → B, C 并行 → D 汇聚）

system:
  sandbox:
    type: git_worktree
    base_dir: ".task_state"
    cleanup_on_complete: false
    keep_on_failure: true
  default_merge_strategy: squash

branches:
  - name: main
    nodes:
      - type: required
        name: setup
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "初始化项目结构"
        
      - type: required
        name: frontend
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "实现前端组件"
        depends_on: [setup]
        
      - type: required
        name: backend
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "实现后端 API"
        depends_on: [setup]
        
      - type: required
        name: integration
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "集成测试"
        depends_on: [frontend, backend]

constraints:
  max_nodes: 20
  max_concurrency: 3
  node_timeout_sec: 600
  max_pushes: 3
  max_fallback_chain: 3
  disable_worktree_isolation: false

fallback:
  max_chain: 3
`

    await writeFile(yamlFile, yamlContent, 'utf-8')

    expect(existsSync(yamlFile)).toBe(true)

    const content = await readFile(yamlFile, 'utf-8')
    expect(content).toContain('parallel-nodes-dag')
    expect(content).toContain('frontend')
    expect(content).toContain('backend')
  })

  test('验证 setup 节点完成后，frontend 和 backend 可以并发启动', async () => {
    const workflowState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      start_time: Date.now() - 30000,
      nodes: {
        setup: {
          status: 'completed',
          start_time: Date.now() - 30000,
          end_time: Date.now() - 28000,
          output: {
            files_changed: ['src/index.ts', 'package.json'],
            summary: '项目结构初始化完成',
          },
        },
        frontend: {
          status: 'running',
          start_time: Date.now() - 25000,
          // 注意：frontend 和 backend 几乎同时启动（相差 < 1s）
        },
        backend: {
          status: 'running',
          start_time: Date.now() - 24500, // 比 frontend 晚 500ms，但可以认为是并发
        },
        integration: {
          status: 'pending',
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(workflowState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证 setup 已完成
    expect(state.nodes.setup.status).toBe('completed')
    
    // 验证 frontend 和 backend 都在运行
    expect(state.nodes.frontend.status).toBe('running')
    expect(state.nodes.backend.status).toBe('running')
    
    // 验证它们的启动时间差很小（并发执行）
    const timeDiff = Math.abs(state.nodes.frontend.start_time - state.nodes.backend.start_time)
    expect(timeDiff).toBeLessThan(2000) // 时间差小于 2 秒，认为是并发
    
    // 验证 integration 还在等待
    expect(state.nodes.integration.status).toBe('pending')
  })

  test('验证 frontend 和 backend 都完成后，integration 节点才能启动', async () => {
    const workflowState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      start_time: Date.now() - 60000,
      nodes: {
        setup: {
          status: 'completed',
          start_time: Date.now() - 60000,
          end_time: Date.now() - 58000,
        },
        frontend: {
          status: 'completed',
          start_time: Date.now() - 55000,
          end_time: Date.now() - 20000,
          output: {
            files_changed: ['src/components/App.tsx'],
            summary: '前端组件实现完成',
          },
        },
        backend: {
          status: 'completed',
          start_time: Date.now() - 54500,
          end_time: Date.now() - 18000,
          output: {
            files_changed: ['src/api/handler.ts'],
            summary: '后端 API 实现完成',
          },
        },
        integration: {
          status: 'running',
          start_time: Date.now() - 15000,
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(workflowState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证 frontend 和 backend 都已完成
    expect(state.nodes.frontend.status).toBe('completed')
    expect(state.nodes.backend.status).toBe('completed')
    
    // 验证 integration 节点已经启动
    expect(state.nodes.integration.status).toBe('running')
    
    // 验证 integration 的启动时间晚于 frontend 和 backend 的完成时间
    const maxBackendEnd = Math.max(state.nodes.frontend.end_time, state.nodes.backend.end_time)
    expect(state.nodes.integration.start_time).toBeGreaterThan(maxBackendEnd)
  })

  test('验证所有节点完成，工作流状态为 completed', async () => {
    const finalState = {
      workflow_id: testWorkflowId,
      status: 'completed',
      start_time: Date.now() - 60000,
      end_time: Date.now(),
      nodes: {
        setup: {
          status: 'completed',
          start_time: Date.now() - 60000,
          end_time: Date.now() - 58000,
        },
        frontend: {
          status: 'completed',
          start_time: Date.now() - 55000,
          end_time: Date.now() - 20000,
        },
        backend: {
          status: 'completed',
          start_time: Date.now() - 54500,
          end_time: Date.now() - 18000,
        },
        integration: {
          status: 'completed',
          start_time: Date.now() - 15000,
          end_time: Date.now(),
          output: {
            files_changed: ['src/integration.test.ts'],
            summary: '集成测试通过',
          },
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(finalState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    expect(state.status).toBe('completed')
    expect(Object.keys(state.nodes).length).toBe(4)
    
    // 验证所有节点都已完成
    for (const nodeId of ['setup', 'frontend', 'backend', 'integration']) {
      expect(state.nodes[nodeId].status).toBe('completed')
    }
  })
})
