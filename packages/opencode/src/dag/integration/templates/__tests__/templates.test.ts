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
    it("exposes exactly 9 template ids", () => {
      expect(DAG_TEMPLATE_IDS.length).toBe(9)
    })

    it("template ids match the expected set", () => {
      expect([...DAG_TEMPLATE_IDS].sort()).toEqual([...EXPECTED_IDS].sort())
    })

    it("listDAGTemplates returns 9 templates", () => {
      expect(listDAGTemplates()).toHaveLength(9)
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
})
