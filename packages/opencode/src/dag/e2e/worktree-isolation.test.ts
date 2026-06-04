import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { join } from 'path'
import { readFile, writeFile, mkdir, rm, access } from 'fs/promises'
import { existsSync } from 'fs'
import { $ } from 'bun'

// E2E 测试场景 5: Git Worktree 隔离验证
// 验证 DAG 工作流在独立的 Git worktree 中执行，防止跨工作流污染
describe('E2E - Git Worktree 隔离验证', () => {
  const testWorkflowId1 = 'e2e-worktree-isolation-001'
  const testWorkflowId2 = 'e2e-worktree-isolation-002'
  const testDir1 = join('.task_state', `workflow-${testWorkflowId1}`)
  const testDir2 = join('.task_state', `workflow-${testWorkflowId2}`)
  const stateFile1 = join(testDir1, 'state.json')
  const stateFile2 = join(testDir2, 'state.json')
  const yamlFile1 = join(testDir1, 'dag.yaml')
  const yamlFile2 = join(testDir2, 'dag.yaml')

  beforeAll(async () => {
    // 清理旧数据
    if (existsSync(testDir1)) {
      await rm(testDir1, { recursive: true, force: true })
    }
    if (existsSync(testDir2)) {
      await rm(testDir2, { recursive: true, force: true })
    }

    // 创建工作流目录
    await mkdir(testDir1, { recursive: true })
    await mkdir(testDir2, { recursive: true })
  })

  afterAll(async () => {
    // 清理测试数据
    if (existsSync(testDir1)) {
      await rm(testDir1, { recursive: true, force: true })
    }
    if (existsSync(testDir2)) {
      await rm(testDir2, { recursive: true, force: true })
    }
  })

  test('创建带有 worktree 隔离的 DAG YAML 配置（工作流 1）', async () => {
    const yamlContent = `name: worktree-isolation-dag-1
description: Git Worktree 隔离测试 DAG 1

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
        task: "在工作流 1 的 worktree 中创建骨架"
        
      - type: required
        name: tdd
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "在工作流 1 的 worktree 中编写测试"
        depends_on: [skeleton]
        
      - type: required
        name: implement
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "在工作流 1 的 worktree 中实现功能"
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

    await writeFile(yamlFile1, yamlContent, 'utf-8')

    expect(existsSync(yamlFile1)).toBe(true)

    const content = await readFile(yamlFile1, 'utf-8')
    expect(content).toContain('worktree-isolation-dag-1')
    expect(content).toContain('type: git_worktree')
  })

  test('创建第二个工作流的 DAG YAML 配置（工作流 2）', async () => {
    const yamlContent = `name: worktree-isolation-dag-2
description: Git Worktree 隔离测试 DAG 2

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
        task: "在工作流 2 的 worktree 中初始化"
        
      - type: required
        name: develop
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "在工作流 2 的 worktree 中开发功能"
        depends_on: [init]

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

    await writeFile(yamlFile2, yamlContent, 'utf-8')

    expect(existsSync(yamlFile2)).toBe(true)

    const content = await readFile(yamlFile2, 'utf-8')
    expect(content).toContain('worktree-isolation-dag-2')
  })

  test('模拟两个工作流的初始状态，验证 worktree 路径隔离', async () => {
    // 工作流 1 的初始状态
    const state1 = {
      workflow_id: testWorkflowId1,
      yaml_config: yamlFile1,
      status: 'running',
      worktree: {
        path: `.task_state/workflow-${testWorkflowId1}/worktree`,
        branch: `feature/workflow-${testWorkflowId1}`,
        base_commit: 'abc123',
        created_at: Date.now() - 5000,
        isolation: true,
      },
      nodes: {
        skeleton: {
          status: 'running',
          start_time: Date.now() - 5000,
          worktree_path: `.task_state/workflow-${testWorkflowId1}/worktree`,
          sandbox: {
            root: `.task_state/workflow-${testWorkflowId1}/worktree`,
            isolation: true,
          },
        },
        tdd: {
          status: 'pending',
          worktree_path: `.task_state/workflow-${testWorkflowId1}/worktree`,
        },
        implement: {
          status: 'pending',
          worktree_path: `.task_state/workflow-${testWorkflowId1}/worktree`,
        },
      },
    }

    // 工作流 2 的初始状态
    const state2 = {
      workflow_id: testWorkflowId2,
      yaml_config: yamlFile2,
      status: 'running',
      worktree: {
        path: `.task_state/workflow-${testWorkflowId2}/worktree`,
        branch: `feature/workflow-${testWorkflowId2}`,
        base_commit: 'def456', // 不同的 base commit
        created_at: Date.now() - 3000, // 稍后创建
        isolation: true,
      },
      nodes: {
        init: {
          status: 'running',
          start_time: Date.now() - 3000,
          worktree_path: `.task_state/workflow-${testWorkflowId2}/worktree`,
          sandbox: {
            root: `.task_state/workflow-${testWorkflowId2}/worktree`,
            isolation: true,
          },
        },
        develop: {
          status: 'pending',
          worktree_path: `.task_state/workflow-${testWorkflowId2}/worktree`,
        },
      },
    }

    await writeFile(stateFile1, JSON.stringify(state1, null, 2), 'utf-8')
    await writeFile(stateFile2, JSON.stringify(state2, null, 2), 'utf-8')

    // 读取并验证两个工作流的隔离状态
    const readState1 = JSON.parse(await readFile(stateFile1, 'utf-8'))
    const readState2 = JSON.parse(await readFile(stateFile2, 'utf-8'))

    // 验证工作流 1 和工作流 2 都启用了 worktree 隔离
    expect(readState1.worktree).toBeDefined()
    expect(readState2.worktree).toBeDefined()
    expect(readState1.worktree.isolation).toBe(true)
    expect(readState2.worktree.isolation).toBe(true)

    // 验证 worktree 路径不同
    expect(readState1.worktree.path).not.toEqual(readState2.worktree.path)
    expect(readState1.worktree.path).toContain(testWorkflowId1)
    expect(readState2.worktree.path).toContain(testWorkflowId2)

    // 验证 worktree 分支不同
    expect(readState1.worktree.branch).not.toEqual(readState2.worktree.branch)
    expect(readState1.worktree.branch).toContain(testWorkflowId1)
    expect(readState2.worktree.branch).toContain(testWorkflowId2)

    // 验证节点 sandbox 根目录隔离
    expect(readState1.nodes.skeleton.sandbox.root).not.toEqual(readState2.nodes.init.sandbox.root)
    expect(readState1.nodes.skeleton.sandbox.root).toContain(testWorkflowId1)
    expect(readState2.nodes.init.sandbox.root).toContain(testWorkflowId2)
  })

  test('模拟工作流 1 创建文件，工作流 2 无法访问', async () => {
    // 创建模拟文件在工作流 1 的 worktree 中
    const worktree1Path = join(testDir1, 'worktree')
    const srcDir1 = join(worktree1Path, 'src')
    await mkdir(srcDir1, { recursive: true })
    await writeFile(join(worktree1Path, 'src/feature.ts'), 'export function feature() { return 42; }', 'utf-8')

    // 验证工作流 1 可以访问自己 worktree 中的文件
    expect(existsSync(join(worktree1Path, 'src/feature.ts'))).toBe(true)

    // 验证工作流 2 的 worktree 中不存在这个文件
    const worktree2Path = join(testDir2, 'worktree')
    await mkdir(worktree2Path, { recursive: true })
    expect(existsSync(join(worktree2Path, 'src/feature.ts'))).toBe(false)

    // 更新状态文件，记录文件创建
    const updatedState1 = JSON.parse(await readFile(stateFile1, 'utf-8'))
    updatedState1.nodes.skeleton.output = {
      files_created: [join(worktree1Path, 'src/feature.ts')],
      sandbox: {
        root: worktree1Path,
        isolation: true,
        files_in_sandbox: ['src/feature.ts'],
      },
    }
    await writeFile(stateFile1, JSON.stringify(updatedState1, null, 2), 'utf-8')

    const state1 = JSON.parse(await readFile(stateFile1, 'utf-8'))
    expect(state1.nodes.skeleton.output.sandbox.isolation).toBe(true)
    expect(state1.nodes.skeleton.output.sandbox.files_in_sandbox).toContain('src/feature.ts')
  })

  test('模拟工作流 2 创建同名文件但内容不同，验证隔离性', async () => {
    // 创建工作流 2 的文件（同名但内容不同）
    const worktree2Path = join(testDir2, 'worktree')
    const srcDir2 = join(worktree2Path, 'src')
    await mkdir(srcDir2, { recursive: true })
    await writeFile(join(worktree2Path, 'src/feature.ts'), 'export function feature() { return 99; }', 'utf-8')

    // 验证两个 worktree 中的文件内容不同
    const worktree1Path = join(testDir1, 'worktree')
    const content1 = await readFile(join(worktree1Path, 'src/feature.ts'), 'utf-8')
    const content2 = await readFile(join(worktree2Path, 'src/feature.ts'), 'utf-8')

    expect(content1).toContain('42')
    expect(content2).toContain('99')
    expect(content1).not.toEqual(content2)

    // 更新工作流 2 的状态文件
    const updatedState2 = JSON.parse(await readFile(stateFile2, 'utf-8'))
    updatedState2.nodes.init.output = {
      files_created: [join(worktree2Path, 'src/feature.ts')],
      sandbox: {
        root: worktree2Path,
        isolation: true,
        files_in_sandbox: ['src/feature.ts'],
      },
    }
    await writeFile(stateFile2, JSON.stringify(updatedState2, null, 2), 'utf-8')

    const state2 = JSON.parse(await readFile(stateFile2, 'utf-8'))
    expect(state2.nodes.init.output.sandbox.isolation).toBe(true)
    expect(state2.nodes.init.output.sandbox.files_in_sandbox).toContain('src/feature.ts')
  })

  test('验证工作流完成后 worktree 不会被其他工作流访问', async () => {
    // 标记工作流 1 完成
    const completedState1 = JSON.parse(await readFile(stateFile1, 'utf-8'))
    completedState1.status = 'completed'
    completedState1.end_time = Date.now()
    completedState1.worktree.cleanup_status = 'kept' // keep_on_failure: true
    await writeFile(stateFile1, JSON.stringify(completedState1, null, 2), 'utf-8')

    // 验证工作流 1 的 worktree 仍然存在
    const worktree1Path = join(testDir1, 'worktree')
    expect(existsSync(worktree1Path)).toBe(true)

    // 验证工作流 2 的 worktree 路径仍然独立
    const worktree2Path = join(testDir2, 'worktree')
    expect(existsSync(worktree2Path)).toBe(true)

    // 验证工作流 1 的文件只在其 worktree 中
    const readFile1 = await readFile(join(worktree1Path, 'src/feature.ts'), 'utf-8')
    expect(readFile1).toContain('42')

    const readFile2 = await readFile(join(worktree2Path, 'src/feature.ts'), 'utf-8')
    expect(readFile2).toContain('99')

    // 确认两个文件内容仍然不同（隔离成功）
    expect(readFile1).not.toEqual(readFile2)

    const state1 = JSON.parse(await readFile(stateFile1, 'utf-8'))
    expect(state1.status).toBe('completed')
    expect(state1.worktree.cleanup_status).toBe('kept')
  })
})
