// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

import { describe, it, expect } from "bun:test"
import {
  DAG_TEMPLATE_IDS,
  listDAGTemplates,
  getDAGTemplate,
  instantiateDAGTemplate,
  type DAGTemplate,
  type DAGTemplateInput,
} from "../index"
import type { DAGConfig } from "../../../session/types"
import { RequiredNodesValidator } from "../../../session/required-nodes-validator"
import {
  applyReplanPatchToConfig,
  buildReplanDbInputs,
  classifyReplanNodes,
  validateFrozenAndExistence,
  validateReplanPreconditions,
} from "../../../session/execution-core"
import type { DAGNodeSession, DAGNodeStatus } from "../../../session/types"

const ALLOWED_AGENTS = [
  "archgate",
  "explore",
  "implement",
  "patcher",
  "review",
  "verify",
  "general",
  "main",
]

const EXPECTED_IDS = [
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

const DEFAULT_INPUT: DAGTemplateInput = {
  goal: "test goal",
  scope: "test scope",
  context: "test context",
}

function instantiateAll(input: DAGTemplateInput = DEFAULT_INPUT): { t: DAGTemplate; cfg: DAGConfig }[] {
  return listDAGTemplates().map((t) => {
    const cfg = t.create(input)
    if ("error" in cfg) throw new Error(`template ${t.id} instantiation failed: ${cfg.error}`)
    return { t, cfg: cfg as DAGConfig }
  })
}

// Helper — topological cycle check (full graph, not just required nodes)
function hasCycle(nodes: { id: string; dependencies: string[] }[]): boolean {
  const ids = new Set(nodes.map((n) => n.id))
  const graph = new Map(nodes.map((n) => [n.id, n.dependencies.filter((d) => ids.has(d))]))
  const visited = new Set<string>()
  const inStack = new Set<string>()
  const dfs = (id: string): boolean => {
    if (inStack.has(id)) return true
    if (visited.has(id)) return false
    visited.add(id)
    inStack.add(id)
    for (const dep of graph.get(id) ?? []) {
      if (dfs(dep)) return true
    }
    inStack.delete(id)
    return false
  }
  for (const id of graph.keys()) {
    if (dfs(id)) return true
  }
  return false
}

describe("DAG Template Registry", () => {
  describe("template catalogue", () => {
    it(`exposes exactly ${EXPECTED_IDS.length} template ids`, () => {
      expect(DAG_TEMPLATE_IDS.length).toBe(EXPECTED_IDS.length)
    })

    it("template ids match the expected set", () => {
      expect([...DAG_TEMPLATE_IDS].sort()).toEqual([...EXPECTED_IDS].sort())
    })

    it(`listDAGTemplates returns ${EXPECTED_IDS.length} templates`, () => {
      expect(listDAGTemplates()).toHaveLength(EXPECTED_IDS.length)
    })

    it("getDAGTemplate returns undefined for unknown ids", () => {
      expect(getDAGTemplate("nope")).toBeUndefined()
    })

    it("instantiateDAGTemplate returns error for unknown ids", () => {
      const r = instantiateDAGTemplate("nope", DEFAULT_INPUT)
      expect("error" in r).toBe(true)
    })

    it("every template has a non-empty description and tags", () => {
      for (const t of listDAGTemplates()) {
        expect(t.description.length).toBeGreaterThan(0)
        expect(t.tags.length).toBeGreaterThan(0)
      }
    })
  })

  describe("structural invariants (per template, default input)", () => {
    const cases = instantiateAll()

    it("every template produces at least one node", () => {
      for (const { t, cfg } of cases) {
        expect(cfg.nodes.length, `template ${t.id}`).toBeGreaterThan(0)
      }
    })

    it("node ids are unique within a template", () => {
      for (const { t, cfg } of cases) {
        const ids = cfg.nodes.map((n) => n.id)
        expect(new Set(ids).size, `template ${t.id}`).toBe(ids.length)
      }
    })

    it("node ids contain no :: namespace", () => {
      for (const { t, cfg } of cases) {
        for (const n of cfg.nodes) {
          expect(n.id, `template ${t.id} node ${n.id}`).not.toContain("::")
        }
      }
    })

    it("all dependency ids reference existing node ids", () => {
      for (const { t, cfg } of cases) {
        const ids = new Set(cfg.nodes.map((n) => n.id))
        for (const n of cfg.nodes) {
          for (const d of n.dependencies) {
            expect(ids.has(d), `template ${t.id} node ${n.id} dep ${d}`).toBe(true)
          }
        }
      }
    })

    it("full dependency graph is acyclic", () => {
      for (const { t, cfg } of cases) {
        expect(hasCycle(cfg.nodes), `template ${t.id}`).toBe(false)
      }
    })

    it("node count is at most 20", () => {
      for (const { t, cfg } of cases) {
        expect(cfg.nodes.length, `template ${t.id}`).toBeLessThanOrEqual(20)
      }
    })

    it("max_concurrency is in range [1, 10]", () => {
      for (const { t, cfg } of cases) {
        expect(cfg.max_concurrency, `template ${t.id}`).toBeGreaterThanOrEqual(1)
        expect(cfg.max_concurrency, `template ${t.id}`).toBeLessThanOrEqual(10)
      }
    })

    it("every node worker_type is in the template's requiredAgents list", () => {
      for (const { t, cfg } of cases) {
        const allowed = new Set(t.requiredAgents)
        for (const n of cfg.nodes) {
          expect(allowed.has(n.worker_type), `template ${t.id} node ${n.id}`).toBe(true)
        }
      }
    })

    it("every node worker_type is in the global allowed list", () => {
      const allowed = new Set(ALLOWED_AGENTS)
      for (const { t, cfg } of cases) {
        for (const n of cfg.nodes) {
          expect(allowed.has(n.worker_type), `template ${t.id} node ${n.id} worker_type=${n.worker_type}`).toBe(true)
        }
      }
    })

    it("worker_config.agent === worker_type on every node", () => {
      for (const { t, cfg } of cases) {
        for (const n of cfg.nodes) {
          expect(
            n.worker_config.agent,
            `template ${t.id} node ${n.id} worker_config.agent`,
          ).toBe(n.worker_type)
        }
      }
    })

    it("RequiredNodesValidator.validate(config).valid === true", () => {
      const validator = new RequiredNodesValidator()
      for (const { t, cfg } of cases) {
        const result = validator.validate(cfg)
        expect(result.valid, `template ${t.id}: ${result.errors.join("; ")}`).toBe(true)
      }
    })

    it("RequiredNodesValidator produces no hard errors", () => {
      const validator = new RequiredNodesValidator()
      for (const { t, cfg } of cases) {
        const result = validator.validate(cfg)
        expect(result.errors.length, `template ${t.id}`).toBe(0)
      }
    })

    it("every input_mapping.ref_node is in that node's dependencies", () => {
      // Regression guard: a node whose prompt consumes an upstream output via
      // input_mapping MUST declare that upstream in `dependencies`. Otherwise
      // collectInputMapping() silently marks the entry `__missing: 'beyond_deps'`
      // and the node receives no data (it reads an empty block, the defect that
      // hid in two-phase-audit's completeness-critic until manual review).
      for (const { t, cfg } of cases) {
        for (const n of cfg.nodes) {
          if (!n.input_mapping) continue
          const deps = new Set(n.dependencies)
          for (const [inputKey, entry] of Object.entries(n.input_mapping)) {
            expect(
              deps.has(entry.ref_node),
              `template ${t.id} node ${n.id} input_mapping.${inputKey}.ref_node='${entry.ref_node}' must be in dependencies [${[...deps].join(", ")}]`,
            ).toBe(true)
          }
        }
      }
    })

    it("every input_mapping.ref_node references an existing node id", () => {
      // A ref_node pointing to an id that exists nowhere in the workflow is a
      // dangling reference — even if declared in dependencies (which the test
      // above checks), the referenced id itself must resolve to a real node.
      for (const { t, cfg } of cases) {
        const ids = new Set(cfg.nodes.map((n) => n.id))
        for (const n of cfg.nodes) {
          if (!n.input_mapping) continue
          for (const [inputKey, entry] of Object.entries(n.input_mapping)) {
            expect(
              ids.has(entry.ref_node),
              `template ${t.id} node ${n.id} input_mapping.${inputKey}.ref_node='${entry.ref_node}' does not exist in workflow`,
            ).toBe(true)
          }
        }
      }
    })
  })

  describe("instantiateDAGTemplate", () => {
    it("returns a DAGConfig for every known id", () => {
      for (const id of DAG_TEMPLATE_IDS) {
        const r = instantiateDAGTemplate(id, DEFAULT_INPUT)
        expect("error" in r, `id ${id}`).toBe(false)
      }
    })

    it("propagates goal text into node prompts", () => {
      for (const id of DAG_TEMPLATE_IDS) {
        const r = instantiateDAGTemplate(id, { goal: "needle-xyz" })
        if ("error" in r) continue
        const prompts = r.nodes.map((n) => String(n.worker_config.prompt ?? ""))
        expect(prompts.some((p) => p.includes("needle-xyz")), `template ${id}`).toBe(true)
      }
    })
  })

  describe("B1 fix: mkNode transparently passes worker_type (no silent downgrade)", () => {
    // 历史 bug：mkNode 曾把非 general/explore 的 worker_type 降级为 general，
    // 导致模板的 archgate/implement/verify/review/patcher 流水线语义丢失。
    // 现在透传——requiredAgents 声明的 agent 必须真实出现在节点 worker_type 中。

    it("no template node is silently downgraded to general unless it declared general", () => {
      for (const id of DAG_TEMPLATE_IDS) {
        const templ = getDAGTemplate(id)
        if (!templ) continue
        const cfg = templ.create({ goal: "test" })
        for (const node of cfg.nodes) {
          // worker_type 必须出现在模板声明的 requiredAgents 里
          expect(
            templ.requiredAgents,
            `template ${id} node ${node.id} worker_type=${node.worker_type} not in requiredAgents ${JSON.stringify(templ.requiredAgents)}`,
          ).toContain(node.worker_type)
        }
      }
    })

    it("templates that declare specialized agents actually use them (not all general)", () => {
      // architecture-design 声明 archgate+implement，节点必须包含这两个
      const arch = getDAGTemplate("architecture-design")!
      const archCfg = arch.create({ goal: "test" })
      const archWorkerTypes = new Set(archCfg.nodes.map((n) => n.worker_type))
      expect(archWorkerTypes.has("archgate")).toBe(true)
      expect(archWorkerTypes.has("implement")).toBe(true)

      // tdd-implementation-and-coverage 声明 implement+verify
      const tdd = getDAGTemplate("tdd-implementation-and-coverage")!
      const tddCfg = tdd.create({ goal: "test" })
      const tddWorkerTypes = new Set(tddCfg.nodes.map((n) => n.worker_type))
      expect(tddWorkerTypes.has("implement")).toBe(true)
      expect(tddWorkerTypes.has("verify")).toBe(true)
    })

    it("product-doc-analysis preserves explore worker_type", () => {
      const templ = getDAGTemplate("product-doc-analysis")
      if (!templ) throw new Error("template not found")
      const cfg = templ.create({ goal: "test" })
      expect(cfg.nodes[0].worker_type).toBe("explore")
    })

    it("requiredAgents is non-empty and every declared agent is actually used by some node", () => {
      for (const templ of listDAGTemplates()) {
        expect(templ.requiredAgents.length, `template ${templ.id}`).toBeGreaterThan(0)
        const cfg = templ.create({ goal: "test" })
        const usedWorkerTypes = new Set(cfg.nodes.map((n) => n.worker_type))
        for (const declared of templ.requiredAgents) {
          expect(
            usedWorkerTypes.has(declared),
            `template ${templ.id} declared agent '${declared}' not used by any node`,
          ).toBe(true)
        }
      }
    })
  })

  describe("Product E2E Harness demo template", () => {
    it("appears in the template list and instantiates the dogfood topology", () => {
      expect(listDAGTemplates().some((t) => t.id === "product-e2e-harness")).toBe(true)
      const cfg = instantiateDAGTemplate("product-e2e-harness", DEFAULT_INPUT)

      expect("error" in cfg).toBe(false)
      if ("error" in cfg) throw new Error(cfg.error)
      expect(cfg.nodes.map((node) => node.id)).toEqual(["setup", "optional-gate", "blocked-leaf", "finalize"])
      expect(cfg.nodes.find((node) => node.id === "setup")?.dependencies).toEqual([])
      expect(cfg.nodes.find((node) => node.id === "optional-gate")?.dependencies).toEqual(["setup"])
      expect(cfg.nodes.find((node) => node.id === "blocked-leaf")?.dependencies).toEqual(["optional-gate"])
      expect(cfg.nodes.find((node) => node.id === "finalize")?.dependencies).toEqual(["setup"])
      expect(cfg.nodes.find((node) => node.id === "blocked-leaf")?.required).toBe(false)
    })

    it("supports preview/apply removal of the pending optional blocked leaf", () => {
      const cfg = instantiateDAGTemplate("product-e2e-harness", DEFAULT_INPUT)
      if ("error" in cfg) throw new Error(cfg.error)
      const workflowId = "wf-product-e2e"
      const nodes = cfg.nodes.map((node) => ({
        workflow_id: workflowId,
        node_id: `${workflowId}::${node.id}`,
        config: node,
        status: (node.id === "setup" ? "completed" : "pending") as DAGNodeStatus,
        output: null,
        retry_count: 0,
        max_retries: 0,
        timeout_ms: 300000,
        required_nodes: [],
        dependencies: node.dependencies.map((dep) => `${workflowId}::${dep}`),
        metadata: {},
        start_time: null,
        completed_at: null,
        end_time: null,
        duration_ms: null,
        parent_node: null,
        created_at: 1,
        updated_at: 1,
        logs: [],
      })) as DAGNodeSession[]
      const patch = {
        workflow_id: workflowId,
        remove_nodes: [`${workflowId}::blocked-leaf`],
        changed_by: "product-e2e-harness-test",
      }

      expect(validateReplanPreconditions({ status: "paused" }, patch)).toEqual({ ok: true })
      expect(validateFrozenAndExistence(patch, classifyReplanNodes(nodes).frozenIds, new Set(nodes.map((node) => node.node_id)))).toEqual({ ok: true })
      const preview = applyReplanPatchToConfig(workflowId, cfg.nodes, patch)
      expect(preview.ok).toBe(true)
      if (!preview.ok) throw new Error(preview.reason)
      expect(preview.newConfigNodes.map((node) => node.id)).toEqual(["setup", "optional-gate", "finalize"])

      const dbInputs = buildReplanDbInputs(workflowId, patch, preview.newConfigNodes, nodes, cfg.max_concurrency)
      expect(dbInputs.removeNodeIds).toEqual([`${workflowId}::blocked-leaf`])
      expect(dbInputs.newNodes).toEqual([])
      expect(dbInputs.updates).toEqual([])
    })
  })
})
