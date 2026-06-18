// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG Template Registry — pure factory module
 *
 * 10 pre-built DAG workflow templates covering common multi-agent patterns.
 *
 * Constraints:
 * - NO service, DB, or Effect-runtime imports. Only types from dag/session/types.ts.
 * - Dependencies in node configs use bare cfg.id (no `workflowId::` namespace).
 * - Every node sets worker_config.agent === worker_type.
 * - max_concurrency default 3.
 * - Prompts are concise (1–3 lines) task directives; the agent's own .md
 *   carries the full spec.
 */

import type { DAGConfig, DAGNodeConfig } from "../../session/types"
import { MAX_WORKFLOW_NODES, RECOMMENDED_WORKFLOW_NODES } from "../../session/limits"

// ---------------------------------------------------------------------------
// Template identity
// ---------------------------------------------------------------------------

export const DAG_TEMPLATE_IDS = [
  "product-doc-analysis",
  "architecture-design",
  "interface-design",
  "tdd-implementation-and-coverage",
  "design-pattern-review",
  "responsibility-review",
  "patcher-assembly",
  "comprehensive-review",
  "integration-test",
  "product-e2e-harness",
] as const

export type DAGTemplateId = (typeof DAG_TEMPLATE_IDS)[number]

// ---------------------------------------------------------------------------
// Template input / shape
// ---------------------------------------------------------------------------

export interface DAGTemplateInput {
  goal: string
  scope?: string
  context?: string
  [key: string]: unknown
}

export interface DAGTemplate {
  id: DAGTemplateId
  name: string
  description: string
  tags: string[]
  requiredAgents: string[]
  create(input: DAGTemplateInput): DAGConfig
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function brief(input: DAGTemplateInput): string {
  const parts: string[] = [
    input.goal,
    `规划要求：按可验证的小任务拆分 DAG 节点；推荐不超过 ${RECOMMENDED_WORKFLOW_NODES} 个节点，硬上限 ${MAX_WORKFLOW_NODES} 个节点。`,
  ]
  if (input.scope) parts.push(`范围：${input.scope}`)
  if (input.context) parts.push(`上下文：${input.context}`)
  return parts.join(" | ")
}

/**
 * B1 fix: 模板不再降级 worker_type。
 *
 * 历史 bug：mkNode 曾用 SAFE_BUILTIN_AGENTS 把非 general/explore 的
 * worker_type 强制降级为 general，导致 8/10 模板的 archgate/implement/
 * verify/review/patcher 流水线语义全部丢失（声称的流水线实际全是 general）。
 *
 * 现在透传 worker_type。启动期由 validateWorkerTypes (core-start.ts) 做
 * fail-fast 校验——若用户未注册对应 agent，dagworker start 会返回明确
 * 错误并列出已注册 agent 名，而非静默降级。
 *
 * SAFE_BUILTIN_AGENTS 仅保留给 product-e2e-harness 这类明确只用内置
 * agent 的 dogfood 模板做显式标注（不再用于降级），其他模板直接声明
 * 真实 agent。
 */
function mkNode(
  id: string,
  workerType: string,
  deps: string[],
  prompt: string,
  required = true,
): DAGNodeConfig {
  return {
    id,
    name: id,
    dependencies: deps,
    required,
    worker_type: workerType,
    worker_config: { agent: workerType, prompt },
  }
}

// ---------------------------------------------------------------------------
// 10 templates
// ---------------------------------------------------------------------------

const productDocAnalysis: DAGTemplate = {
  id: "product-doc-analysis",
  name: "Product Doc Analysis",
  description: "Explore codebase documentation and summarise findings (explore → general).",
  tags: ["docs", "analysis", "explore"],
  requiredAgents: ["explore", "general"],
  create(input) {
    return {
      name: "product-doc-analysis",
      nodes: [
        mkNode(
          "explore-doc",
          "explore",
          [],
          `用 explore 身份搜索与目标相关的文档与代码证据。目标：${brief(input)}`,
        ),
        mkNode(
          "summarize",
          "general",
          ["explore-doc"],
          `用 general 身份综合 explore 节点的发现，输出结构化分析结论。目标：${brief(input)}`,
        ),
      ],
      max_concurrency: 3,
    }
  },
}

const architectureDesign: DAGTemplate = {
  id: "architecture-design",
  name: "Architecture Design",
  description: "Architecture gate review followed by implementation (archgate → implement pipeline).",
  tags: ["arch", "design", "implement"],
  requiredAgents: ["archgate", "implement"],
  create(input) {
    return {
      name: "architecture-design",
      nodes: [
        mkNode(
          "archgate",
          "archgate",
          [],
          `用 archgate 身份审批准许的架构方向与约束。目标：${brief(input)}`,
        ),
        mkNode(
          "implement",
          "implement",
          ["archgate"],
          `用 implement 身份按 archgate 输出实现骨架。目标：${brief(input)}`,
        ),
      ],
      max_concurrency: 3,
    }
  },
}

const interfaceDesign: DAGTemplate = {
  id: "interface-design",
  name: "Interface Design",
  description: "Architecture gate, interface implementation, and verification (archgate → implement → verify pipeline).",
  tags: ["arch", "interfaces", "tdd"],
  requiredAgents: ["archgate", "implement", "verify"],
  create(input) {
    return {
      name: "interface-design",
      nodes: [
        mkNode(
          "archgate",
          "archgate",
          [],
          `用 archgate 身份确定接口边界与契约。目标：${brief(input)}`,
        ),
        mkNode(
          "implement",
          "implement",
          ["archgate"],
          `用 implement 身份产出接口定义与类型。目标：${brief(input)}`,
        ),
        mkNode(
          "verify",
          "verify",
          ["implement"],
          `用 verify 身份校验接口定义完整性与兼容性。目标：${brief(input)}`,
        ),
      ],
      max_concurrency: 3,
    }
  },
}

const tddImplementationAndCoverage: DAGTemplate = {
  id: "tdd-implementation-and-coverage",
  name: "TDD Implementation & Coverage",
  description: "Implement interfaces + tests, then implementation, then verify (implement → implement → verify pipeline).",
  tags: ["tdd", "implement", "verify"],
  requiredAgents: ["implement", "verify"],
  create(input) {
    return {
      name: "tdd-implementation-and-coverage",
      nodes: [
        mkNode(
          "interfaces-and-tests",
          "implement",
          [],
          `用 implement 身份按 TDD 顺序先写接口签名与单元测试。目标：${brief(input)}`,
        ),
        mkNode(
          "implementation",
          "implement",
          ["interfaces-and-tests"],
          `用 implement 身份填充实现逻辑使测试通过。目标：${brief(input)}`,
        ),
        mkNode(
          "verify",
          "verify",
          ["implementation"],
          `用 verify 身份跑测试与类型检查确认覆盖率。目标：${brief(input)}`,
        ),
      ],
      max_concurrency: 3,
    }
  },
}

const designPatternReview: DAGTemplate = {
  id: "design-pattern-review",
  name: "Design Pattern Review",
  description: "Architecture gate review followed by design-pattern review (archgate → review pipeline).",
  tags: ["arch", "review", "patterns"],
  requiredAgents: ["archgate", "review"],
  create(input) {
    return {
      name: "design-pattern-review",
      nodes: [
        mkNode(
          "archgate",
          "archgate",
          [],
          `用 archgate 身份标注设计模式适用性与约束。目标：${brief(input)}`,
        ),
        mkNode(
          "review",
          "review",
          ["archgate"],
          `用 review 身份按 design-patterns 维度审查代码。目标：${brief(input)}`,
        ),
      ],
      max_concurrency: 3,
    }
  },
}

const responsibilityReview: DAGTemplate = {
  id: "responsibility-review",
  name: "Responsibility Review",
  description: "Architecture gate review followed by responsibility/separation review (archgate → review pipeline).",
  tags: ["arch", "review", "srp"],
  requiredAgents: ["archgate", "review"],
  create(input) {
    return {
      name: "responsibility-review",
      nodes: [
        mkNode(
          "archgate",
          "archgate",
          [],
          `用 archgate 身份标注模块职责边界。目标：${brief(input)}`,
        ),
        mkNode(
          "review",
          "review",
          ["archgate"],
          `用 review 身份按 SRP/职责分离维度审查。目标：${brief(input)}`,
        ),
      ],
      max_concurrency: 3,
    }
  },
}

const patcherAssembly: DAGTemplate = {
  id: "patcher-assembly",
  name: "Patcher Assembly",
  description: "Single-node workflow producing a consolidated diff patch (patcher agent).",
  tags: ["patcher", "diff"],
  requiredAgents: ["patcher"],
  create(input) {
    return {
      name: "patcher-assembly",
      nodes: [
        mkNode(
          "patcher",
          "patcher",
          [],
          `用 patcher 身份把所有变更组装为一份 consolidated diff。目标：${brief(input)}`,
        ),
      ],
      max_concurrency: 3,
    }
  },
}

const comprehensiveReview: DAGTemplate = {
  id: "comprehensive-review",
  name: "Comprehensive Review",
  description: "Full-spectrum code review pipeline (verify → review → archgate).",
  tags: ["verify", "review", "arch"],
  requiredAgents: ["verify", "review", "archgate"],
  create(input) {
    return {
      name: "comprehensive-review",
      nodes: [
        mkNode(
          "verify",
          "verify",
          [],
          `用 verify 身份运行测试与类型检查收集运行时证据。目标：${brief(input)}`,
        ),
        mkNode(
          "review",
          "review",
          ["verify"],
          `用 review 身份基于 verify 证据做代码审查。目标：${brief(input)}`,
        ),
        mkNode(
          "archgate",
          "archgate",
          ["review"],
          `用 archgate 身份最终判定架构合规性。目标：${brief(input)}`,
        ),
      ],
      max_concurrency: 3,
    }
  },
}

const integrationTest: DAGTemplate = {
  id: "integration-test",
  name: "Integration Test",
  description: "Single-node workflow that runs integration tests (verify agent).",
  tags: ["verify", "tests", "integration"],
  requiredAgents: ["verify"],
  create(input) {
    return {
      name: "integration-test",
      nodes: [
        mkNode(
          "verify",
          "verify",
          [],
          `用 verify 身份运行集成测试套件。目标：${brief(input)}`,
        ),
      ],
      max_concurrency: 3,
    }
  },
}

const productE2EHarness: DAGTemplate = {
  id: "product-e2e-harness",
  name: "Product E2E Harness",
  description: "Dogfood demo for DAG product UI create/start, inspect, replan, and complete flow.",
  tags: ["product", "dogfood", "e2e"],
  requiredAgents: ["general", "explore"],
  create(input) {
    return {
      name: "product-e2e-harness",
      nodes: [
        mkNode(
          "setup",
          "explore",
          [],
          `用 explore 身份搜索目标相关的文档与代码证据。目标：${brief(input)}`,
        ),
        mkNode(
          "optional-gate",
          "general",
          ["setup"],
          `用 general 身份尝试执行可选分析步骤。此节点可能失败但不阻塞主线。目标：${brief(input)}`,
          false,
        ),
        mkNode(
          "blocked-leaf",
          "general",
          ["optional-gate"],
          `等待 optional-gate 完成后执行。如果 optional-gate 失败此节点将被 cascade-skip。目标：${brief(input)}`,
          false,
        ),
        mkNode(
          "finalize",
          "general",
          ["setup"],
          `用 general 身份综合 setup 的发现，输出最终结论。目标：${brief(input)}`,
        ),
      ],
      max_concurrency: 3,
    }
  },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry: Record<DAGTemplateId, DAGTemplate> = {
  "product-doc-analysis": productDocAnalysis,
  "architecture-design": architectureDesign,
  "interface-design": interfaceDesign,
  "tdd-implementation-and-coverage": tddImplementationAndCoverage,
  "design-pattern-review": designPatternReview,
  "responsibility-review": responsibilityReview,
  "patcher-assembly": patcherAssembly,
  "comprehensive-review": comprehensiveReview,
  "integration-test": integrationTest,
  "product-e2e-harness": productE2EHarness,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listDAGTemplates(): readonly DAGTemplate[] {
  return DAG_TEMPLATE_IDS.map((id) => registry[id])
}

export function getDAGTemplate(id: string): DAGTemplate | undefined {
  if (!(DAG_TEMPLATE_IDS as readonly string[]).includes(id)) return undefined
  return registry[id as DAGTemplateId]
}

export function instantiateDAGTemplate(
  id: string,
  input: DAGTemplateInput,
): DAGConfig | { error: string } {
  const templ = getDAGTemplate(id)
  if (!templ) return { error: `Unknown template id: ${id}. Available: ${DAG_TEMPLATE_IDS.join(", ")}` }
  return templ.create(input)
}
