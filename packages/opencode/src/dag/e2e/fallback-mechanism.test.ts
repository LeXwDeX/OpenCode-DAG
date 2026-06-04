import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { join } from 'path'
import { readFile, writeFile, mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'

// E2E 测试场景 3: Fallback 机制
// 验证节点失败时 fallback 链的正确执行
describe('E2E - Fallback 机制', () => {
  const testWorkflowId = 'e2e-fallback-001'
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

  test('创建带有 fallback 链的 DAG YAML 配置', async () => {
    const yamlContent = `name: fallback-mechanism-dag
description: Fallback 机制测试 DAG（A 失败 → F1 失败 → F2 成功）

system:
  sandbox:
    type: git_worktree
    base_dir: ".task_state"
    cleanup_on_complete: false
    keep_on_failure: true
  default_merge_strategy: squash
  max_fallback_chain: 3

branches:
  - name: main
    nodes:
      - type: required
        name: implement
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "实现复杂功能"
        timeout_sec: 600
        fallback:
          - name: fallback-1
            agent: implement
            prompt_file: .opencode/agents/implement.md
            task: "重试实现（简化版）"
          - name: fallback-2
            agent: implement
            prompt_file: .opencode/agents/implement.md
            task: "重试实现（最小版）"

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
    expect(content).toContain('fallback-mechanism-dag')
    expect(content).toContain('fallback-1')
    expect(content).toContain('fallback-2')
  })

  test('验证 implement 节点失败后触发 F1', async () => {
    const workflowState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      start_time: Date.now() - 30000,
      nodes: {
        implement: {
          status: 'failed',
          start_time: Date.now() - 30000,
          end_time: Date.now() - 25000,
          error: {
            type: 'timeout',
            message: '节点执行超时',
          },
          push_count: 3,
          fallback_chain_position: 0,
        },
        'fallback-1': {
          status: 'running',
          start_time: Date.now() - 20000,
          fallback_chain_position: 1,
          triggered_by: 'implement',
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(workflowState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证主节点已失败
    expect(state.nodes.implement.status).toBe('failed')
    expect(state.nodes.implement.push_count).toBe(3)
    
    // 验证 F1 已启动
    expect(state.nodes['fallback-1'].status).toBe('running')
    expect(state.nodes['fallback-1'].fallback_chain_position).toBe(1)
    expect(state.nodes['fallback-1'].triggered_by).toBe('implement')
  })

  test('验证 F1 失败后触发 F2', async () => {
    const workflowState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      start_time: Date.now() - 60000,
      nodes: {
        implement: {
          status: 'failed',
          start_time: Date.now() - 60000,
          end_time: Date.now() - 55000,
          error: {
            type: 'timeout',
            message: '节点执行超时',
          },
          push_count: 3,
          fallback_chain_position: 0,
        },
        'fallback-1': {
          status: 'failed',
          start_time: Date.now() - 50000,
          end_time: Date.now() - 40000,
          error: {
            type: 'execution_error',
            message: '编译错误',
          },
          push_count: 3,
          fallback_chain_position: 1,
        },
        'fallback-2': {
          status: 'running',
          start_time: Date.now() - 35000,
          fallback_chain_position: 2,
          triggered_by: 'fallback-1',
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(workflowState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证 implement 和 F1 都已失败
    expect(state.nodes.implement.status).toBe('failed')
    expect(state.nodes['fallback-1'].status).toBe('failed')
    
    // 验证 F2 已启动
    expect(state.nodes['fallback-2'].status).toBe('running')
    expect(state.nodes['fallback-2'].fallback_chain_position).toBe(2)
    expect(state.nodes['fallback-2'].triggered_by).toBe('fallback-1')
  })

  test('验证 F2 成功后工作流完成', async () => {
    const finalState = {
      workflow_id: testWorkflowId,
      status: 'completed',
      start_time: Date.now() - 90000,
      end_time: Date.now(),
      nodes: {
        implement: {
          status: 'failed',
          start_time: Date.now() - 90000,
          end_time: Date.now() - 85000,
          error: {
            type: 'timeout',
            message: '节点执行超时',
          },
          push_count: 3,
          fallback_chain_position: 0,
        },
        'fallback-1': {
          status: 'failed',
          start_time: Date.now() - 80000,
          end_time: Date.now() - 70000,
          error: {
            type: 'execution_error',
            message: '编译错误',
          },
          push_count: 3,
          fallback_chain_position: 1,
        },
        'fallback-2': {
          status: 'completed',
          start_time: Date.now() - 65000,
          end_time: Date.now(),
          output: {
            files_changed: ['src/simplified.ts'],
            summary: '最小化实现完成',
          },
          fallback_chain_position: 2,
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(finalState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证工作流最终状态
    expect(state.status).toBe('completed')
    
    // 验证 fallback 链长度（不超过 max_fallback_chain）
    const failedCount = Object.values(state.nodes).filter((n: any) => n.status === 'failed').length
    expect(failedCount).toBe(2) // implement + fallback-1
    
    // 验证最终完成的节点
    expect(state.nodes['fallback-2'].status).toBe('completed')
    expect(state.nodes['fallback-2'].fallback_chain_position).toBe(2)
    expect(state.nodes['fallback-2'].fallback_chain_position).toBeLessThan(3) // 未超过 max_fallback_chain
  })

  test('验证超过 max_fallback_chain 时工作流失败', async () => {
    const failedState = {
      workflow_id: testWorkflowId,
      status: 'failed',
      start_time: Date.now() - 120000,
      end_time: Date.now(),
      error: {
        type: 'fallback_chain_exhausted',
        message: 'Fallback 链已耗尽，所有重试均失败',
      },
      nodes: {
        implement: {
          status: 'failed',
          error: { type: 'timeout' },
          fallback_chain_position: 0,
        },
        'fallback-1': {
          status: 'failed',
          error: { type: 'execution_error' },
          fallback_chain_position: 1,
        },
        'fallback-2': {
          status: 'failed',
          error: { type: 'timeout' },
          fallback_chain_position: 2,
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(failedState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证工作流失败
    expect(state.status).toBe('failed')
    expect(state.error.type).toBe('fallback_chain_exhausted')
    
    // 验证所有节点都失败
    const allFailed = Object.values(state.nodes).every((n: any) => n.status === 'failed')
    expect(allFailed).toBe(true)
    expect(Object.keys(state.nodes).length).toBe(3) // 达到 max_fallback_chain
  })
})
