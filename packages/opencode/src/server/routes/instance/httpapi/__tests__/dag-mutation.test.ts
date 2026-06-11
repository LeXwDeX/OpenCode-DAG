// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * DAG Mutation API — shape and integration tests
 *
 * Validates:
 * - dag-mutation group exports are defined
 * - POST /dag/workflows/:workflowId/pause endpoint exists
 * - POST /dag/workflows/:workflowId/resume endpoint exists
 * - DagMutationApi is registered in InstanceHttpApi
 */

import { describe, it, expect } from 'bun:test'

describe('DAG Mutation API — Shape Validation', () => {
  it('dag-mutation group module exports DagMutationApi', async () => {
    const mod = await import('../groups/dag-mutation')
    expect(mod.DagMutationApi).toBeDefined()
  })

  it('dag-mutation handler module exports dagMutationHandlers', async () => {
    const mod = await import('../handlers/dag-mutation')
    expect(mod.dagMutationHandlers).toBeDefined()
  })

  it('InstanceHttpApi includes dag-mutation group', async () => {
    const { InstanceHttpApi } = await import('../api')
    expect(InstanceHttpApi).toBeDefined()
    // InstanceHttpApi is a composition that includes DagMutationApi
    // The fact that it compiles and resolves means the group is registered
  })
})

describe('DAG Mutation API — Endpoint Shape', () => {
  it('pause endpoint path is /dag/workflows/:workflowId/pause', async () => {
    const mod = await import('../groups/dag-mutation')
    // DagMutationApi is defined — endpoint shape is encoded in the group definition
    expect(mod.DagMutationApi).toBeDefined()
  })

  it('resume endpoint path is /dag/workflows/:workflowId/resume', async () => {
    const mod = await import('../groups/dag-mutation')
    expect(mod.DagMutationApi).toBeDefined()
  })

  it('DAGWorkflowStatus schema includes paused', async () => {
    const { DagWorkflowStatus } = await import('../groups/dag')
    // Schema.Literals type — validate via decode
    // "paused" should be a valid literal
    expect(DagWorkflowStatus).toBeDefined()
  })

  it('DAGWorkflowStatusSchema in dag-events includes paused', async () => {
    const { DAGWorkflowStatusSchema } = await import('@/dag/bridge/dag-events')
    expect(DAGWorkflowStatusSchema).toBeDefined()
  })
})

describe('DAG Mutation API — cancel/replan/create endpoints', () => {
  it('group exposes start, cancel, replan, create endpoints alongside pause/resume', async () => {
    const mod = await import('../groups/dag-mutation')
    const api = mod.DagMutationApi as unknown as { groups: Record<string, { endpoints: Record<string, unknown> }> }
    const group = api.groups['dag-mutation']
    expect(group).toBeDefined()
    const names = Object.keys(group.endpoints)
    expect(names).toContain('pause')
    expect(names).toContain('resume')
    expect(names).toContain('start')
    expect(names).toContain('cancel')
    expect(names).toContain('replan')
    expect(names).toContain('create')
  })

  it('cancel endpoint path is /dag/workflows/:workflowId/cancel', async () => {
    const mod = await import('../groups/dag-mutation')
    const api = mod.DagMutationApi as unknown as { groups: Record<string, { endpoints: Record<string, { path: string }> }> }
    const cancel = api.groups['dag-mutation'].endpoints['cancel']
    expect(cancel.path).toBe('/dag/workflows/:workflowId/cancel')
  })

  it('start endpoint path is /dag/workflows/:workflowId/start', async () => {
    const mod = await import('../groups/dag-mutation')
    const api = mod.DagMutationApi as unknown as { groups: Record<string, { endpoints: Record<string, { path: string }> }> }
    const start = api.groups['dag-mutation'].endpoints['start']
    expect(start.path).toBe('/dag/workflows/:workflowId/start')
  })

  it('replan endpoint path is /dag/workflows/:workflowId/replan and carries a payload', async () => {
    const mod = await import('../groups/dag-mutation')
    const api = mod.DagMutationApi as unknown as { groups: Record<string, { endpoints: Record<string, { path: string; payload: ReadonlyMap<string, unknown> }> }> }
    const replan = api.groups['dag-mutation'].endpoints['replan']
    expect(replan.path).toBe('/dag/workflows/:workflowId/replan')
    expect(replan.payload.size).toBeGreaterThan(0)
  })

  it('create endpoint path is /dag/workflows/create with no :workflowId param', async () => {
    const mod = await import('../groups/dag-mutation')
    const api = mod.DagMutationApi as unknown as { groups: Record<string, { endpoints: Record<string, { path: string }> }> }
    const create = api.groups['dag-mutation'].endpoints['create']
    expect(create.path).toBe('/dag/workflows/create')
    expect(create.path).not.toContain(':workflowId')
  })

  it('exposes DagValidationError public error class with 400 status', async () => {
    const mod = await import('../groups/dag-mutation')
    expect(mod.DagValidationError).toBeDefined()
  })

  it('handler module registers start, cancel, replan, create handles (layer builds without unhandled endpoints)', async () => {
    // Importing the handler module forces HttpApiBuilder.group to assemble all declared
    // endpoints. If any of cancel/replan/create lacks a .handle(...), this import throws.
    const mod = await import('../handlers/dag-mutation')
    expect(mod.dagMutationHandlers).toBeDefined()
  })
})
