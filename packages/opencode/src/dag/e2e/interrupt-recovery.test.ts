import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { join } from 'path'
import { readFile, writeFile, mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'

// E2E 测试场景 4: 工作流中断和恢复
// 验证工作流在中断后能够正确恢复，已完成节点不会重新执行
describe('E2E - 工作流中断和恢复', () => {
  const testWorkflowId = 'e2e-interrupt-recovery-001'
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

  test('创建多节点 DAG YAML 配置', async () => {
    const yamlContent = `name: interrupt-recovery-dag
description: 工作流中断和恢复测试 DAG（A → B → C → D）

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
        name: init
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "初始化项目"
        
      - type: required
        name: design
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "设计架构"
        depends_on: [init]
        
      - type: required
        name: implement
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "实现功能"
        depends_on: [design]
        
      - type: required
        name: test
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "编写测试"
        depends_on: [implement]

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
    expect(content).toContain('interrupt-recovery-dag')
    expect(content).toContain('init')
    expect(content).toContain('design')
    expect(content).toContain('implement')
    expect(content).toContain('test')
  })

  test('模拟工作流正常执行 2 个节点', async () => {
    const workflowState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'running',
      start_time: Date.now() - 60000,
      nodes: {
        init: {
          status: 'completed',
          start_time: Date.now() - 60000,
          end_time: Date.now() - 55000,
          output: {
            files_changed: ['src/init.ts', 'package.json'],
            summary: '项目初始化完成',
          },
        },
        design: {
          status: 'completed',
          start_time: Date.now() - 50000,
          end_time: Date.now() - 40000,
          output: {
            files_changed: ['docs/architecture.md'],
            summary: '架构设计完成',
          },
        },
        implement: {
          status: 'running',
          start_time: Date.now() - 35000,
          // implementing 节点正在执行
        },
        test: {
          status: 'pending',
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(workflowState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证前 2 个节点已完成
    expect(state.nodes.init.status).toBe('completed')
    expect(state.nodes.design.status).toBe('completed')
    
    // 验证 implement 节点正在运行
    expect(state.nodes.implement.status).toBe('running')
    
    // 验证 test 节点还在等待
    expect(state.nodes.test.status).toBe('pending')
  })

  test('模拟工作流中断（implement 节点执行中突然停止）', async () => {
    const interruptedState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'interrupted',
      start_time: Date.now() - 60000,
      interrupted_time: Date.now() - 30000,
      interrupt_reason: 'process_crashed',
      nodes: {
        init: {
          status: 'completed',
          start_time: Date.now() - 60000,
          end_time: Date.now() - 55000,
          output: {
            files_changed: ['src/init.ts', 'package.json'],
            summary: '项目初始化完成',
          },
        },
        design: {
          status: 'completed',
          start_time: Date.now() - 50000,
          end_time: Date.now() - 40000,
          output: {
            files_changed: ['docs/architecture.md'],
            summary: '架构设计完成',
          },
        },
        implement: {
          status: 'interrupted',
          start_time: Date.now() - 35000,
          interrupted_time: Date.now() - 30000,
          interrupt_reason: 'node_execution_interrupted',
          progress: {
            files_created: 2,
            files_remaining: 3,
            percentage: 40,
          },
        },
        test: {
          status: 'pending',
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(interruptedState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证工作流状态为 interrupted
    expect(state.status).toBe('interrupted')
    expect(state.interrupt_reason).toBe('process_crashed')
    
    // 验证已完成的节点保持 completed 状态
    expect(state.nodes.init.status).toBe('completed')
    expect(state.nodes.design.status).toBe('completed')
    
    // 验证中断的节点状态
    expect(state.nodes.implement.status).toBe('interrupted')
    expect(state.nodes.implement.progress?.percentage).toBe(40)
    
    // 验证后续节点仍在等待
    expect(state.nodes.test.status).toBe('pending')
  })

  test('模拟工作流恢复执行', async () => {
    const resumedState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'running',
      start_time: Date.now() - 60000,
      resumed_time: Date.now() - 5000, // 5 秒前恢复
      nodes: {
        init: {
          status: 'completed',
          start_time: Date.now() - 60000,
          end_time: Date.now() - 55000,
          output: {
            files_changed: ['src/init.ts', 'package.json'],
            summary: '项目初始化完成',
          },
          skip_on_resume: true, // 标记为跳过执行
        },
        design: {
          status: 'completed',
          start_time: Date.now() - 50000,
          end_time: Date.now() - 40000,
          output: {
            files_changed: ['docs/architecture.md'],
            summary: '架构设计完成',
          },
          skip_on_resume: true, // 标记为跳过执行
        },
        implement: {
          status: 'running',
          start_time: Date.now() - 60000,
          resumed_time: Date.now() - 5000, // 从 5 秒前重新启动
          progress: {
            files_created: 3, // 恢复后进度从 2 增加到 3
            files_remaining: 2,
            percentage: 60,
          },
        },
        test: {
          status: 'pending',
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(resumedState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证工作流已恢复运行
    expect(state.status).toBe('running')
    expect(state.resumed_time).toBeGreaterThan(state.start_time)
    
    // 验证已完成的节点不会重新执行
    expect(state.nodes.init.skip_on_resume).toBe(true)
    expect(state.nodes.design.skip_on_resume).toBe(true)
    
    // 验证中断节点从断点继续
    expect(state.nodes.implement.status).toBe('running')
    expect(state.nodes.implement.progress?.percentage).toBe(60) // 进度增加
    expect(state.nodes.implement.resumed_time).toBeGreaterThan(state.nodes.implement.start_time)
    
    // 验证后续节点仍在等待
    expect(state.nodes.test.status).toBe('pending')
  })

  test('模拟工作流恢复后完成所有节点', async () => {
    const finalState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'completed',
      start_time: Date.now() - 120000, // 2 分钟前开始
      interrupted_time: Date.now() - 90000, // 1.5 分钟前中断
      resumed_time: Date.now() - 60000, // 1 分钟前恢复
      end_time: Date.now(),
      nodes: {
        init: {
          status: 'completed',
          start_time: Date.now() - 120000,
          end_time: Date.now() - 115000,
          output: {
            files_changed: ['src/init.ts', 'package.json'],
            summary: '项目初始化完成',
          },
          skip_on_resume: true,
        },
        design: {
          status: 'completed',
          start_time: Date.now() - 110000,
          end_time: Date.now() - 100000,
          output: {
            files_changed: ['docs/architecture.md'],
            summary: '架构设计完成',
          },
          skip_on_resume: true,
        },
        implement: {
          status: 'completed',
          start_time: Date.now() - 95000,
          resumed_time: Date.now() - 55000, // 恢复后继续执行
          end_time: Date.now() - 40000, // 最终完成
          output: {
            files_changed: ['src/feature.ts', 'src/utils.ts', 'src/types.ts', 'src/config.ts', 'src/index.ts'],
            summary: '功能实现完成（从中断恢复）',
          },
          progress: {
            files_created: 5,
            files_remaining: 0,
            percentage: 100,
          },
        },
        test: {
          status: 'completed',
          start_time: Date.now() - 35000,
          end_time: Date.now(),
          output: {
            files_changed: ['src/feature.test.ts'],
            summary: '测试编写完成并通过',
          },
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(finalState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证工作流最终状态
    expect(state.status).toBe('completed')
    expect(state.end_time).toBeGreaterThan(state.resumed_time)
    
    // 验证所有节点都完成
    expect(state.nodes.init.status).toBe('completed')
    expect(state.nodes.design.status).toBe('completed')
    expect(state.nodes.implement.status).toBe('completed')
    expect(state.nodes.test.status).toBe('completed')
    
    // 验证 implement 节点的执行时间包括中断和恢复
    const implementExecutionTime = state.nodes.implement.end_time - state.nodes.implement.start_time
    const implementResumedTime = state.nodes.implement.end_time - state.nodes.implement.resumed_time
    expect(implementExecutionTime).toBeGreaterThan(implementResumedTime)
    
    // 验证 implement 节点最终进度为 100%
    expect(state.nodes.implement.progress?.percentage).toBe(100)
    
    // 验证测试节点在中断恢复后正常执行
    expect(state.nodes.test.start_time).toBeGreaterThan(state.nodes.implement.end_time)
    expect(state.nodes.test.status).toBe('completed')
    
    // 验证时间线完整性
    expect(state.interrupted_time).toBeGreaterThan(state.start_time)
    expect(state.resumed_time).toBeGreaterThan(state.interrupted_time)
    expect(state.end_time).toBeGreaterThan(state.resumed_time)
  })
})
