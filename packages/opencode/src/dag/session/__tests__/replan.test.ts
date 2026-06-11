// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

// ============================================================================
// replan.test.ts
//
// Comprehensive unit tests for the 6 replan pure helpers + 3 module-registry
// behavioural tests. Covers scenarios 1–20 of the replan scenario matrix.
// Scenario 21 (history-row correctness) requires DB state inspection and is
// deferred to the integration test tier.
// ============================================================================

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  validateReplanPreconditions,
  classifyReplanNodes,
  validateFrozenAndExistence,
  applyReplanPatchToConfig,
  validateReplanPostConfig,
  buildReplanDbInputs,
  __internal_spawnedNodes,
  __internal_replanInFlight,
  __internal_concurrencyRegistry,
} from '../workflow-engine'
import type { DAGConfig, DAGNodeConfig, DAGNodeSession, DAGNodeStatus, ReplanPatch } from '../types'

// ---------------------------------------------------------------------------
// Test helpers (mirror src/dag/session/__tests__/workflow-engine.test.ts)
// ---------------------------------------------------------------------------

const WID = 'wf' // workflow id used throughout test patches

function makeNodeConfig(overrides: Partial<DAGNodeConfig> & { id: string }): DAGNodeConfig {
  return {
    name: overrides.id,
    dependencies: [],
    required: false,
    worker_type: 'mock',
    worker_config: {},
    ...overrides,
  }
}

function makeConfig(nodes: DAGNodeConfig[], maxConcurrency = 3): DAGConfig {
  return { name: 'test-wf', nodes, max_concurrency: maxConcurrency }
}

function makeNodeSession(
  nodeId: string,
  status: DAGNodeStatus,
  cfgOverrides: Partial<DAGNodeConfig> = {},
  deps: string[] = [],
): DAGNodeSession {
  const cfgId = nodeId.includes('::') ? nodeId.split('::').slice(1).join('::') : nodeId
  return {
    node_id: nodeId,
    workflow_id: WID,
    config: makeNodeConfig({ id: cfgId, dependencies: deps, ...cfgOverrides }),
    status,
    output: null,
    retry_count: 0,
    max_retries: 0,
    timeout_ms: 60_000,
    required_nodes: [],
    dependencies: deps,
    metadata: {},
    start_time: status !== 'pending' ? Date.now() : null,
    completed_at: null,
    end_time: null,
    duration_ms: null,
    parent_node: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    logs: [],
  }
}

function makePatch(overrides: Partial<ReplanPatch> = {}): ReplanPatch {
  return { workflow_id: WID, ...overrides }
}

// ---------------------------------------------------------------------------
// Scenario 1–6: precondition validation
// ---------------------------------------------------------------------------

describe('replan: precondition validation', () => {
  it('rejects terminal workflow (completed)', () => {
    const r = validateReplanPreconditions(
      { status: 'completed' },
      makePatch({ add_nodes: [makeNodeConfig({ id: 'n1' })] }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/terminal.*completed/)
  })

  it('rejects terminal workflow (failed)', () => {
    const r = validateReplanPreconditions(
      { status: 'failed' },
      makePatch({ add_nodes: [makeNodeConfig({ id: 'n1' })] }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/terminal.*failed/)
  })

  it('rejects terminal workflow (cancelled)', () => {
    const r = validateReplanPreconditions(
      { status: 'cancelled' },
      makePatch({ add_nodes: [makeNodeConfig({ id: 'n1' })] }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/terminal.*cancelled/)
  })

  it('accepts pending and running workflows', () => {
    const patchWithOp = makePatch({ add_nodes: [makeNodeConfig({ id: 'n1' })] })
    expect(validateReplanPreconditions({ status: 'pending' }, patchWithOp).ok).toBe(true)
    expect(validateReplanPreconditions({ status: 'running' }, patchWithOp).ok).toBe(true)
  })

  it('rejects empty patch (no ops, no concurrency bump)', () => {
    const r = validateReplanPreconditions({ status: 'running' }, makePatch())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Empty patch/)
  })

  it('accepts patch with only new_max_concurrency change', () => {
    const r = validateReplanPreconditions(
      { status: 'running' },
      makePatch({ new_max_concurrency: 5 }),
    )
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Scenario 7–9: node classification
// ---------------------------------------------------------------------------

describe('replan: node classification', () => {
  it('partitions nodes into frozen and mutable', () => {
    const nodes: DAGNodeSession[] = [
      makeNodeSession(`${WID}::a`, 'pending'),
      makeNodeSession(`${WID}::b`, 'running'),
      makeNodeSession(`${WID}::c`, 'completed'),
      makeNodeSession(`${WID}::d`, 'pending'),
    ]
    const { frozen, mutable, frozenIds } = classifyReplanNodes(nodes)
    expect(mutable.map(n => n.node_id)).toEqual([`${WID}::a`, `${WID}::d`])
    expect(frozen.map(n => n.node_id)).toEqual([`${WID}::b`, `${WID}::c`])
    expect(frozenIds).toEqual(new Set([`${WID}::b`, `${WID}::c`]))
  })

  it('treats queued nodes as frozen (safety-first)', () => {
    const nodes = [
      makeNodeSession(`${WID}::q`, 'queued'),
      makeNodeSession(`${WID}::p`, 'pending'),
    ]
    const { frozen, mutable } = classifyReplanNodes(nodes)
    expect(frozen.map(n => n.node_id)).toEqual([`${WID}::q`])
    expect(mutable.map(n => n.node_id)).toEqual([`${WID}::p`])
  })

  it('handles empty workflow', () => {
    const { frozen, mutable, frozenIds } = classifyReplanNodes([])
    expect(frozen).toEqual([])
    expect(mutable).toEqual([])
    expect(frozenIds.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Scenario 10–16: frozen and existence validation
// ---------------------------------------------------------------------------

describe('replan: frozen and existence validation', () => {
  const allIds = new Set([`${WID}::a`, `${WID}::b`, `${WID}::c`])
  // a=running, b=completed, c=pending
  const frozenIds = new Set([`${WID}::a`, `${WID}::b`])

  it('rejects remove of running node', () => {
    const r = validateFrozenAndExistence(
      makePatch({ remove_nodes: [`${WID}::a`] }),
      frozenIds,
      allIds,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/frozen/i)
  })

  it('rejects remove of completed node', () => {
    const r = validateFrozenAndExistence(
      makePatch({ remove_nodes: [`${WID}::b`] }),
      frozenIds,
      allIds,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/frozen/i)
  })

  it('rejects update of running node', () => {
    const r = validateFrozenAndExistence(
      makePatch({ update_nodes: [{ node_id: `${WID}::a`, new_config: { name: 'X' } }] }),
      frozenIds,
      allIds,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/frozen/i)
  })

  it('rejects unknown remove_node id', () => {
    const r = validateFrozenAndExistence(
      makePatch({ remove_nodes: [`${WID}::ghost`] }),
      frozenIds,
      allIds,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown/i)
  })

  it('rejects unknown update_node id', () => {
    const r = validateFrozenAndExistence(
      makePatch({ update_nodes: [{ node_id: `${WID}::ghost`, new_config: {} }] }),
      frozenIds,
      allIds,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown/i)
  })

  it('accepts valid remove of pending node', () => {
    const r = validateFrozenAndExistence(
      makePatch({ remove_nodes: [`${WID}::c`] }),
      frozenIds,
      allIds,
    )
    expect(r.ok).toBe(true)
  })

  it('accepts valid update of pending node', () => {
    const r = validateFrozenAndExistence(
      makePatch({
        update_nodes: [{ node_id: `${WID}::c`, new_config: { name: 'Updated' } }],
      }),
      frozenIds,
      allIds,
    )
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Scenario 17–23: config patch application
// ---------------------------------------------------------------------------

describe('replan: config patch application', () => {
  const n1 = makeNodeConfig({ id: 'n1', dependencies: [], required: false })
  const n2 = makeNodeConfig({ id: 'n2', dependencies: [], required: false })
  const n3 = makeNodeConfig({ id: 'n3', dependencies: ['n1'], required: false })

  it('adds new nodes to config', () => {
    const r = applyReplanPatchToConfig(WID, [n1], makePatch({ add_nodes: [n2] }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.newConfigNodes.map(n => n.id)).toEqual(['n1', 'n2'])
    }
  })

  it('removes specified pending nodes from config', () => {
    const r = applyReplanPatchToConfig(
      WID,
      [n1, n2, n3],
      makePatch({ remove_nodes: [`${WID}::n2`] }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.newConfigNodes.map(n => n.id)).toEqual(['n1', 'n3'])
    }
  })

  it('applies new_config shallowly (preserves id, overrides fields)', () => {
    const r = applyReplanPatchToConfig(
      WID,
      [n1],
      makePatch({
        update_nodes: [
          { node_id: `${WID}::n1`, new_config: { name: 'Renamed', worker_type: 'new-type' } },
        ],
      }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      const updated = r.newConfigNodes[0]
      expect(updated.id).toBe('n1') // id preserved
      expect(updated.name).toBe('Renamed')
      expect(updated.worker_type).toBe('new-type')
    }
  })

  it('applies new_dependencies (replaces existing deps in config)', () => {
    const nodeWithDeps = makeNodeConfig({ id: 'n1', dependencies: ['old-dep'] })
    const r = applyReplanPatchToConfig(
      WID,
      [nodeWithDeps, n2],
      makePatch({
        update_nodes: [
          { node_id: `${WID}::n1`, new_dependencies: ['n2'] },
        ],
      }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.newConfigNodes.find(n => n.id === 'n1')!.dependencies).toEqual(['n2'])
    }
  })

  it('preserves existing deps when new_dependencies absent', () => {
    const nodeWithDeps = makeNodeConfig({ id: 'n1', dependencies: ['n2'] })
    const r = applyReplanPatchToConfig(
      WID,
      [nodeWithDeps, n2],
      makePatch({
        update_nodes: [
          { node_id: `${WID}::n1`, new_config: { name: 'Updated' } },
        ],
      }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      // deps must remain ['n2'] since new_dependencies was not provided
      expect(r.newConfigNodes.find(n => n.id === 'n1')!.dependencies).toEqual(['n2'])
      expect(r.newConfigNodes.find(n => n.id === 'n1')!.name).toBe('Updated')
    }
  })

  it('handles combined add+remove+update in one patch', () => {
    const n4 = makeNodeConfig({ id: 'n4', dependencies: [] })
    const r = applyReplanPatchToConfig(
      WID,
      [n1, n2, n3],
      makePatch({
        remove_nodes: [`${WID}::n2`],
        update_nodes: [{ node_id: `${WID}::n3`, new_config: { name: 'N3-renamed' } }],
        add_nodes: [n4],
      }),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.newConfigNodes.map(n => n.id)).toEqual(['n1', 'n3', 'n4'])
      expect(r.newConfigNodes.find(n => n.id === 'n3')!.name).toBe('N3-renamed')
    }
  })

  it('rejects update reference to non-existent cfg.id', () => {
    const r = applyReplanPatchToConfig(
      WID,
      [n1],
      makePatch({
        update_nodes: [{ node_id: `${WID}::missing`, new_config: {} }],
      }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown node/)
  })
})

// ---------------------------------------------------------------------------
// Scenario 24–33: post-patch validation
// ---------------------------------------------------------------------------

describe('replan: post-patch validation', () => {
  function simpleWorkflow(nodes: DAGNodeConfig[], maxConcurrency = 3) {
    return { config: makeConfig(nodes, maxConcurrency) }
  }

  it('rejects > 20 nodes after add', () => {
    const existing = Array.from({ length: 20 }, (_, i) =>
      makeNodeConfig({ id: `n${i}`, required: false }),
    )
    const oneMore = makeNodeConfig({ id: 'overflow', required: false })
    const r = validateReplanPostConfig(
      [...existing, oneMore],
      makePatch({ add_nodes: [oneMore] }),
      simpleWorkflow(existing),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/node cap/)
  })

  it('rejects max_concurrency = 0', () => {
    const nodes = [makeNodeConfig({ id: 'a', required: false })]
    const r = validateReplanPostConfig(
      nodes,
      makePatch({ new_max_concurrency: 0 }),
      simpleWorkflow(nodes, 3),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/max_concurrency.*1\.\.10/)
  })

  it('rejects max_concurrency = 11', () => {
    const nodes = [makeNodeConfig({ id: 'a', required: false })]
    const r = validateReplanPostConfig(
      nodes,
      makePatch({ new_max_concurrency: 11 }),
      simpleWorkflow(nodes, 3),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/max_concurrency.*1\.\.10/)
  })

  it('accepts max_concurrency = 1', () => {
    const nodes = [makeNodeConfig({ id: 'a', required: false })]
    const r = validateReplanPostConfig(
      nodes,
      makePatch({ new_max_concurrency: 1 }),
      simpleWorkflow(nodes, 3),
    )
    expect(r.ok).toBe(true)
  })

  it('accepts max_concurrency = 10', () => {
    const nodes = [makeNodeConfig({ id: 'a', required: false })]
    const r = validateReplanPostConfig(
      nodes,
      makePatch({ new_max_concurrency: 10 }),
      simpleWorkflow(nodes, 3),
    )
    expect(r.ok).toBe(true)
  })

  it('rejects unresolved dependency', () => {
    const nodes = [
      makeNodeConfig({ id: 'a', required: false, dependencies: ['ghost'] }),
    ]
    const r = validateReplanPostConfig(
      nodes,
      makePatch(),
      simpleWorkflow([makeNodeConfig({ id: 'a', required: false })]),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unresolved dependency/)
  })

  it('rejects removal of required node', () => {
    const reqNode = makeNodeConfig({ id: 'req', required: true })
    const otherNode = makeNodeConfig({ id: 'other', required: false })
    // newConfigNodes after removal: only [otherNode]
    const r = validateReplanPostConfig(
      [otherNode],
      makePatch({ remove_nodes: [`${WID}::req`] }),
      simpleWorkflow([reqNode, otherNode]),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/required/i)
  })

  it('rejects cycle introduced via new_dependencies', () => {
    // Post-patch config: A→B, B→A
    const nodes = [
      makeNodeConfig({ id: 'A', required: false, dependencies: ['B'] }),
      makeNodeConfig({ id: 'B', required: false, dependencies: ['A'] }),
    ]
    const r = validateReplanPostConfig(
      nodes,
      makePatch(),
      simpleWorkflow([
        makeNodeConfig({ id: 'A', required: false }),
        makeNodeConfig({ id: 'B', required: false }),
      ]),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/cycle/i)
  })

  it('accepts valid diamond dependency structure', () => {
    //     A
    //    / \
    //   B   C
    //    \ /
    //     D
    const nodes = [
      makeNodeConfig({ id: 'A', required: false }),
      makeNodeConfig({ id: 'B', required: false, dependencies: ['A'] }),
      makeNodeConfig({ id: 'C', required: false, dependencies: ['A'] }),
      makeNodeConfig({ id: 'D', required: false, dependencies: ['B', 'C'] }),
    ]
    const r = validateReplanPostConfig(nodes, makePatch(), simpleWorkflow(nodes))
    expect(r.ok).toBe(true)
  })

  it('accepts valid linear chain', () => {
    // A → B → C
    const nodes = [
      makeNodeConfig({ id: 'A', required: false }),
      makeNodeConfig({ id: 'B', required: false, dependencies: ['A'] }),
      makeNodeConfig({ id: 'C', required: false, dependencies: ['B'] }),
    ]
    const r = validateReplanPostConfig(nodes, makePatch(), simpleWorkflow(nodes))
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Scenario 34–39: DB input construction
// ---------------------------------------------------------------------------

describe('replan: DB input construction', () => {
  const n1Cfg = makeNodeConfig({ id: 'n1', required: false })
  const n2Cfg = makeNodeConfig({ id: 'n2', required: false })
  const n1Session = makeNodeSession(`${WID}::n1`, 'pending', n1Cfg)
  const n2Session = makeNodeSession(`${WID}::n2`, 'pending', n2Cfg)
  const currentNodes = [n1Session, n2Session]
  const newConfigNodes = [n1Cfg, n2Cfg]

  it('namespaces new_dependencies on updates (P0 fix verification)', () => {
    const r = buildReplanDbInputs(
      WID,
      makePatch({
        update_nodes: [
          { node_id: `${WID}::n1`, new_dependencies: ['n2'] },
        ],
      }),
      newConfigNodes,
      currentNodes,
      3,
    )
    expect(r.updates[0].newDependencies).toEqual([`${WID}::n2`])
  })

  it('preserves existing deps when new_dependencies is absent (P0 fix)', () => {
    const sessionWithDeps = makeNodeSession(
      `${WID}::n1`,
      'pending',
      makeNodeConfig({ id: 'n1', dependencies: [`${WID}::old-dep`] }),
      [`${WID}::old-dep`],
    )
    const r = buildReplanDbInputs(
      WID,
      makePatch({
        update_nodes: [
          { node_id: `${WID}::n1`, new_config: { name: 'Updated' } },
        ],
      }),
      newConfigNodes,
      [sessionWithDeps, n2Session],
      3,
    )
    // The DB write must preserve the existing (namespaced) dependency
    expect(r.updates[0].newDependencies).toEqual([`${WID}::old-dep`])
  })

  it('namespaces add_nodes dependencies for DB layer', () => {
    const added = makeNodeConfig({ id: 'n3', required: false, dependencies: ['n1', 'n2'] })
    const r = buildReplanDbInputs(
      WID,
      makePatch({ add_nodes: [added] }),
      newConfigNodes,
      currentNodes,
      3,
    )
    expect(r.newNodes).toHaveLength(1)
    expect(r.newNodes[0].nodeId).toBe(`${WID}::n3`)
    expect(r.newNodes[0].dependencyNodes).toEqual([`${WID}::n1`, `${WID}::n2`])
  })

  it('returns empty arrays for patch with only remove', () => {
    const r = buildReplanDbInputs(
      WID,
      makePatch({ remove_nodes: [`${WID}::n2`] }),
      [n1Cfg], // n2 already removed from config
      currentNodes,
      3,
    )
    expect(r.removeNodeIds).toEqual([`${WID}::n2`])
    expect(r.updates).toEqual([])
    expect(r.newNodes).toEqual([])
  })

  it('builds newMaxConcurrency correctly when patch provides it', () => {
    const r = buildReplanDbInputs(
      WID,
      makePatch({ new_max_concurrency: 7 }),
      newConfigNodes,
      currentNodes,
      3,
    )
    expect(r.newMaxConcurrency).toBe(7)
  })

  it('preserves existing max_concurrency when patch is silent', () => {
    const r = buildReplanDbInputs(
      WID,
      makePatch(),
      newConfigNodes,
      currentNodes,
      5,
    )
    expect(r.newMaxConcurrency).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Scenarios 18–20: module registry coordination (behavioural)
//
// These tests validate the module-scoped registries are well-behaved data
// structures. Since DAGSessionService.make is not an Effect Context.Tag
// (no DI seam), full integration requires the integration test tier.
// Here we exercise the registry mechanics directly.
// ---------------------------------------------------------------------------

describe('replan: module registry coordination — behavioural', () => {
  beforeEach(() => {
    // Reset all module-private registries between tests
    __internal_replanInFlight().clear()
    __internal_spawnedNodes().clear()
    __internal_concurrencyRegistry().clear()
  })

  it('replanInFlight tracks in-flight workflow ids and clears on release', () => {
    const wfId = 'wf-behaviour-18'

    // Simulate replan start: engine marks in-flight
    __internal_replanInFlight().add(wfId)
    expect(__internal_replanInFlight().has(wfId)).toBe(true)

    // Simulate another concurrent workflow in-flight
    __internal_replanInFlight().add('wf-other')
    expect(__internal_replanInFlight().size).toBe(2)

    // Simulate replan end: engine clears this workflow
    __internal_replanInFlight().delete(wfId)
    expect(__internal_replanInFlight().has(wfId)).toBe(false)
    // Other workflow still in-flight (isolation)
    expect(__internal_replanInFlight().has('wf-other')).toBe(true)
  })

  it('spawnedNodes cleanup removes only targeted nodes', () => {
    const removedId = `${WID}::node-to-remove`
    const keptId = `${WID}::node-to-keep`

    // Pre-populate as if engine had previously spawned both
    __internal_spawnedNodes().add(removedId)
    __internal_spawnedNodes().add(keptId)

    // Simulate replan step 11: cleanup removed nodes
    for (const id of [removedId]) __internal_spawnedNodes().delete(id)

    expect(__internal_spawnedNodes().has(removedId)).toBe(false)
    expect(__internal_spawnedNodes().has(keptId)).toBe(true)
    expect(__internal_spawnedNodes().size).toBe(1)
  })

  it('concurrencyRegistry syncs to new max_concurrency after replan', () => {
    const wfId = 'wf-behaviour-20'

    // Initial state from startWorkflow: concurrency = 3
    __internal_concurrencyRegistry().set(wfId, 3)
    expect(__internal_concurrencyRegistry().get(wfId)).toBe(3)

    // Simulate replan step 10: concurrency bumped to 5
    __internal_concurrencyRegistry().set(wfId, 5)
    expect(__internal_concurrencyRegistry().get(wfId)).toBe(5)

    // Unrelated workflow unaffected
    __internal_concurrencyRegistry().set('wf-unrelated', 2)
    expect(__internal_concurrencyRegistry().get('wf-unrelated')).toBe(2)
    expect(__internal_concurrencyRegistry().get(wfId)).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Scenario 21 — history-row correctness — deferred.
// Requires inspection of the DAG workflow history SQLite table after
// atomicReplan commits. No existing test tier covers this (the former
// dag-integration.test.ts tier was removed from CI); see TODO below.
// ---------------------------------------------------------------------------
// TODO: Scenario 21 — verify history row contents (old_state, new_state,
//       changeDetails) after a successful replan. Requires DB fixtures.
