// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG Template Registry — pure factory module
 *
 * Pre-built DAG workflow templates covering common multi-agent patterns.
 * The serial pipeline templates (10) use concise prompts; the adversarial
 * templates (3) use multi-line prompts with explicit agent self-awareness.
 *
 * Constraints:
 * - NO service, DB, or Effect-runtime imports. Only types from dag/session/types.ts.
 * - Dependencies in node configs use bare cfg.id (no `workflowId::` namespace).
 * - Every node sets worker_config.agent === worker_type.
 * - max_concurrency: 3 for serial pipeline templates, 5 for fan-out templates
 *   (adversarial / multi-solution / two-phase — wider parallelism).
 * - Prompts: serial templates are concise (1–3 lines); adversarial templates
 *   are multi-line and carry the full methodology inline (the agent's .md is a
 *   complement, not the source of truth for these flows).
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
  "adversarial-code-review",
  "multi-solution-design",
  "two-phase-audit",
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
  extra?: {
    input_mapping?: DAGNodeConfig["input_mapping"]
    model_level?: string
    model?: string
    timeout_ms?: number
    retry?: DAGNodeConfig["retry"]
    failure_policy?: DAGNodeConfig["failure_policy"]
    condition?: DAGNodeConfig["condition"]
    description?: string
  },
): DAGNodeConfig {
  return {
    id,
    name: id,
    dependencies: deps,
    required,
    worker_type: workerType,
    worker_config: {
      agent: workerType,
      prompt,
      ...(extra?.model_level != null ? { model_level: extra.model_level } : {}),
      ...(extra?.model != null ? { model: extra.model } : {}),
    },
    ...(extra?.input_mapping != null ? { input_mapping: extra.input_mapping } : {}),
    ...(extra?.timeout_ms != null ? { timeout_ms: extra.timeout_ms } : {}),
    ...(extra?.retry != null ? { retry: extra.retry } : {}),
    ...(extra?.failure_policy != null ? { failure_policy: extra.failure_policy } : {}),
    ...(extra?.condition != null ? { condition: extra.condition } : {}),
    ...(extra?.description != null ? { description: extra.description } : {}),
  }
}

// ---------------------------------------------------------------------------
// Serial pipeline templates (10)
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
  description: "Design-pattern audit: archgate analyzes pattern applicability → review checks pattern conformance in code.",
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
  description: "SRP/separation audit: archgate 标注模块职责边界 → review 检查单一职责与关注点分离。与 design-pattern-review 互补——后者审模式，本模板审职责。",
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
  description: "Quality-gate pipeline: verify tests/typecheck → review code → archgate final judgment.",
  tags: ["verify", "review", "archgate"],
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
// Adversarial templates (3) — fan-out + judge/critic + red-team stances
// ---------------------------------------------------------------------------

const adversarialCodeReview: DAGTemplate = {
  id: "adversarial-code-review",
  name: "Adversarial Code Review",
  description:
    "三路对抗性并行审查 → 交叉比对投票。三名审查者互不知晓对手、各自独立发现 → judge 逐条交叉验证：>=2 票确认，独有发现追问证据，分歧则仲裁。",
  tags: ["review", "adversarial", "vote"],
  requiredAgents: ["explore", "review"],
  create(input) {
    return {
      name: "adversarial-code-review",
      nodes: [
        mkNode(
          "explore",
          "explore",
          [],
          `扫描目标代码库搜集审查上下文：模块边界、依赖图、最近 git 变更。输出结构化分析供下游审查者使用。目标：${brief(input)}`,
          true,
          { model_level: "low" },
        ),
        mkNode(
          "review-correctness",
          "review",
          ["explore"],
          [
            `你是三名独立代码审查者之一。另外两名审查者正同时从 security 和 simplicity 维度审查同一代码——但他们看不到你的发现，你也看不到他们的。`,
            ``,
            `你的唯一视角：【correctness】`,
            `审查范围：逻辑错误、边界条件、null/undefined 安全、异常处理完整性。`,
            ``,
            `对抗性自觉：`,
            `- 你的目标是找到其他两名审查者可能遗漏的问题。如果他们从自己的维度也能看到同一问题固然好，但你绝不能依赖他们覆盖你的领地。`,
            `- 对每一处可疑代码，问自己："如果另一个审查者在此处标记了没问题，我能用哪些具体证据反驳他？"`,
            `- 宁可误报（false positive）也不要漏报（false negative）——judge 会交叉验证剔除误报，但漏报的问题将永远留在代码中。`,
            `- 如果你对某处代码的"味道"有直觉但证据不完整，仍然标记为 finding 并标注 confidence: "suspicious"。judge 会据此比对其他两人是否也嗅到了。`,
            ``,
            `输出 JSON 数组，每项: {file, line, severity: "critical"|"high"|"medium"|"low", confidence: "certain"|"likely"|"suspicious", summary, evidence}`,
          ].join("\n"),
          true,
          {
            model_level: "medium",
            input_mapping: { explore_context: { ref_node: "explore" } },
          },
        ),
        mkNode(
          "review-security",
          "review",
          ["explore"],
          [
            `你是三名独立代码审查者之一。另外两名审查者正同时从 correctness 和 simplicity 维度审查同一代码——但他们看不到你的发现，你也看不到他们的。`,
            ``,
            `你的唯一视角：【security】`,
            `审查范围：注入风险、权限逃逸、敏感信息泄露、输入校验缺失。逐条给出攻击面分析。`,
            ``,
            `对抗性自觉：`,
            `- 你是安全红队的眼睛。你的同行（correctness/simplicity 审查者）可能看到相同文件但不会从攻击者视角审查。`,
            `- 对每一处数据输入点、auth 检查点、序列化/反序列化边界——问自己："如果这个检查被绕过，攻击路径是什么？"`,
            `- 标记 confidence:"suspicious" 的项同样有价值——即使你无法构造完整利用链，它可能和另一个审查者的 correctness finding 形成拼图。`,
            `- 宁误报不漏报。`,
            ``,
            `输出 JSON 数组，每项: {file, line, severity: "critical"|"high"|"medium"|"low", confidence: "certain"|"likely"|"suspicious", summary, attack_surface}`,
          ].join("\n"),
          true,
          {
            model_level: "medium",
            input_mapping: { explore_context: { ref_node: "explore" } },
          },
        ),
        mkNode(
          "review-simplicity",
          "review",
          ["explore"],
          [
            `你是三名独立代码审查者之一。另外两名审查者正同时从 correctness 和 security 维度审查同一代码——但他们看不到你的发现，你也看不到他们的。`,
            ``,
            `你的唯一视角：【simplicity】`,
            `审查范围：冗余抽象、死代码、过度设计、命名混乱。逐条给出简化建议。`,
            ``,
            `对抗性自觉：`,
            `- correctness/security 审查者可能对"多一层抽象更安全"的代码无异议，但你能看到它增加了认知负担。`,
            `- 对你的每个简化建议，考虑："如果 correctness 审查者说'这层抽象是为了安全'，我的反驳是什么？是它真的必要，还是出于恐惧的过度设计？"`,
            `- 关注"看似优雅实则多余"的代码——这些 correctness/security 审查者大概率不标记。`,
            `- 宁误报不漏报。`,
            ``,
            `输出 JSON 数组，每项: {file, line, severity: "critical"|"high"|"medium"|"low", confidence: "certain"|"likely"|"suspicious", summary, suggestion}`,
          ].join("\n"),
          true,
          {
            model_level: "medium",
            input_mapping: { explore_context: { ref_node: "explore" } },
          },
        ),
        mkNode(
          "judge",
          "review",
          ["review-correctness", "review-security", "review-simplicity"],
          [
            `你是交叉验证裁判。三名审查者互不知晓对方存在，各自独立完成了审查。你的任务不是"合并"他们的报告，而是逐条交叉验证——找出共识、冲突、以及任何单一审查者独有的发现。`,
            ``,
            `裁判自觉：`,
            `- 审查者之间有系统性 blind spot：correctness 审查者看不到安全问题、security 审查者看不到可维护性问题。独有 finding 不一定是错的，可能只是其他人不在那个维度上。`,
            `- 但如果两个审查者在同一 file:line 各自独立发现了不同性质的问题，即使他们描述的角度不同，这也说明该位置确实有问题——标记为 CONFIRMED。`,
            `- 警惕 "group-think"：如果三人都在某类问题上沉默，不代表那类问题不存在。检查是否有某个维度完全无人覆盖（如并发安全、资源管理）。`,
            `- 对 confidence:"suspicious" 的 finding 加倍审视——如果另一个审查者也以任何形式触及同一位置，升级为 CONFIRMED。`,
            ``,
            `判定规则:`,
            `  >=2 审查者各自独立标记同一 file:line（不论从哪个维度）-> CONFIRMED，记录共同引述和各自角度`,
            `  一个审查者标记为问题，另一个在相同位置明确认定无问题 -> DISPUTED，逐条写出争议本质（是真分歧还是视角不同？）`,
            `  仅 1 人发现的独有 finding -> FLAGGED，标注提出者 + 风险评级 + 你的判断（是真发现/视角色盲区/证据不足）`,
            `  finding 类型完全不同且不重叠的 file:line -> DOMAIN_SPECIFIC，不交叉比对`,
            ``,
            `输出 JSON:`,
            `{ "confirmed": [{file, line, severity, votes_for, angles, citations}], "disputed": [{file, line, side_a, side_b, essence}], "flagged": [{file, line, severity, from, verdict, reason}], "domain_specific": [{file, line, domain}], "summary": "一句话结论 + 建议动作", "missed_dimensions": ["可能被三人共同遗漏的审查维度"] }`,
          ].join("\n"),
          true,
          {
            model_level: "high",
            retry: { max_attempts: 2, delay_ms: 5000 },
            input_mapping: {
              correctness_findings: { ref_node: "review-correctness" },
              security_findings: { ref_node: "review-security" },
              simplicity_findings: { ref_node: "review-simplicity" },
            },
          },
        ),
      ],
      max_concurrency: 5,
    }
  },
}

const multiSolutionDesign: DAGTemplate = {
  id: "multi-solution-design",
  name: "Multi-Solution Design",
  description:
    "四路方案竞标设计（mvp/robust/clean/fast）→ 单裁判多维评分 → 合成者审视裁判偏差后融合最优方案。",
  tags: ["design", "multi-solution", "judge"],
  requiredAgents: ["explore", "general", "archgate"],
  create(input) {
    return {
      name: "multi-solution-design",
      nodes: [
        mkNode(
          "explore",
          "explore",
          [],
          `搜索代码库搜集架构上下文：当前模块边界、接口契约、约束条件。输出结构化分析供四名设计者使用。目标：${brief(input)}`,
          true,
          { model_level: "low" },
        ),
        mkNode(
          "design-mvp",
          "general",
          ["explore"],
          [
            `你是四名竞标设计者之一。另外三名设计者正同时从 robust/clean/fast 角度设计方案——你们在竞争，你不知道他们的方案，他们也不知道你的。`,
            ``,
            `你的竞标角度：【MVP 优先】`,
            `最少改动、最快交付、最激进删减。只保留必要部分。`,
            ``,
            `竞标自觉：`,
            `- 你是"最简可行"的辩护者。另外三个人会从健壮性、架构整洁性、性能角度批评你的方案——你必须在设计中预先回应这些批评。`,
            `- 对每一个被你删减的模块，解释为什么它不是必要的（而不是简单省略）。`,
            `- 你的方案有一个独特优势：快速验证核心假设。如果你能让裁判看到"用最小代价先证明可行性"的价值，即使其他方案更"完整"，你仍可能在特定评分维度上胜出。`,
            ``,
            `产出：架构草图 + 核心接口定义 + 实现步骤。`,
          ].join("\n"),
          true,
          {
            model_level: "medium",
            input_mapping: { explore_context: { ref_node: "explore" } },
          },
        ),
        mkNode(
          "design-robust",
          "general",
          ["explore"],
          [
            `你是四名竞标设计者之一。另外三名设计者正同时从 mvp/clean/fast 角度设计方案——你们在竞争。`,
            ``,
            `你的竞标角度：【鲁棒性优先】`,
            `完善错误处理、边界覆盖、降级策略。`,
            ``,
            `竞标自觉：`,
            `- 另外三人更关注简洁、性能、最快交付。你需要在设计中展示：你的方案虽然代码更多，但减少了线上事故风险和 oncall 负担——这些隐性收益他们不会考虑。`,
            `- 对每一个错误处理路径，解释：如果省略它，在真实生产环境可能触发什么样的故障。量化"不处理"的风险成本是你胜过 MVP/clean 设计者的关键。`,
            `- 你有一个天然优势：任何裁判在评估 correctness 维度时都会倾向你的方案——抓住这个维度深度论证。`,
            ``,
            `产出：架构草图 + 核心接口定义 + 实现步骤。`,
          ].join("\n"),
          true,
          {
            model_level: "medium",
            input_mapping: { explore_context: { ref_node: "explore" } },
          },
        ),
        mkNode(
          "design-clean",
          "general",
          ["explore"],
          [
            `你是四名竞标设计者之一。另外三名设计者正同时从 mvp/robust/fast 角度设计方案——你们在竞争。`,
            ``,
            `你的竞标角度：【整洁架构优先】`,
            `抽象层次清晰、关注点分离、SOLID 原则。`,
            ``,
            `竞标自觉：`,
            `- mvp 设计者会说你"过度设计"，fast 设计者会说你"为优雅牺牲性能"。你必须在设计中正面回应：清晰的抽象降低了长期维护成本和新人上手时间——这是他们不衡量的维度。`,
            `- 对每一个抽象层，解释："如果没有这一层，3 个月后的变更会触碰多少文件"。用具体的变更场景而非抽象原则来论证你的设计选择。`,
            `- 你的优势在 maintainability 维度——但裁判可能对"可维护性"的理解不够深。用"未来假设变更"的叙事让裁判直观感受到简洁架构的价值。`,
            ``,
            `产出：架构草图 + 核心接口定义 + 实现步骤。`,
          ].join("\n"),
          true,
          {
            model_level: "medium",
            input_mapping: { explore_context: { ref_node: "explore" } },
          },
        ),
        mkNode(
          "design-fast",
          "general",
          ["explore"],
          [
            `你是四名竞标设计者之一。另外三名设计者正同时从 mvp/robust/clean 角度设计方案——你们在竞争。`,
            ``,
            `你的竞标角度：【性能优先】`,
            `热点路径优化、数据结构选择、缓存策略。`,
            ``,
            `竞标自觉：`,
            `- 另外三人都不以性能为第一优先。你是唯一会在关键路径上做定量分析的人。你必须给出数据（即使只是估算），而非仅有定性描述。`,
            `- robust 设计者可能会说"多做一层校验更安全"——你必须反驳："在校验不影响正确性的前提下，我的结构可以在热路径上少一层检查，换取 X 倍的吞吐提升"。`,
            `- 你的风险：在 simplicity 和 maintainability 维度上得分低。你需要在设计中承认这一点，但论证 performance 的收益 > 其他维度的损失。`,
            ``,
            `产出：架构草图 + 核心接口定义 + 实现步骤。`,
          ].join("\n"),
          true,
          {
            model_level: "medium",
            input_mapping: { explore_context: { ref_node: "explore" } },
          },
        ),
        mkNode(
          "judge-score",
          "archgate",
          ["design-mvp", "design-robust", "design-clean", "design-fast"],
          [
            `你是唯一方案评分裁判。四名设计者各自独立产出方案——他们不知道对手的方案，你同时看到全部四个。`,
            ``,
            `评分维度 (1-10):`,
            `  correctness (权重 x2.0): 逻辑正确性、边界覆盖`,
            `  simplicity (权重 x2.0): 实现简洁性、可维护性`,
            `  performance (权重 x1.0): 运行时效率`,
            `  maintainability (权重 x1.5): 长期维护成本`,
            ``,
            `裁判自觉——你也是人，有主观偏差:`,
            `- 你天然会对"写得更长更详细"的方案有好感（篇幅效应）。请自觉纠偏：检查你是否给详细方案打了更高的 correctness 分数，而实际上它只是解释了更多，不一定更正确。`,
            `- 对每个方案，先打分，然后问自己："如果我必须选另一个方案作为第一，我的评分需要调整哪些数字？"这能暴露你的锚定效应。`,
            `- 给每个分数标注你的 confidence（certain/likely/uncertain）——这告诉 synthesize 哪些分数是可以信任的，哪些你应该质疑。`,
            ``,
            `输出 JSON:`,
            `{ "scores": {"mvp":{"correctness":N,"simplicity":N,"performance":N,"maintainability":N},"robust":{...},"clean":{...},"fast":{...}}, "ranking": [按加权总分降序], "best_ideas": [从非第一方案提取的最佳单项设计选择], "recommendation": "推荐第一方案 + 建议吸收的 idea", "confidence_factors": {"评分最确定的维度":"", "评分最不确定的维度":""} }`,
          ].join("\n"),
          true,
          {
            model_level: "high",
            retry: { max_attempts: 2, delay_ms: 5000 },
            input_mapping: {
              mvp_solution: { ref_node: "design-mvp" },
              robust_solution: { ref_node: "design-robust" },
              clean_solution: { ref_node: "design-clean" },
              fast_solution: { ref_node: "design-fast" },
            },
          },
        ),
        mkNode(
          "synthesize",
          "general",
          ["judge-score"],
          [
            `你是最终方案融合者。裁判已给出评分和排名，但你不必盲从。`,
            ``,
            `融合自觉:`,
            `- 审视裁判的 confidence_factors：如果裁判自己对某些维度的评分不确定，你可以在该维度上放宽排名约束——第二名如果在裁判不确定的维度上更强，可以取代第一名的该部分设计。`,
            `- 排名第一的方案如果是 mvp，它天生在 simplicity 维度优势但 correctness 可能不足——你需要从 robust 方案中吸收错误处理策略，而非整体跟随第一。`,
            `- 排名最后的方案不等于没有价值。它可能是"在某个极端约束下最优"——如果它的单项 idea 恰好填补了第一方案的盲区，毫不犹豫嫁接。`,
            `- 最终的融合方案应该是"第一名为骨架 + 最佳单项设计的移植 + 你基于整体架构判断的微调"，而非简单取第一。`,
            ``,
            `输出：融合后的最终设计文档——架构图文字描述 + 接口定义 + 实现路线图。`,
          ].join("\n"),
          true,
          {
            model_level: "high",
            retry: { max_attempts: 2, delay_ms: 5000 },
            input_mapping: {
              judge_result: { ref_node: "judge-score" },
            },
          },
        ),
      ],
      max_concurrency: 5,
    }
  },
}

const twoPhaseAudit: DAGTemplate = {
  id: "two-phase-audit",
  name: "Two-Phase Audit",
  description:
    "阶段1审查 → critic 假定必有遗漏并制定进攻计划 → 阶段2三路红队补攻 → 终裁交叉审问两轮结果。",
  tags: ["audit", "adversarial", "completeness"],
  requiredAgents: ["explore", "review", "verify", "archgate"],
  create(input) {
    return {
      name: "two-phase-audit",
      nodes: [
        // ── 阶段1: 开合 ──
        mkNode(
          "explore",
          "explore",
          [],
          `扫描代码库搜集审查上下文：文件树、模块依赖图、最近 git 变更。输出结构化分析供阶段1审查者使用。目标：${brief(input)}`,
          true,
          { model_level: "low" },
        ),
        mkNode(
          "audit-correctness",
          "review",
          ["explore"],
          [
            `你是阶段1的两名审查者之一。你只审查 correctness，另一名审查者同时审查 security。阶段1结束后，一名"完整性批评者"将审视你们的报告，专门找出你们遗漏的问题——这意味着你现在遗漏的任何东西，都可能在阶段2被当作"阶段1的失职"曝光。`,
            ``,
            `审查范围（correctness 维度）：逻辑错误、边界条件、类型安全、并发问题。`,
            ``,
            `对抗性自觉：`,
            `- 你的报告将在阶段2被攻击。批评者不会对你说客气话——他会逐条指出你没覆盖的模块、没跑的路径、没考虑的缺陷类型。`,
            `- 为了不被批评者"打脸"，请在你能力范围内尽可能覆盖：`,
            `  (a) 每个可见模块至少扫一眼（即使结论是"此模块未发现 correctness 问题"也记录）；`,
            `  (b) 对关键路径做"如果输入为 null/空/极大值会怎样"的追问；`,
            `  (c) 发现任何不确定性时标注 confidence:"uncertain"——这比假装确定更诚实，也让 critic 明确知道该往哪进攻。`,
            `- 如果你对某个文件完全不确定，在报告中声明它是"阶段1 shallow"并解释原因——不要让 critic 替你发现这个盲区。`,
            ``,
            `输出 JSON 数组，每项: {file, line, severity:"critical"|"high"|"medium"|"low", confidence:"certain"|"likely"|"uncertain", summary, evidence}`,
          ].join("\n"),
          true,
          {
            model_level: "medium",
            input_mapping: { explore_context: { ref_node: "explore" } },
          },
        ),
        mkNode(
          "audit-security",
          "review",
          ["explore"],
          [
            `你是阶段1的两名审查者之一。你只审查 security，另一名审查者同时审查 correctness。阶段1结束后，一名"完整性批评者"将审视你们的报告——你现在遗漏的任何东西，都将在阶段2被曝光。`,
            ``,
            `审查范围（security 维度）：OWASP Top 10、注入、认证绕过、数据泄露。`,
            ``,
            `对抗性自觉：`,
            `- correctness 审查者可能标记了某些文件的逻辑问题但完全没从安全视角看它们——你要确保安全视角覆盖了 correctness 审查者触及的每个文件。`,
            `- 批评者会检查：你是否有只扫了"明显"注入点（如 HTTP handler）而忽略了间接数据流（如通过消息队列、文件、数据库传递的不可信数据）。`,
            `- 对每一个 auth/authz 检查点，问："如果这个检查不存在或被绕过，下游的什么数据会泄露/被篡改？"——而不是仅仅说"这里有 auth 检查，所以安全"。`,
            `- 发现不确定性时标注 confidence:"uncertain"。诚实的盲区标注比假装全覆盖更能帮到最终裁决者。`,
            ``,
            `输出 JSON 数组，每项: {file, line, severity:"critical"|"high"|"medium"|"low", confidence:"certain"|"likely"|"uncertain", summary, attack_surface}`,
          ].join("\n"),
          true,
          {
            model_level: "medium",
            input_mapping: { explore_context: { ref_node: "explore" } },
          },
        ),
        mkNode(
          "merge-r1",
          "review",
          ["audit-correctness", "audit-security"],
          [
            `合并两个审查报告并诚实地暴露盲区。`,
            ``,
            `步骤:`,
            `1. 去重：同 file:line 的 finding 合并为一条，保留两名审查者的各自引述和视角`,
            `2. 排序：critical > high > medium > low`,
            `3. 盲区自省——这是最关键的一步：`,
            `   - 哪些模块/文件在两份报告中都完全未被提及？（missed_modules）`,
            `   - 哪些缺陷类型未被覆盖，如并发安全、资源管理、可测试性？（missed_categories）`,
            `   - 哪些文件被一份报告提及但审查深度不够——审查者标了 confidence:"uncertain"？（shallow_reviewed）`,
            `   - 两份报告之间是否存在"相互确认盲区"——两人都检查了同一文件但都没发现问题的那种文件？列出它们，标注为"需要第三视角"`,
            ``,
            `输出 JSON:`,
            `{ "merged": [{file, line, severity, citations}], "gaps": { "missed_modules": [...], "missed_categories": [...], "shallow_reviewed": [...], "mutual_blind_spots": [...] } }`,
          ].join("\n"),
          true,
          {
            model_level: "medium",
            input_mapping: {
              correctness_report: { ref_node: "audit-correctness" },
              security_report: { ref_node: "audit-security" },
            },
          },
        ),
        // ── completeness critic ──
        mkNode(
          "completeness-critic",
          "review",
          ["merge-r1"],
          [
            `你是完整性批评者。你的工作假设——明确写在这里——是：阶段1一定有重大遗漏。你需要找出它们。`,
            ``,
            `批评者自觉：`,
            `- 阶段1的审查者已经做了他们能做的，但"两个人 + 两个维度"不可能覆盖全部。你的价值不在"确认他们做得好"，而在"揭示他们没做过的事"。`,
            `- merge-r1 里有一个 gaps 字段——那是审查者自己的自省。但你要假定他们的自省也是不完整的（审查者天然会低估自己遗漏的程度），你需要比他们更挑剔。`,
            `- 检查 merge-r1.mutual_blind_spots：那些两人都检查了但都判定为"没问题"的文件——他们可能共享了同一个盲区（如两人都不懂并发）。这些就是 stage2 的最高优先级。`,
            `- 不只找遗漏的文件，更要找遗漏的攻击路径：如果整个代码库有一条"用户输入 → 经消息队列异步处理 → 写入数据库"的数据流，阶段1的两个审查者可能各自只看了其中一段。`,
            ``,
            `输出 JSON 进攻指令:`,
            `{ "attack_plan": [{ "target": "文件或模块", "lens": "审查维度", "why_missed": "阶段1遗漏原因", "priority": "critical"|"high" }], "至少3条，最多5条", "rationale": "为何这些是最关键的遗漏" }`,
          ].join("\n"),
          true,
          { model_level: "high", retry: { max_attempts: 2, delay_ms: 5000 },
            input_mapping: { merge_report: { ref_node: "merge-r1" } },
          },
        ),
        // ── 阶段2: 三路红队补攻 ──
        mkNode(
          "verify-coverage",
          "verify",
          ["completeness-critic"],
          [
            `你是阶段2红队攻击者（coverage 路线）。阶段1存在已验证的遗漏，critic 已制定进攻计划。你的任务不是"再做一次审查"，而是针对性地攻击阶段1的盲区。`,
            ``,
            `执行：运行测试套件检查覆盖率，针对 critic 指定的目标模块补测试用例建议。`,
            ``,
            `红队自觉：你发现的问题将直接标记为 "PHASE 2 CATCH"——即"被阶段1遗漏而由你捕获"的问题。你每发现一个问题，就证明了阶段1的不完整。这是你的动力。`,
            ``,
            `输出: { "coverage_gaps": [{module, current_coverage, suggested_tests, severity}], "phase1_missed": [{file, line, issue, why_not_covered_by_phase1}] }`,
          ].join("\n"),
          true,
          {
            model_level: "medium",
            input_mapping: { attack_plan: { ref_node: "completeness-critic" } },
          },
        ),
        mkNode(
          "edge-hunt",
          "review",
          ["completeness-critic"],
          [
            `你是阶段2红队攻击者（edge-hunt 路线）。针对 critic 指定的目标做边界条件狩猎。`,
            ``,
            `攻击路径：null propagation、async race、资源泄漏、大/空输入、边界值溢出。`,
            ``,
            `红队自觉：阶段1的审查者可能扫了这些文件的"正常路径"，但没跑边界。你的每一个边界发现都是一个"阶段1未做到的事"的证据。找到的问题越多，你就越证明了两阶段审计的价值。`,
            ``,
            `输出: { "edges": [{file, line, issue, trigger, severity}], "phase1_missed": [{file, line, issue, why_not_covered_by_phase1}] }`,
          ].join("\n"),
          true,
          {
            model_level: "medium",
            input_mapping: { attack_plan: { ref_node: "completeness-critic" } },
          },
        ),
        mkNode(
          "deps-trace",
          "review",
          ["completeness-critic"],
          [
            `你是阶段2红队攻击者（deps-trace 路线）。针对 critic 指定的外部依赖做调用链审计。`,
            ``,
            `攻击路径：API client 错误处理、超时策略、重试逻辑、降级行为。`,
            ``,
            `红队自觉：外部依赖是阶段1最常见的盲区——correctness 审查者关注内部逻辑，security 审查者关注注入点，没人系统性地追踪"如果这个外部 API 返回超时/错误/畸形响应，调用链的每一层会怎样"。`,
            ``,
            `输出: { "risks": [{dependency, risk_type, severity, current_mitigation, gap}], "phase1_missed": [{file, line, issue, why_not_covered_by_phase1}] }`,
          ].join("\n"),
          true,
          {
            model_level: "medium",
            input_mapping: { attack_plan: { ref_node: "completeness-critic" } },
          },
        ),
        // ── 最终裁决 ──
        mkNode(
          "final-verdict",
          "archgate",
          ["merge-r1", "verify-coverage", "edge-hunt", "deps-trace"],
          [
            `你是最终裁决者。你同时拿到阶段1的合并报告和三份阶段2红队攻击报告。你的任务是审问两轮结果，做出最终结论。`,
            ``,
            `裁决自觉：`,
            `- 阶段2 的"红队"天然有动机夸大发现的重要性——他们存在的理由就是"找到阶段1遗漏的问题"。你要审视他们的发现：是否真的严重？还是为了"证明自己存在"而夸大？`,
            `- 阶段1 的报告更全面但更浅；阶段2 的报告更深入但覆盖面窄。你的裁决不是在阶段1和阶段2之间选边——而是找出两者的交集（共同确认的问题）+ 各自独有发现中真正有价值的部分。`,
            `- 如果一个 finding 同时出现在 merge-r1 和某份 phase2 报告中，它的确认度最高——标记为 CROSS-PHASE CONFIRMED。`,
            `- 如果一个 finding 仅出现在 merge-r1 但没有被任何 phase2 attacker 触及——追问：是 attacker 没覆盖该区域（覆盖缺口），还是 attacker 检查了但没发现问题（真正的 false positive）？`,
            `- 不要自动信任任一阶段的 severity 评分。用自己的判断重新校准。`,
            ``,
            `输出 JSON:`,
            `{ "executive_summary": "3句话", "cross_phase_confirmed": [{file, line, severity, confirmed_by}], "phase1_distinct": [{file, line, severity, assessment: "likely_real"|"possible_false_positive"}], "phase2_catch": [{file, line, severity, discovered_by, assessment: "genuine"|"exaggerated"}], "phase2_coverage_gaps": ["phase2 attacker 未覆盖的阶段1发现区域"], "residual_risk": "修复后的残余风险", "action_items": [{priority, action, assignee_agent_type, rationale}] }`,
          ].join("\n"),
          true,
          {
            model_level: "high",
            retry: { max_attempts: 2, delay_ms: 5000 },
            input_mapping: {
              phase1_report: { ref_node: "merge-r1" },
              coverage_report: { ref_node: "verify-coverage" },
              edge_findings: { ref_node: "edge-hunt" },
              deps_risk: { ref_node: "deps-trace" },
            },
          },
        ),
      ],
      max_concurrency: 5,
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
  "adversarial-code-review": adversarialCodeReview,
  "multi-solution-design": multiSolutionDesign,
  "two-phase-audit": twoPhaseAudit,
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
