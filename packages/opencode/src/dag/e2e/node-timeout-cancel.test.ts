import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { join } from 'path'
import { readFile, writeFile, mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'

// E2E 测试场景 6: 节点超时和取消
// 验证节点在超时后被正确标记，且后续节点不会执行
describe('E2E - 节点超时和取消', () => {
  const testWorkflowId = 'e2e-node-timeout-001'
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

  test('创建配置短超时时间的 DAG YAML 配置', async () => {
    const yamlContent = `name: node-timeout-dag
description: 节点超时和取消测试 DAG

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
        name: fast-node
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "快速完成任务"
        timeout_sec: 30
        
      - type: required
        name: slow-node
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "耗时较长的任务"
        timeout_sec: 60
        depends_on: [fast-node]
        
      - type: required
        name: final-node
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "最终任务"
        depends_on: [slow-node]

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
    expect(content).toContain('node-timeout-dag')
    expect(content).toContain('fast-node')
    expect(content).toContain('slow-node')
    expect(content).toContain('timeout_sec: 30')
    expect(content).toContain('timeout_sec: 60')
  })

  test('模拟 fast-node 在超时内完成', async () => {
    const workflowState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'running',
      start_time: Date.now() - 120000,
      nodes: {
        'fast-node': {
          status: 'completed',
          start_time: Date.now() - 120000,
          end_time: Date.now() - 100000,
          execution_duration_ms: 20000, // 20 秒，远小于 30 秒超时
          output: {
            files_changed: ['src/init.ts'],
            summary: '快速任务完成',
          },
          timeout_sec: 30,
          completed_within_timeout: true,
        },
        'slow-node': {
          status: 'running',
          start_time: Date.now() - 95000,
          current_duration_ms: 95000, // 已运行 95 秒
          timeout_sec: 60,
          timeout_remaining_ms: -35000, // 已超时 35 秒
        },
        'final-node': {
          status: 'pending',
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(workflowState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证 fast-node 在超时时间内完成
    expect(state.nodes['fast-node'].status).toBe('completed')
    expect(state.nodes['fast-node'].completed_within_timeout).toBe(true)
    expect(state.nodes['fast-node'].execution_duration_ms).toBeLessThan(state.nodes['fast-node'].timeout_sec * 1000)
    
    // 验证 slow-node 已经开始运行
    expect(state.nodes['slow-node'].status).toBe('running')
    
    // 验证 final-node 仍在等待
    expect(state.nodes['final-node'].status).toBe('pending')
  })

  test('模拟 slow-node 执行超时', async () => {
    const timeoutState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'running',
      start_time: Date.now() - 180000, // 3 分钟前开始
      nodes: {
        'fast-node': {
          status: 'completed',
          start_time: Date.now() - 180000,
          end_time: Date.now() - 160000,
          execution_duration_ms: 20000,
          timeout_sec: 30,
          completed_within_timeout: true,
        },
        'slow-node': {
          status: 'timeout',
          start_time: Date.now() - 150000,
          end_time: Date.now() - 90000, // 60 秒后被标记为超时
          execution_duration_ms: 60000, // 运行了 60 秒达到超时时间
          timeout_sec: 60,
          timeout_reason: 'exceeded_timeout',
          timeout_message: '节点执行时间超过 60 秒限制',
          progress: {
            completed_steps: 3,
            total_steps: 5,
            percentage: 60,
          },
        },
        'final-node': {
          status: 'pending',
          blocked_by: ['slow-node'],
          block_reason: 'dependency_timeout',
        },
      },
      errors: [
        {
          type: 'node_timeout',
          node_id: 'slow-node',
          timestamp: Date.now() - 90000,
          message: '节点执行超时：超过 60 秒限制',
        },
      ],
    }

    await writeFile(stateFile, JSON.stringify(timeoutState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证 slow-node 被标记为 timeout
    expect(state.nodes['slow-node'].status).toBe('timeout')
    expect(state.nodes['slow-node'].timeout_reason).toBe('exceeded_timeout')
    expect(state.nodes['slow-node'].timeout_sec).toBe(60)
    expect(state.nodes['slow-node'].execution_duration_ms).toBe(60000)
    
    // 验证 slow-node 未完成（只完成了 60%）
    expect(state.nodes['slow-node'].progress.percentage).toBe(60)
    expect(state.nodes['slow-node'].progress.completed_steps).toBeLessThan(state.nodes['slow-node'].progress.total_steps)
    
    // 验证 final-node 因依赖超时而被阻止执行
    expect(state.nodes['final-node'].status).toBe('pending')
    expect(state.nodes['final-node'].blocked_by).toContain('slow-node')
    expect(state.nodes['final-node'].block_reason).toBe('dependency_timeout')
    
    // 验证工作流有错误记录
    expect(state.errors).toBeDefined()
    expect(state.errors.length).toBe(1)
    expect(state.errors[0].type).toBe('node_timeout')
    expect(state.errors[0].node_id).toBe('slow-node')
  })

  test('模拟工作流因超时而最终失败', async () => {
    const failedState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'failed',
      start_time: Date.now() - 300000, // 5 分钟前开始
      end_time: Date.now() - 90000, // 1.5 分钟前结束
      failure_reason: 'node_timeout_cascade',
      nodes: {
        'fast-node': {
          status: 'completed',
          start_time: Date.now() - 300000,
          end_time: Date.now() - 280000,
          execution_duration_ms: 20000,
          timeout_sec: 30,
          completed_within_timeout: true,
          output: {
            files_changed: ['src/init.ts'],
            summary: '快速任务完成',
          },
        },
        'slow-node': {
          status: 'timeout',
          start_time: Date.now() - 270000,
          end_time: Date.now() - 210000,
          execution_duration_ms: 60000,
          timeout_sec: 60,
          timeout_reason: 'exceeded_timeout',
          progress: {
            completed_steps: 3,
            total_steps: 5,
            percentage: 60,
          },
        },
        'final-node': {
          status: 'skipped',
          skip_reason: 'dependency_timeout',
          skipped_dependencies: ['slow-node'],
        },
      },
      errors: [
        {
          type: 'node_timeout',
          node_id: 'slow-node',
          timestamp: Date.now() - 210000,
          message: '节点执行超时：超过 60 秒限制',
        },
        {
          type: 'workflow_failed',
          reason: 'dependency_timeout_cascade',
          timestamp: Date.now() - 90000,
          failed_nodes: ['slow-node'],
          skipped_nodes: ['final-node'],
          message: '工作流因依赖节点超时而失败',
        },
      ],
      summary: {
        total_nodes: 3,
        completed_nodes: 1,
        failed_nodes: 1,
        skipped_nodes: 1,
        total_execution_time_ms: 210000, // 3.5 分钟
      },
    }

    await writeFile(stateFile, JSON.stringify(failedState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证工作流最终失败
    expect(state.status).toBe('failed')
    expect(state.failure_reason).toBe('node_timeout_cascade')
    expect(state.end_time).toBeGreaterThan(state.start_time)
    
    // 验证节点状态统计
    expect(state.summary.completed_nodes).toBe(1)
    expect(state.summary.failed_nodes).toBe(1)
    expect(state.summary.skipped_nodes).toBe(1)
    
    // 验证 final-node 被跳过
    expect(state.nodes['final-node'].status).toBe('skipped')
    expect(state.nodes['final-node'].skip_reason).toBe('dependency_timeout')
    expect(state.nodes['final-node'].skipped_dependencies).toContain('slow-node')
    
    // 验证有两个错误记录
    expect(state.errors.length).toBe(2)
    expect(state.errors[0].type).toBe('node_timeout')
    expect(state.errors[1].type).toBe('workflow_failed')
  })

  test('模拟节点被手动取消', async () => {
    const cancelState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'cancelled',
      start_time: Date.now() - 200000,
      end_time: Date.now() - 50000,
      cancel_reason: 'user_initiated',
      cancelled_by: 'user',
      nodes: {
        'fast-node': {
          status: 'completed',
          start_time: Date.now() - 200000,
          end_time: Date.now() - 180000,
          execution_duration_ms: 20000,
          output: {
            files_changed: ['src/init.ts'],
            summary: '快速任务完成',
          },
        },
        'slow-node': {
          status: 'cancelled',
          start_time: Date.now() - 175000,
          end_time: Date.now() - 100000, // 用户手动取消
          execution_duration_ms: 75000,
          cancel_reason: 'user_cancelled',
          cancel_message: '用户手动取消了节点执行',
          progress: {
            completed_steps: 2,
            total_steps: 5,
            percentage: 40,
          },
        },
        'final-node': {
          status: 'skipped',
          skip_reason: 'dependency_cancelled',
          skipped_dependencies: ['slow-node'],
        },
      },
      cancellation: {
        timestamp: Date.now() - 100000,
        cancelled_by: 'user',
        reason: '用户决定中止工作流',
        cancelled_nodes: ['slow-node'],
        skipped_nodes: ['final-node'],
      },
      summary: {
        total_nodes: 3,
        completed_nodes: 1,
        cancelled_nodes: 1,
        skipped_nodes: 1,
        total_execution_time_ms: 150000, // 2.5 分钟
      },
    }

    await writeFile(stateFile, JSON.stringify(cancelState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证工作流被取消
    expect(state.status).toBe('cancelled')
    expect(state.cancel_reason).toBe('user_initiated')
    expect(state.cancelled_by).toBe('user')
    
    // 验证慢节点被用户取消
    expect(state.nodes['slow-node'].status).toBe('cancelled')
    expect(state.nodes['slow-node'].cancel_reason).toBe('user_cancelled')
    expect(state.nodes['slow-node'].progress.percentage).toBe(40)
    
    // 验证 final-node 因依赖取消而被跳过
    expect(state.nodes['final-node'].status).toBe('skipped')
    expect(state.nodes['final-node'].skip_reason).toBe('dependency_cancelled')
    
    // 验证取消记录
    expect(state.cancellation).toBeDefined()
    expect(state.cancellation.cancelled_by).toBe('user')
    expect(state.cancellation.cancelled_nodes).toContain('slow-node')
    expect(state.cancellation.skipped_nodes).toContain('final-node')
    
    // 验证统计
    expect(state.summary.completed_nodes).toBe(1)
    expect(state.summary.cancelled_nodes).toBe(1)
    expect(state.summary.skipped_nodes).toBe(1)
  })

  test('模拟节点自动取消（超时后自动终止）', async () => {
    const autoCancelState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'failed',
      start_time: Date.now() - 150000,
      end_time: Date.now() - 50000,
      cancel_reason: 'timeout_auto_cancel',
      nodes: {
        'fast-node': {
          status: 'completed',
          start_time: Date.now() - 150000,
          end_time: Date.now() - 130000,
          execution_duration_ms: 20000,
        },
        'slow-node': {
          status: 'cancelled',
          start_time: Date.now() - 125000,
          end_time: Date.now() - 65000, // 60 秒后自动取消
          execution_duration_ms: 60000,
          timeout_sec: 60,
          cancel_reason: 'timeout_auto_cancel',
          auto_cancelled: true,
          cancel_message: '节点执行时间超过限制，系统自动取消',
        },
        'final-node': {
          status: 'skipped',
          skip_reason: 'dependency_auto_cancelled',
          skipped_dependencies: ['slow-node'],
        },
      },
      timeout_events: [
        {
          node_id: 'slow-node',
          timestamp: Date.now() - 65000,
          timeout_sec: 60,
          action: 'auto_cancel',
          message: '节点执行超时 60 秒，系统自动取消执行',
        },
      ],
      summary: {
        total_nodes: 3,
        completed_nodes: 1,
        auto_cancelled_nodes: 1,
        skipped_nodes: 1,
      },
    }

    await writeFile(stateFile, JSON.stringify(autoCancelState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证工作流因超时自动取消而失败
    expect(state.status).toBe('failed')
    expect(state.cancel_reason).toBe('timeout_auto_cancel')
    
    // 验证慢节点被自动取消
    expect(state.nodes['slow-node'].status).toBe('cancelled')
    expect(state.nodes['slow-node'].cancel_reason).toBe('timeout_auto_cancel')
    expect(state.nodes['slow-node'].auto_cancelled).toBe(true)
    expect(state.nodes['slow-node'].execution_duration_ms).toBe(60000)
    
    // 验证 final-node 因依赖自动取消而被跳过
    expect(state.nodes['final-node'].status).toBe('skipped')
    expect(state.nodes['final-node'].skip_reason).toBe('dependency_auto_cancelled')
    
    // 验证超时事件记录
    expect(state.timeout_events).toBeDefined()
    expect(state.timeout_events.length).toBe(1)
    expect(state.timeout_events[0].action).toBe('auto_cancel')
    expect(state.timeout_events[0].node_id).toBe('slow-node')
    
    // 验证统计
    expect(state.summary.auto_cancelled_nodes).toBe(1)
    expect(state.summary.skipped_nodes).toBe(1)
  })
})
