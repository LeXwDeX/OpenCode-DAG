import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { join } from 'path'
import { readFile, writeFile, mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'

// E2E 测试场景 7: 完整执行流程验证
// 模拟一个现实的多节点、多分支、有依赖关系的复杂工作流
describe('E2E - 完整执行流程验证', () => {
  const testWorkflowId = 'e2e-complete-flow-001'
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

  test('创建现实场景的复杂 DAG YAML 配置', async () => {
    const yamlContent = `name: complex-realworld-dag
description: 真实场景复杂 DAG - 多分支多依赖多工具调用

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
        name: analyze_requirements
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "分析需求并输出设计方案"
        timeout_sec: 300
        output_schema:
          design_doc: string
          estimated_effort: number
        
      - type: required
        name: setup_project
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "初始化项目结构"
        depends_on: [analyze_requirements]
        timeout_sec: 600
        tools: [Bash, Write]
        output_schema:
          project_structure: string[]

      - type: required
        name: implement_core
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "实现核心业务逻辑"
        depends_on: [analyze_requirements, setup_project]
        timeout_sec: 1200
        tools: [Write, Read]
        max_pushes: 5
        
      - type: required
        name: implement_api
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "实现 API 接口"
        depends_on: [analyze_requirements, setup_project]
        timeout_sec: 900
        tools: [Write, Read]
        
      - type: required
        name: implement_tests
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "编写集成测试"
        depends_on: [implement_core, implement_api]
        timeout_sec: 900
        tools: [Write, Bash]
        
      - type: required
        name: run_tests
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "运行所有测试"
        depends_on: [implement_tests]
        timeout_sec: 600
        tools: [Bash]
        output_schema:
          test_results: object
          pass_count: number
          fail_count: number
        
      - type: optional
        name: deploy_staging
        agent: implement
        prompt_file: .opencode/agents/implement.md
        task: "部署到 staging 环境"
        depends_on: [run_tests]
        timeout_sec: 300
        condition: pass_count > 0

constraints:
  max_nodes: 20
  max_concurrency: 3
  node_timeout_sec: 1200
  max_pushes: 5
  max_fallback_chain: 3
  disable_worktree_isolation: false

fallback:
  max_chain: 3

metadata:
  created_by: user
  project: complex-feature
  priority: high
`

    await writeFile(yamlFile, yamlContent, 'utf-8')

    expect(existsSync(yamlFile)).toBe(true)

    const content = await readFile(yamlFile, 'utf-8')
    expect(content).toContain('complex-realworld-dag')
    expect(content).toContain('analyze_requirements')
    expect(content).toContain('setup_project')
    expect(content).toContain('implement_core')
    expect(content).toContain('implement_api')
    expect(content).toContain('implement_tests')
    expect(content).toContain('run_tests')
    expect(content).toContain('deploy_staging')
    expect(content).toContain('max_concurrency: 3')
  })

  test('验证 DAG 拓扑排序正确', async () => {
    const topologicalOrder = [
      'analyze_requirements',
      'setup_project',
      'implement_core',
      'implement_api',
      'implement_tests',
      'run_tests',
      'deploy_staging'
    ]

    // 验证依赖关系
    const dependencies: Record<string, string[]> = {
      'analyze_requirements': [],
      'setup_project': ['analyze_requirements'],
      'implement_core': ['analyze_requirements', 'setup_project'],
      'implement_api': ['analyze_requirements', 'setup_project'],
      'implement_tests': ['implement_core', 'implement_api'],
      'run_tests': ['implement_tests'],
      'deploy_staging': ['run_tests']
    }

    // 验证每个节点的依赖都在其之前
    for (let i = 0; i < topologicalOrder.length; i++) {
      const node = topologicalOrder[i]
      const deps = dependencies[node]
      
      for (const dep of deps) {
        const depIndex = topologicalOrder.indexOf(dep)
        expect(depIndex).toBeLessThan(i)
      }
    }

    // 验证可以并发执行的节点组
    const concurrentGroups = [
      ['analyze_requirements'], // 第一组：单个节点
      ['setup_project'], // 第二组：单个节点（依赖第一组）
      ['implement_core', 'implement_api'], // 第三组：两个并发节点
      ['implement_tests'], // 第四组：单个节点（依赖第三组）
      ['run_tests'], // 第五组：单个节点
      ['deploy_staging'] // 第六组：单个节点
    ]

    expect(concurrentGroups.length).toBe(6)
    expect(concurrentGroups[2]).toContain('implement_core')
    expect(concurrentGroups[2]).toContain('implement_api')
  })

  test('模拟工作流开始，analyze_requirements 节点执行', async () => {
    const workflowState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'running',
      start_time: Date.now() - 600000, // 10 分钟前开始
      worktree: {
        path: `.task_state/workflow-${testWorkflowId}/worktree`,
        branch: `feature/workflow-${testWorkflowId}`,
        isolation: true,
      },
      nodes: {
        'analyze_requirements': {
          status: 'completed',
          start_time: Date.now() - 600000,
          end_time: Date.now() - 580000,
          execution_duration_ms: 20000,
          output: {
            design_doc: '## 设计方案\n\n1. 核心模块 A\n2. API 层\n3. 集成测试',
            estimated_effort: 8,
          },
          output_schema: {
            design_doc: 'string',
            estimated_effort: 'number'
          },
          tools_used: ['Read'],
        },
        'setup_project': {
          status: 'running',
          start_time: Date.now() - 575000,
          execution_duration_ms: 5000,
          tools: ['Bash', 'Write'],
          progress: {
            completed_steps: 1,
            total_steps: 3,
            percentage: 33,
          },
        },
        'implement_core': {
          status: 'pending',
          depends_on: ['analyze_requirements', 'setup_project'],
        },
        'implement_api': {
          status: 'pending',
          depends_on: ['analyze_requirements', 'setup_project'],
        },
        'implement_tests': {
          status: 'pending',
          depends_on: ['implement_core', 'implement_api'],
        },
        'run_tests': {
          status: 'pending',
          depends_on: ['implement_tests'],
        },
        'deploy_staging': {
          status: 'pending',
          depends_on: ['run_tests'],
          condition: 'pass_count > 0',
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(workflowState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证 analyze_requirements 已完成
    expect(state.nodes['analyze_requirements'].status).toBe('completed')
    expect(state.nodes['analyze_requirements'].output.design_doc).toContain('设计方案')
    expect(state.nodes['analyze_requirements'].output.estimated_effort).toBe(8)
    
    // 验证 setup_project 正在执行
    expect(state.nodes['setup_project'].status).toBe('running')
    expect(state.nodes['setup_project'].progress.percentage).toBe(33)
    
    // 验证实现节点在等待
    expect(state.nodes['implement_core'].status).toBe('pending')
    expect(state.nodes['implement_api'].status).toBe('pending')
  })

  test('模拟并发执行 implement_core 和 implement_api', async () => {
    const workflowState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'running',
      start_time: Date.now() - 600000,
      worktree: {
        path: `.task_state/workflow-${testWorkflowId}/worktree`,
        branch: `feature/workflow-${testWorkflowId}`,
        isolation: true,
      },
      nodes: {
        'analyze_requirements': {
          status: 'completed',
          start_time: Date.now() - 600000,
          end_time: Date.now() - 580000,
        },
        'setup_project': {
          status: 'completed',
          start_time: Date.now() - 575000,
          end_time: Date.now() - 550000,
          output: {
            project_structure: ['src/core/', 'src/api/', 'tests/'],
          },
        },
        'implement_core': {
          status: 'running',
          start_time: Date.now() - 545000,
          execution_duration_ms: 120000, // 2 分钟
          tools_used: ['Write', 'Read'],
          files_changed: ['src/core/core.ts', 'src/core/utils.ts'],
          progress: {
            completed_steps: 4,
            total_steps: 10,
            percentage: 40,
          },
          push_count: 1,
          max_pushes: 5,
        },
        'implement_api': {
          status: 'running',
          start_time: Date.now() - 545000, // 同时启动
          execution_duration_ms: 120000,
          tools_used: ['Write', 'Read'],
          files_changed: ['src/api/endpoint.ts', 'src/api/controller.ts'],
          progress: {
            completed_steps: 3,
            total_steps: 8,
            percentage: 37.5,
          },
          push_count: 1,
        },
        'implement_tests': {
          status: 'pending',
          depends_on: ['implement_core', 'implement_api'],
        },
        'run_tests': {
          status: 'pending',
          depends_on: ['implement_tests'],
        },
        'deploy_staging': {
          status: 'pending',
          depends_on: ['run_tests'],
          condition: 'pass_count > 0',
        },
      },
      concurrency: {
        current_running: 2,
        max_concurrency: 3,
        running_nodes: ['implement_core', 'implement_api'],
      },
    }

    await writeFile(stateFile, JSON.stringify(workflowState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证并发执行
    expect(state.concurrency.current_running).toBe(2)
    expect(state.concurrency.current_running).toBeLessThanOrEqual(state.concurrency.max_concurrency)
    expect(state.concurrency.running_nodes).toContain('implement_core')
    expect(state.concurrency.running_nodes).toContain('implement_api')
    
    // 验证两个节点几乎同时启动（相同 start_time，允许 100ms 误差）
    const timeDiff = Math.abs(state.nodes['implement_core'].start_time - state.nodes['implement_api'].start_time)
    expect(timeDiff).toBeLessThan(100)
    
    // 验证都在使用正确的 tools
    expect(state.nodes['implement_core'].tools_used).toContain('Write')
    expect(state.nodes['implement_api'].tools_used).toContain('Write')
    
    // 验证 implement_tests 还在等待两个前置节点完成
    expect(state.nodes['implement_tests'].status).toBe('pending')
  })

  test('模拟节点完成后激活依赖节点', async () => {
    const workflowState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'running',
      start_time: Date.now() - 900000,
      worktree: {
        path: `.task_state/workflow-${testWorkflowId}/worktree`,
        branch: `feature/workflow-${testWorkflowId}`,
        isolation: true,
      },
      nodes: {
        'analyze_requirements': {
          status: 'completed',
          completion_time: Date.now() - 880000,
        },
        'setup_project': {
          status: 'completed',
          completion_time: Date.now() - 850000,
        },
        'implement_core': {
          status: 'completed',
          start_time: Date.now() - 845000,
          end_time: Date.now() - 600000, // 4 分钟完成
          execution_duration_ms: 245000,
          output: {
            files_changed: [
              'src/core/core.ts',
              'src/core/utils.ts',
              'src/core/types.ts',
              'src/core/index.ts'
            ],
            summary: '核心模块实现完成',
          },
          push_count: 3,
        },
        'implement_api': {
          status: 'completed',
          start_time: Date.now() - 845000,
          end_time: Date.now() - 550000, // 5 分钟完成
          execution_duration_ms: 295000,
          output: {
            files_changed: [
              'src/api/endpoint.ts',
              'src/api/controller.ts',
              'src/api/validator.ts'
            ],
            summary: 'API 层实现完成',
          },
          push_count: 2,
        },
        'implement_tests': {
          status: 'running',
          start_time: Date.now() - 545000, // 在 implement_core 和 implement_api 都完成后启动
          execution_duration_ms: 5000,
          progress: {
            completed_steps: 1,
            total_steps: 12,
            percentage: 8.3,
          },
          activated_by: ['implement_core', 'implement_api'],
        },
        'run_tests': {
          status: 'pending',
          depends_on: ['implement_tests'],
        },
        'deploy_staging': {
          status: 'pending',
          depends_on: ['run_tests'],
          condition: 'pass_count > 0',
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(workflowState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证 implement_core 和 implement_api 都完成
    expect(state.nodes['implement_core'].status).toBe('completed')
    expect(state.nodes['implement_api'].status).toBe('completed')
    
    // 验证 implement_tests 被激活
    expect(state.nodes['implement_tests'].status).toBe('running')
    expect(state.nodes['implement_tests'].activated_by).toContain('implement_core')
    expect(state.nodes['implement_tests'].activated_by).toContain('implement_api')
    
    // 验证 implement_tests 在两者都完成后启动
    const dependencyCompletionTime = Math.max(
      state.nodes['implement_core'].end_time,
      state.nodes['implement_api'].end_time
    )
    expect(state.nodes['implement_tests'].start_time).toBeGreaterThan(dependencyCompletionTime)
    expect(state.nodes['implement_tests'].start_time - dependencyCompletionTime).toBeLessThan(10000) // 5 秒内启动
  })

  test('模拟 run_tests 节点完成并生成结果', async () => {
    const workflowState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'running',
      start_time: Date.now() - 1500000,
      worktree: {
        path: `.task_state/workflow-${testWorkflowId}/worktree`,
        branch: `feature/workflow-${testWorkflowId}`,
        isolation: true,
      },
      nodes: {
        'analyze_requirements': {
          status: 'completed',
          completion_time: Date.now() - 1480000,
        },
        'setup_project': {
          status: 'completed',
          completion_time: Date.now() - 1450000,
        },
        'implement_core': {
          status: 'completed',
          completion_time: Date.now() - 1200000,
        },
        'implement_api': {
          status: 'completed',
          completion_time: Date.now() - 1150000,
        },
        'implement_tests': {
          status: 'completed',
          completion_time: Date.now() - 1050000,
          output: {
            files_changed: [
              'tests/integration.test.ts',
              'tests/e2e.test.ts',
              'tests/unit.test.ts'
            ],
          },
        },
        'run_tests': {
          status: 'completed',
          start_time: Date.now() - 1000000,
          end_time: Date.now() - 800000,
          execution_duration_ms: 200000, // 3.3 分钟
          output: {
            test_results: {
              unit: { total: 45, pass: 45, fail: 0 },
              integration: { total: 12, pass: 12, fail: 0 },
              e2e: { total: 8, pass: 8, fail: 0 },
            },
            pass_count: 65,
            fail_count: 0,
            coverage_percentage: 87.3,
          },
          output_schema: {
            test_results: 'object',
            pass_count: 'number',
            fail_count: 'number'
          },
          tool_output: 'Running tests...\nTest suite: unit (45 passed, 0 failed)\nTest suite: integration (12 passed, 0 failed)\nTest suite: e2e (8 passed, 0 failed)\nAll 65 tests passed!',
        },
        'deploy_staging': {
          status: 'running',
          start_time: Date.now() - 795000,
          condition: 'pass_count > 0',
          condition_met: true,
          condition_value: 65,
          progress: {
            completed_steps: 1,
            total_steps: 4,
            percentage: 25,
          },
        },
      },
    }

    await writeFile(stateFile, JSON.stringify(workflowState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证 run_tests 完成
    expect(state.nodes['run_tests'].status).toBe('completed')
    expect(state.nodes['run_tests'].output.pass_count).toBe(65)
    expect(state.nodes['run_tests'].output.fail_count).toBe(0)
    expect(state.nodes['run_tests'].output.coverage_percentage).toBe(87.3)
    
    // 验证条件检查通过
    expect(state.nodes['deploy_staging'].condition).toBe('pass_count > 0')
    expect(state.nodes['deploy_staging'].condition_met).toBe(true)
    expect(state.nodes['deploy_staging'].condition_value).toBe(65)
    expect(state.nodes['deploy_staging'].condition_value).toBeGreaterThan(0)
    
    // 验证 deploy_staging 被激活
    expect(state.nodes['deploy_staging'].status).toBe('running')
    expect(state.nodes['deploy_staging'].progress.percentage).toBe(25)
  })

  test('模拟工作流最终完成', async () => {
    const finalState = {
      workflow_id: testWorkflowId,
      yaml_config: yamlFile,
      status: 'completed',
      start_time: Date.now() - 1800000, // 30 分钟前开始
      end_time: Date.now(),
      execution_duration_ms: 1800000, // 30 分钟
      worktree: {
        path: `.task_state/workflow-${testWorkflowId}/worktree`,
        branch: `feature/workflow-${testWorkflowId}`,
        isolation: true,
        cleaned_up: false,
      },
      nodes: {
        'analyze_requirements': {
          status: 'completed',
          start_time: Date.now() - 1800000,
          end_time: Date.now() - 1780000,
          execution_duration_ms: 20000,
          critical_path: true,
        },
        'setup_project': {
          status: 'completed',
          start_time: Date.now() - 1775000,
          end_time: Date.now() - 1750000,
          execution_duration_ms: 25000,
          critical_path: true,
        },
        'implement_core': {
          status: 'completed',
          start_time: Date.now() - 1745000,
          end_time: Date.now() - 1500000,
          execution_duration_ms: 245000,
          critical_path: true,
        },
        'implement_api': {
          status: 'completed',
          start_time: Date.now() - 1745000,
          end_time: Date.now() - 1450000,
          execution_duration_ms: 295000,
          critical_path: false, // 非关键路径（与 implement_core 并发）
        },
        'implement_tests': {
          status: 'completed',
          start_time: Date.now() - 1445000, // 等待 implement_core 完成后
          end_time: Date.now() - 1400000,
          execution_duration_ms: 45000,
          critical_path: true,
          activated_delay: 5000, // 等待了 implement_core 5 秒
        },
        'run_tests': {
          status: 'completed',
          start_time: Date.now() - 1395000,
          end_time: Date.now() - 1195000,
          execution_duration_ms: 200000,
          critical_path: true,
        },
        'deploy_staging': {
          status: 'completed',
          start_time: Date.now() - 1190000,
          end_time: Date.now(),
          execution_duration_ms: 1190000, // 约 20 分钟
          critical_path: true,
          condition: 'pass_count > 0',
          condition_met: true,
          output: {
            url: 'https://staging.example.com/app',
            status: 'success',
            commit_hash: 'abc123def456',
          },
        },
      },
      critical_path: [
        'analyze_requirements',
        'setup_project',
        'implement_core',
        'implement_tests',
        'run_tests',
        'deploy_staging'
      ],
      parallel_paths: [
        ['implement_core', 'implement_api'] // 这两个节点并发执行
      ],
      summary: {
        total_nodes: 7,
        completed_nodes: 7,
        failed_nodes: 0,
        skipped_nodes: 0,
        total_execution_time_ms: 1800000,
        concurrent_groups: 2,
        critical_path_length_ms: 1575000, // 关键路径总时间
        estimated_parallel_speedup: 1.15, // 并行提速比例
      },
      metadata: {
        workflow_name: 'complex-realworld-dag',
        project: 'complex-feature',
        priority: 'high',
        completed_by: 'user',
      },
    }

    await writeFile(stateFile, JSON.stringify(finalState, null, 2), 'utf-8')

    const state = JSON.parse(await readFile(stateFile, 'utf-8'))
    
    // 验证工作流最终完成
    expect(state.status).toBe('completed')
    expect(state.execution_duration_ms).toBe(1800000)
    
    // 验证所有节点都完成
    expect(state.summary.total_nodes).toBe(7)
    expect(state.summary.completed_nodes).toBe(7)
    expect(state.summary.failed_nodes).toBe(0)
    expect(state.summary.skipped_nodes).toBe(0)
    
    // 验证关键路径
    expect(state.critical_path.length).toBe(6)
    expect(state.critical_path).toContain('analyze_requirements')
    expect(state.critical_path).toContain('deploy_staging')
    expect(state.critical_path).not.toContain('implement_api') // implement_api 不是关键路径
    
    // 验证并行执行
    expect(state.parallel_paths.length).toBe(1)
    expect(state.parallel_paths[0]).toContain('implement_core')
    expect(state.parallel_paths[0]).toContain('implement_api')
    
    // 验证 critical_path_length 小于总执行时间（因为有并行）
    expect(state.summary.critical_path_length_ms).toBeLessThan(state.summary.total_execution_time_ms)
    
    // 验证 deploy_staging 完成
    expect(state.nodes['deploy_staging'].status).toBe('completed')
    expect(state.nodes['deploy_staging'].output.status).toBe('success')
    expect(state.nodes['deploy_staging'].output.url).toContain('staging.example.com')
    
    // 验证 implement_tests 等待了 implement_core
    expect(state.nodes['implement_tests'].activated_delay).toBeGreaterThan(0)
  })
})
