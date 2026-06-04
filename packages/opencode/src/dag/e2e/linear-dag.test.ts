import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import { readFile, writeFile, mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { $ } from 'bun'

// E2E 测试场景 1: 基本线性 DAG 工作流
describe('E2E - 基本线性 DAG 工作流', () => {
  const testWorkflowId = 'e2e-linear-dag-001'
  const testDir = join('.task_state', `workflow-${testWorkflowId}`)
  const stateFile = join(testDir, 'state.json')
  const yamlFile = join(testDir, 'dag.yaml')

  test('创建测试工作流目录和 YAML 配置', async () => {
    // 清理旧数据
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }

    // 创建工作流目录
    await mkdir(testDir, { recursive: true })

    // 创建简单的线性 DAG YAML
    const yamlContent = `name: basic-linear-dag
description: 基本线性 DAG（skeleton → tdd → implement）

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
        name: skeleton
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "创建骨架代码"
        
      - type: required
        name: tdd
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "编写单元测试"
        depends_on: [skeleton]
        
      - type: required
        name: implement
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "实现业务代码"
        depends_on: [tdd]

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

    // 验证文件创建成功
    expect(existsSync(testDir)).toBe(true)
    expect(existsSync(yamlFile)).toBe(true)

    const content = await readFile(yamlFile, 'utf-8')
    expect(content).toContain('basic-linear-dag')
  })

  test('模拟 skeleton 节点执行成功', async () => {
    const nodeState = {
      node: 'skeleton',
      status: 'completed',
      start_time: Date.now() - 5000,
      end_time: Date.now(),
      output: {
        files_changed: ['src/skeleton.ts'],
        summary: '创建了 skeleton 骨架代码',
      },
    }

    await writeFile(stateFile, JSON.stringify(nodeState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    expect(state.node).toBe('skeleton')
    expect(state.status).toBe('completed')
  })

  test('模拟 tdd 节点依赖 skeleton 完成后才执行', async () => {
    const workflowState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      start_time: Date.now() - 60000,
      nodes: {
        skeleton: {
          status: 'completed',
          start_time: Date.now() - 60000,
          end_time: Date.now() - 55000,
        },
        tdd: {
          status: 'running',
          start_time: Date.now() - 10000,
        },
        implement: {
          status: 'pending',
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(workflowState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    expect(state.nodes.skeleton.status).toBe('completed')
    expect(state.nodes.tdd.status).toBe('running')
    expect(state.nodes.implement.status).toBe('pending')
  })

  test('模拟所有节点完成，工作流状态为 completed', async () => {
    const finalState = {
      workflow_id: testWorkflowId,
      status: 'completed',
      start_time: Date.now() - 60000,
      end_time: Date.now(),
      nodes: {
        skeleton: {
          status: 'completed',
          start_time: Date.now() - 60000,
          end_time: Date.now() - 55000,
          output: {
            files_changed: ['src/skeleton.ts'],
            summary: '创建了 skeleton 骨架代码',
          },
        },
        tdd: {
          status: 'completed',
          start_time: Date.now() - 50000,
          end_time: Date.now() - 20000,
          output: {
            files_changed: ['src/skeleton.test.ts'],
            summary: '编写了 34 个测试用例',
          },
        },
        implement: {
          status: 'completed',
          start_time: Date.now() - 15000,
          end_time: Date.now(),
          output: {
            files_changed: ['src/skeleton.ts'],
            summary: '实现了业务逻辑，34/34 测试通过',
          },
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(finalState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    expect(state.status).toBe('completed')
    expect(state.nodes.skeleton.status).toBe('completed')
    expect(state.nodes.tdd.status).toBe('completed')
    expect(state.nodes.implement.status).toBe('completed')
    expect(state.nodes.skeleton.end_time).toBeLessThan(state.nodes.tdd.start_time)
    expect(state.nodes.tdd.end_time).toBeLessThan(state.nodes.implement.start_time)
  })
})
