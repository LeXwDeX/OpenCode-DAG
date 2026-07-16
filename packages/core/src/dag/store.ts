export * as DagStore from "./store"

import { and, desc, eq, gte, lte, inArray } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { LayerNode } from "../effect/layer-node"
import { WorkflowNodeTable, WorkflowTable, WorkflowViolationTable } from "./sql"

// ============================================================================
// Row → domain types
// ============================================================================

export interface WorkflowRow {
  id: string
  projectId: string
  sessionId: string
  title: string
  status: string
  config: string
  seq: number
  wakeReported: boolean
  startedAt: number | null
  completedAt: number | null
  timeCreated: number
  timeUpdated: number
}

export interface NodeRow {
  id: string
  workflowId: string
  name: string
  workerType: string
  status: string
  required: boolean
  dependsOn: string[]
  modelId: string | null
  modelProviderId: string | null
  childSessionId: string | null
  output: unknown
  capturedOutput: unknown
  errorReason: string | null
  deadlineMs: number | null
  wakeEligible: boolean
  wakeReported: boolean
  replanAttempts: number
  seq: number
  startedAt: number | null
  completedAt: number | null
}

export interface ViolationRow {
  id: string
  workflowId: string
  nodeId: string | null
  type: string
  severity: string
  message: string
  details: Record<string, unknown> | null
  timeCreated: number
}

const mapWorkflow = (r: typeof WorkflowTable.$inferSelect): WorkflowRow => ({
  id: r.id,
  projectId: r.project_id,
  sessionId: r.session_id,
  title: r.title,
  status: r.status,
  config: r.config,
  seq: r.seq,
  wakeReported: r.wake_reported,
  startedAt: r.started_at,
  completedAt: r.completed_at,
  timeCreated: r.time_created,
  timeUpdated: r.time_updated,
})

const mapNode = (r: typeof WorkflowNodeTable.$inferSelect): NodeRow => ({
  id: r.id,
  workflowId: r.workflow_id,
  name: r.name,
  workerType: r.worker_type,
  status: r.status,
  required: r.required,
  dependsOn: r.depends_on,
  modelId: r.model_id,
  modelProviderId: r.model_provider_id,
  childSessionId: r.child_session_id,
  output: r.output,
  capturedOutput: r.captured_output,
  errorReason: r.error_reason,
  deadlineMs: r.deadline_ms,
  wakeEligible: r.wake_eligible,
  wakeReported: r.wake_reported,
  replanAttempts: r.replan_attempts,
  seq: r.seq,
  startedAt: r.started_at,
  completedAt: r.completed_at,
})

const mapViolation = (r: typeof WorkflowViolationTable.$inferSelect): ViolationRow => ({
  id: r.id,
  workflowId: r.workflow_id,
  nodeId: r.node_id,
  type: r.type,
  severity: r.severity,
  message: r.message,
  details: r.details,
  timeCreated: r.time_created,
})

// ============================================================================
// Query filters
// ============================================================================

export interface ViolationQuery {
  workflowId?: string
  severity?: string
  type?: string
  since?: number
  until?: number
}

// ============================================================================
// Service interface
// ============================================================================

export interface Interface {
  readonly getWorkflow: (id: string) => Effect.Effect<WorkflowRow | undefined>
  readonly listWorkflows: () => Effect.Effect<WorkflowRow[]>
  readonly listBySession: (sessionId: string) => Effect.Effect<WorkflowRow[]>
  readonly listByProject: (projectId: string) => Effect.Effect<WorkflowRow[]>
  readonly listByStatus: (status: string) => Effect.Effect<WorkflowRow[]>

  readonly getNodes: (workflowId: string) => Effect.Effect<NodeRow[]>
  readonly getNode: (nodeId: string) => Effect.Effect<NodeRow | undefined>
  readonly getRunningNodes: (workflowId: string) => Effect.Effect<NodeRow[]>
  readonly setCapturedOutput: (childSessionID: string, payload: unknown) => Effect.Effect<void>

  readonly markNodeWakeReported: (nodeID: string) => Effect.Effect<void>
  readonly markWorkflowWakeReported: (dagID: string) => Effect.Effect<void>
  readonly getUnreportedWakeNodes: (sessionID: string) => Effect.Effect<NodeRow[]>
  readonly getUnreportedWakeWorkflows: (sessionID: string) => Effect.Effect<WorkflowRow[]>
  readonly getSessionsWithUnreportedWakes: () => Effect.Effect<string[]>
  readonly hasReportedWakeNodes: (sessionID: string) => Effect.Effect<boolean>

  readonly listViolations: (workflowId: string) => Effect.Effect<ViolationRow[]>
  readonly countBySeverity: (workflowId: string) => Effect.Effect<Record<string, number>>
  readonly queryViolations: (query: ViolationQuery) => Effect.Effect<ViolationRow[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/DagStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return Service.of({
      getWorkflow: Effect.fn("DagStore.getWorkflow")(function* (id) {
        const row = yield* db.select().from(WorkflowTable).where(eq(WorkflowTable.id, id)).get().pipe(Effect.orDie)
        return row ? mapWorkflow(row) : undefined
      }),

      listWorkflows: Effect.fn("DagStore.listWorkflows")(function* () {
        const rows = yield* db.select().from(WorkflowTable).orderBy(desc(WorkflowTable.time_created)).all().pipe(Effect.orDie)
        return rows.map(mapWorkflow)
      }),

      listBySession: Effect.fn("DagStore.listBySession")(function* (sessionId) {
        const rows = yield* db
          .select()
          .from(WorkflowTable)
          .where(eq(WorkflowTable.session_id, sessionId))
          .orderBy(desc(WorkflowTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapWorkflow)
      }),

      listByProject: Effect.fn("DagStore.listByProject")(function* (projectId) {
        const rows = yield* db
          .select()
          .from(WorkflowTable)
          .where(eq(WorkflowTable.project_id, projectId))
          .orderBy(desc(WorkflowTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapWorkflow)
      }),

      listByStatus: Effect.fn("DagStore.listByStatus")(function* (status) {
        const rows = yield* db
          .select()
          .from(WorkflowTable)
          .where(eq(WorkflowTable.status, status))
          .orderBy(desc(WorkflowTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapWorkflow)
      }),

      getNodes: Effect.fn("DagStore.getNodes")(function* (workflowId) {
        const rows = yield* db
          .select()
          .from(WorkflowNodeTable)
          .where(eq(WorkflowNodeTable.workflow_id, workflowId))
          .orderBy(desc(WorkflowNodeTable.seq))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapNode)
      }),

      getNode: Effect.fn("DagStore.getNode")(function* (nodeId) {
        const row = yield* db.select().from(WorkflowNodeTable).where(eq(WorkflowNodeTable.id, nodeId)).get().pipe(Effect.orDie)
        return row ? mapNode(row) : undefined
      }),

      getRunningNodes: Effect.fn("DagStore.getRunningNodes")(function* (workflowId) {
        const rows = yield* db
          .select()
          .from(WorkflowNodeTable)
          .where(and(eq(WorkflowNodeTable.workflow_id, workflowId), eq(WorkflowNodeTable.status, "running")))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapNode)
      }),

      setCapturedOutput: Effect.fn("DagStore.setCapturedOutput")(function* (childSessionID, payload) {
        yield* db
          .update(WorkflowNodeTable)
          .set({ captured_output: payload })
          .where(eq(WorkflowNodeTable.child_session_id, childSessionID))
          .run()
          .pipe(Effect.orDie)
      }),

      markNodeWakeReported: Effect.fn("DagStore.markNodeWakeReported")(function* (nodeID) {
        yield* db
          .update(WorkflowNodeTable)
          .set({ wake_reported: true })
          .where(eq(WorkflowNodeTable.id, nodeID))
          .run()
          .pipe(Effect.orDie)
      }),

      markWorkflowWakeReported: Effect.fn("DagStore.markWorkflowWakeReported")(function* (dagID) {
        yield* db
          .update(WorkflowTable)
          .set({ wake_reported: true })
          .where(eq(WorkflowTable.id, dagID))
          .run()
          .pipe(Effect.orDie)
      }),

      getUnreportedWakeNodes: Effect.fn("DagStore.getUnreportedWakeNodes")(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(WorkflowNodeTable)
          .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
          .where(and(
            eq(WorkflowTable.session_id, sessionID),
            eq(WorkflowNodeTable.wake_eligible, true),
            eq(WorkflowNodeTable.wake_reported, false),
            inArray(WorkflowNodeTable.status, ["completed", "failed"]),
          ))
          .all()
          .pipe(Effect.orDie)
        return rows.map((r) => mapNode(r.workflow_node))
      }),

      getUnreportedWakeWorkflows: Effect.fn("DagStore.getUnreportedWakeWorkflows")(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(WorkflowTable)
          .where(and(
            eq(WorkflowTable.session_id, sessionID),
            eq(WorkflowTable.wake_reported, false),
          ))
          .all()
          .pipe(Effect.orDie)
        return rows
          .filter((r) => ["completed", "failed", "cancelled"].includes(r.status))
          .map(mapWorkflow)
      }),

      getSessionsWithUnreportedWakes: Effect.fn("DagStore.getSessionsWithUnreportedWakes")(function* () {
        const workflowRows = yield* db
          .select({ sessionId: WorkflowTable.session_id })
          .from(WorkflowTable)
          .where(and(
            eq(WorkflowTable.wake_reported, false),
            inArray(WorkflowTable.status, ["completed", "failed", "cancelled"]),
          ))
          .all()
          .pipe(Effect.orDie)
        const nodeRows = yield* db
          .select({ sessionId: WorkflowTable.session_id })
          .from(WorkflowNodeTable)
          .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
          .where(and(
            eq(WorkflowNodeTable.wake_eligible, true),
            eq(WorkflowNodeTable.wake_reported, false),
            inArray(WorkflowNodeTable.status, ["completed", "failed"]),
          ))
          .all()
          .pipe(Effect.orDie)
        return [...new Set([...workflowRows, ...nodeRows].map((row) => row.sessionId))]
      }),

      hasReportedWakeNodes: Effect.fn("DagStore.hasReportedWakeNodes")(function* (sessionID) {
        const rows = yield* db
          .select({ id: WorkflowNodeTable.id })
          .from(WorkflowNodeTable)
          .innerJoin(WorkflowTable, eq(WorkflowNodeTable.workflow_id, WorkflowTable.id))
          .where(and(
            eq(WorkflowTable.session_id, sessionID),
            eq(WorkflowNodeTable.wake_eligible, true),
            eq(WorkflowNodeTable.wake_reported, true),
          ))
          .all()
          .pipe(Effect.orDie)
        return rows.length > 0
      }),

      listViolations: Effect.fn("DagStore.listViolations")(function* (workflowId) {
        const rows = yield* db
          .select()
          .from(WorkflowViolationTable)
          .where(eq(WorkflowViolationTable.workflow_id, workflowId))
          .orderBy(desc(WorkflowViolationTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapViolation)
      }),

      countBySeverity: Effect.fn("DagStore.countBySeverity")(function* (workflowId) {
        const rows = yield* db
          .select()
          .from(WorkflowViolationTable)
          .where(eq(WorkflowViolationTable.workflow_id, workflowId))
          .all()
          .pipe(Effect.orDie)
        const counts: Record<string, number> = {}
        for (const r of rows) counts[r.severity] = (counts[r.severity] ?? 0) + 1
        return counts
      }),

      queryViolations: Effect.fn("DagStore.queryViolations")(function* (query) {
        const conditions = []
        if (query.workflowId) conditions.push(eq(WorkflowViolationTable.workflow_id, query.workflowId))
        if (query.severity) conditions.push(eq(WorkflowViolationTable.severity, query.severity))
        if (query.type) conditions.push(eq(WorkflowViolationTable.type, query.type))
        if (query.since) conditions.push(gte(WorkflowViolationTable.time_created, query.since))
        if (query.until) conditions.push(lte(WorkflowViolationTable.time_created, query.until))
        const rows = yield* db
          .select()
          .from(WorkflowViolationTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(WorkflowViolationTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return rows.map(mapViolation)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [Database.node])
