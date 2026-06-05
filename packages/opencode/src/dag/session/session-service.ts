import { Effect } from "effect"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { 
  dagWorkflows, 
  dagNodes, 
  dagViolations 
} from "../persistence/schema"
import type {
  DAGWorkflowSession,
  DAGNodeSession,
  DAGViolation,
  DAGWorkflowStatus,
  DAGNodeStatus,
  DAGViolationType,
  DAGViolationSeverity,
} from "./types"
import type { IEventBus } from "../state-machine/IStateMachine"
import type { WorkflowEvent, NodeEvent, DiffStats } from "../state-machine/types"
import { FallbackTrigger } from "../state-machine/types"

// ============================================================================
// Iron Law Enforcement: Module-Level Event Bus & Validation Helpers
// ============================================================================

let _eventBus: IEventBus | undefined

/**
 * Inject an IEventBus for state-change event broadcasting (Iron Law #3).
 * Optional — if not set, no events are emitted (graceful degradation).
 */
export function setEventBus(bus: IEventBus | undefined): void {
  _eventBus = bus
}

/**
 * Session-layer valid next workflow statuses (Iron Law #1/#2).
 * Terminal states: completed, failed, cancelled — no outgoing transitions.
 */
export function getValidNextSessionWorkflowStatuses(
  currentStatus: DAGWorkflowStatus
): DAGWorkflowStatus[] {
  switch (currentStatus) {
    case "pending":
      return ["running", "failed", "cancelled"]
    case "running":
      return ["completed", "failed", "cancelled"]
    case "completed":
    case "failed":
    case "cancelled":
      return []
    default:
      return []
  }
}

/**
 * Session-layer valid next node statuses (Iron Law #1/#2).
 * Terminal states: completed, failed, skipped — no outgoing transitions.
 */
export function getValidNextSessionNodeStatuses(
  currentStatus: DAGNodeStatus
): DAGNodeStatus[] {
  switch (currentStatus) {
    case "pending":
      return ["queued", "running", "skipped"]
    case "queued":
      return ["running", "skipped"]
    case "running":
      return ["completed", "failed"]
    case "completed":
    case "failed":
    case "skipped":
      return []
    default:
      return []
  }
}

/**
 * Build a WorkflowEvent from a session-layer status transition (Iron Law #3).
 * Returns null when no corresponding event type exists.
 */
export function buildSessionWorkflowEvent(
  workflowId: string,
  oldStatus: DAGWorkflowStatus,
  newStatus: DAGWorkflowStatus,
  timestamp: number,
  durationMs?: number,
  accumulatedDiff?: string,
  reason?: string,
  failedNodes?: string[],
): WorkflowEvent | null {
  // Note: Session layer DAGWorkflowStatus omits "paused", so workflow.resumed is unreachable here.
  switch (newStatus) {
    case "running":
      return { type: "workflow.started", workflow_id: workflowId, timestamp: new Date(timestamp) }
    case "completed":
      return { type: "workflow.completed", workflow_id: workflowId, duration_ms: durationMs ?? 0, accumulated_diff: accumulatedDiff ?? "" }
    case "failed":
      return { type: "workflow.failed", workflow_id: workflowId, reason: reason ?? "status_updated", failed_nodes: failedNodes ?? [] }
    case "cancelled":
      return { type: "workflow.cancelled", workflow_id: workflowId, cancelled_at: new Date(timestamp) }
    default:
      return null
  }
}

/**
 * Build a NodeEvent from a session-layer status transition (Iron Law #3).
 * Returns null when no corresponding event type exists (e.g. pending, queued).
 */
/** Empty DiffStats placeholder for events where real diff data isn't available. */
const EMPTY_DIFF_STATS: DiffStats = { files_changed_count: 0, lines_added: 0, lines_removed: 0, patch_file: "" }

export function buildSessionNodeEvent(
  workflowId: string,
  nodeId: string,
  nodeName: string,
  newStatus: DAGNodeStatus,
  opts?: {
    worktreePath?: string
    outputSummary?: unknown
    diffStats?: DiffStats
    triggerReason?: FallbackTrigger
    upstreamFailedNode?: string
  }
): NodeEvent | null {
  switch (newStatus) {
    case "running":
      return { type: "node.started", workflow_id: workflowId, node_name: nodeName, worktree_path: opts?.worktreePath ?? "" }
    case "completed":
      return {
        type: "node.completed",
        workflow_id: workflowId,
        node_name: nodeName,
        output_summary: opts?.outputSummary ?? null,
        diff_stats: opts?.diffStats ?? EMPTY_DIFF_STATS,
      }
    case "failed":
      return { type: "node.failed", workflow_id: workflowId, node_name: nodeName, trigger_reason: opts?.triggerReason ?? FallbackTrigger.EXEC_FAILED }
    case "skipped":
      return { type: "node.skipped", workflow_id: workflowId, node_name: nodeName, upstream_failed_node: opts?.upstreamFailedNode ?? "" }
    default:
      return null
  }
}

// ============================================================================
// Types
// ============================================================================

export interface CreateWorkflowInput {
  name: string
  chatSessionId: string
  config: any
  metadata?: Record<string, unknown>
}

export interface CreateNodeInput {
  workflowId: string
  name: string
  nodeName: string
  nodeType: string
  config: any
  inputData?: any
  timeoutMs?: number
  retryCount?: number
  maxRetries?: number
  dependencyNodes?: string[]
}

export interface UpdateNodeStatusInput {
  sessionId: string
  status: DAGNodeStatus
  outputData?: any
  error?: any
}

export interface CreateViolationInput {
  workflowId: string
  nodeId?: string
  type: DAGViolationType
  severity: DAGViolationSeverity
  message: string
  details?: Record<string, unknown>
}

// ============================================================================
// Service Interface
// ============================================================================

export interface DAGSessionService {
  readonly createWorkflow: (input: CreateWorkflowInput) => Effect.Effect<DAGWorkflowSession>
  readonly getWorkflow: (workflowId: string) => Effect.Effect<DAGWorkflowSession | undefined>
  readonly listWorkflowsByChatSession: (chatSessionId: string) => Effect.Effect<DAGWorkflowSession[]>
  readonly listAllWorkflows: () => Effect.Effect<DAGWorkflowSession[]>
  readonly updateWorkflowStatus: (workflowId: string, status: DAGWorkflowStatus) => Effect.Effect<void>
  
  readonly createNode: (input: CreateNodeInput) => Effect.Effect<DAGNodeSession>
  readonly getNode: (nodeId: string) => Effect.Effect<DAGNodeSession | undefined>
  readonly listNodes: (workflowId: string) => Effect.Effect<DAGNodeSession[]>
  readonly updateNodeStatus: (input: UpdateNodeStatusInput) => Effect.Effect<void>
  
  readonly createViolation: (input: CreateViolationInput) => Effect.Effect<DAGViolation>
  readonly listViolations: (workflowId: string) => Effect.Effect<DAGViolation[]>
}

// ============================================================================
// Implementation
// ============================================================================

const make = Effect.gen(function* () {
  
  const createWorkflow: DAGSessionService["createWorkflow"] = (input) =>
    Effect.sync(() => {
      const now = Date.now()
      const workflowId = `workflow_${now}_${Math.random().toString(36).slice(2)}`
      
      Database.use((db) => {
        db.insert(dagWorkflows).values({
          workflow_id: workflowId,
          chat_session_id: input.chatSessionId,
          name: input.name,
          config: JSON.stringify(input.config),
          metadata: JSON.stringify(input.metadata ?? {}),
          status: "pending",
          created_at: now,
          updated_at: now,
          started_at: null,
          completed_at: null,
        }).run()
      })
      
      return {
        id: workflowId,
        chat_session_id: input.chatSessionId,
        config: input.config,
        metadata: input.metadata ?? {},
        status: "pending" as const,
        start_time: now,
        end_time: null,
        current_node: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
        duration_ms: null,
        node_sessions: {},
        violations: [],
      }
    })
  
  const getWorkflow: DAGSessionService["getWorkflow"] = (workflowId) =>
    Effect.sync(() => {
      let result: any[] = []
      
      Database.use((db) => {
        result = db.select().from(dagWorkflows).where(eq(dagWorkflows.workflow_id, workflowId)).limit(1).all()
      })
      
      if (result.length === 0) return undefined
      
      const row = result[0]
      return {
        id: row.workflow_id,
        chat_session_id: row.chat_session_id,
        config: JSON.parse(row.config),
        metadata: JSON.parse(row.metadata ?? "{}"),
        status: row.status as DAGWorkflowStatus,
        start_time: row.started_at ?? row.created_at,
        end_time: row.completed_at,
        current_node: null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at,
        duration_ms: row.completed_at ? row.completed_at - (row.started_at ?? row.created_at) : null,
        node_sessions: {},
        violations: [],
      }
    })
  
  const listWorkflowsByChatSession: DAGSessionService["listWorkflowsByChatSession"] = (chatSessionId) =>
    Effect.sync(() => {
      let results: any[] = []
      
      Database.use((db) => {
        results = db.select().from(dagWorkflows)
          .where(eq(dagWorkflows.chat_session_id, chatSessionId))
          .all()
      })
      
      return results.map(row => ({
        id: row.workflow_id,
        chat_session_id: row.chat_session_id,
        config: JSON.parse(row.config),
        metadata: JSON.parse(row.metadata ?? "{}"),
        status: row.status as DAGWorkflowStatus,
        start_time: row.started_at ?? row.created_at,
        end_time: row.completed_at,
        current_node: null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at,
        duration_ms: row.completed_at ? row.completed_at - (row.started_at ?? row.created_at) : null,
        node_sessions: {},
        violations: [],
      }))
    })
  
  const updateWorkflowStatus: DAGSessionService["updateWorkflowStatus"] = (workflowId, status) =>
    Effect.sync(() => {
      const now = Date.now()
      
      // ── Iron Law #1/#2: Read current status & validate transition ──
      let currentStatus: DAGWorkflowStatus | null = null
      let startedAt: number | null = null
      Database.use((db) => {
        const rows = db.select({ status: dagWorkflows.status, started_at: dagWorkflows.started_at })
          .from(dagWorkflows)
          .where(eq(dagWorkflows.workflow_id, workflowId))
          .limit(1)
          .all()
        if (rows.length > 0) {
          currentStatus = rows[0].status as DAGWorkflowStatus
          startedAt = rows[0].started_at
        }
      })
      
      if (currentStatus) {
        const validNext = getValidNextSessionWorkflowStatuses(currentStatus)
        if (!validNext.includes(status)) {
          throw new Error(
            `Invalid workflow transition: ${currentStatus} → ${status}. Valid: [${validNext.join(", ")}]`
          )
        }
      }
      
      // ── Iron Law #4: Build updates & persist ──
      const updates: any = {
        status,
        updated_at: now,
      }
      
      if (status === "running") {
        updates.started_at = now
      }
      
      if (status === "completed" || status === "failed" || status === "cancelled") {
        updates.completed_at = now
      }
      
      Database.use((db) => {
        db.update(dagWorkflows)
          .set(updates)
          .where(eq(dagWorkflows.workflow_id, workflowId))
          .run()
      })
      
      // ── Iron Law #3: Emit event after successful persist ──
      if (_eventBus && currentStatus) {
        const durationMs = (status === "completed" || status === "failed" || status === "cancelled") && startedAt
          ? now - startedAt
          : undefined
        const event = buildSessionWorkflowEvent(workflowId, currentStatus, status, now, durationMs)
        if (event) _eventBus.emit(event)
      }
    })
  
  const createNode: DAGSessionService["createNode"] = (input) =>
    Effect.sync(() => {
      const now = Date.now()
      const nodeId = `node_${now}_${Math.random().toString(36).slice(2)}`
      
      Database.use((db) => {
        db.insert(dagNodes).values({
          node_id: nodeId,
          workflow_id: input.workflowId,
          config: JSON.stringify(input.config),
          status: "pending",
          output: null,
          error_info: null,
          retry_count: input.retryCount ?? 0,
          max_retries: input.maxRetries ?? 3,
          timeout_ms: input.timeoutMs ?? 300000,
          required_nodes: JSON.stringify([]),
          dependencies: JSON.stringify(input.dependencyNodes ?? []),
          metadata: JSON.stringify({}),
          start_time: null,
          end_time: null,
          parent_node: null,
          duration_ms: null,
          created_at: now,
          updated_at: now,
          completed_at: null,
        }).run()
      })
      
      return {
        node_id: nodeId,
        workflow_id: input.workflowId,
        config: input.config,
        status: "pending" as const,
        output: input.inputData ?? null,
        retry_count: input.retryCount ?? 0,
        max_retries: input.maxRetries ?? 3,
        timeout_ms: input.timeoutMs ?? 300000,
        required_nodes: [],
        dependencies: input.dependencyNodes ?? [],
        metadata: {},
        start_time: null,
        completed_at: null,
        end_time: null,
        duration_ms: null,
        parent_node: null,
        created_at: now,
        updated_at: now,
        logs: [],
      }
    })
  
  const getNode: DAGSessionService["getNode"] = (nodeId) =>
    Effect.sync(() => {
      let result: any[] = []
      
      Database.use((db) => {
        result = db.select().from(dagNodes).where(eq(dagNodes.node_id, nodeId)).limit(1).all()
      })
      
      if (result.length === 0) return undefined
      
      const row = result[0]
      return {
        node_id: row.node_id,
        workflow_id: row.workflow_id,
        config: JSON.parse(row.config),
        status: row.status as DAGNodeStatus,
        output: row.output ? JSON.parse(row.output) : null,
        retry_count: row.retry_count,
        max_retries: row.max_retries,
        timeout_ms: row.timeout_ms,
        required_nodes: JSON.parse(row.required_nodes),
        dependencies: JSON.parse(row.dependencies),
        metadata: JSON.parse(row.metadata),
        start_time: row.start_time,
        completed_at: row.completed_at?.toString() ?? null,
        end_time: row.end_time,
        duration_ms: row.duration_ms,
        parent_node: row.parent_node,
        created_at: row.created_at,
        updated_at: row.updated_at,
        logs: [],
        error_info: row.error_info ? JSON.parse(row.error_info) : undefined,
      }
    })
  
  const listNodes: DAGSessionService["listNodes"] = (workflowId) =>
    Effect.sync(() => {
      let results: any[] = []
      
      Database.use((db) => {
        results = db.select().from(dagNodes)
          .where(eq(dagNodes.workflow_id, workflowId))
          .all()
      })
      
      return results.map(row => ({
        node_id: row.node_id,
        workflow_id: row.workflow_id,
        config: JSON.parse(row.config),
        status: row.status as DAGNodeStatus,
        output: row.output ? JSON.parse(row.output) : null,
        retry_count: row.retry_count,
        max_retries: row.max_retries,
        timeout_ms: row.timeout_ms,
        required_nodes: JSON.parse(row.required_nodes),
        dependencies: JSON.parse(row.dependencies),
        metadata: JSON.parse(row.metadata),
        start_time: row.start_time,
        completed_at: row.completed_at?.toString() ?? null,
        end_time: row.end_time,
        duration_ms: row.duration_ms,
        parent_node: row.parent_node,
        created_at: row.created_at,
        updated_at: row.updated_at,
        logs: [],
        error_info: row.error_info ? JSON.parse(row.error_info) : undefined,
      }))
    })
  
  const updateNodeStatus: DAGSessionService["updateNodeStatus"] = (input) =>
    Effect.sync(() => {
      const now = Date.now()
      
      // ── Iron Law #1/#2: Read current status & validate transition ──
      let currentStatus: DAGNodeStatus | null = null
      let nodeWorkflowId: string | null = null
      let nodeName: string = input.sessionId
      Database.use((db) => {
        const rows = db.select({
          status: dagNodes.status,
          workflow_id: dagNodes.workflow_id,
          config: dagNodes.config,
        })
          .from(dagNodes)
          .where(eq(dagNodes.node_id, input.sessionId))
          .limit(1)
          .all()
        if (rows.length > 0) {
          currentStatus = rows[0].status as DAGNodeStatus
          nodeWorkflowId = rows[0].workflow_id
          const cfg = rows[0].config as any
          if (cfg?.name) nodeName = cfg.name
        }
      })
      
      if (currentStatus) {
        const validNext = getValidNextSessionNodeStatuses(currentStatus)
        if (!validNext.includes(input.status)) {
          throw new Error(
            `Invalid node transition: ${input.sessionId} (${currentStatus} → ${input.status}). Valid: [${validNext.join(", ")}]`
          )
        }
      }
      
      // ── Iron Law #4: Build updates & persist ──
      const updates: any = {
        status: input.status,
        updated_at: now,
      }
      
      if (input.status === "running") {
        updates.start_time = now
      }
      
      if (input.status === "completed" || input.status === "failed") {
        updates.end_time = now
        updates.completed_at = now
      }
      
      if (input.outputData !== undefined) {
        updates.output = JSON.stringify(input.outputData)
      }
      
      Database.use((db) => {
        db.update(dagNodes)
          .set(updates)
          .where(eq(dagNodes.node_id, input.sessionId))
          .run()
      })
      
      // ── Iron Law #3: Emit event after successful persist ──
      if (_eventBus && nodeWorkflowId) {
        const event = buildSessionNodeEvent(nodeWorkflowId, input.sessionId, nodeName, input.status, {
          outputSummary: input.outputData,
        })
        if (event) _eventBus.emit(event)
      }
    })
  
  const createViolation: DAGSessionService["createViolation"] = (input) =>
    Effect.sync(() => {
      const now = new Date().toISOString()
      const violationId = `violation_${Date.now()}_${Math.random().toString(36).slice(2)}`
      
      Database.use((db) => {
        db.insert(dagViolations).values({
          violation_id: violationId,
          workflow_id: input.workflowId,
          chat_session_id: "",
          node_id: input.nodeId ?? null,
          violation_type: input.type,
          severity: input.severity,
          message: input.message,
          details: JSON.stringify(input.details ?? {}),
          created_at: Date.now(),
        }).run()
      })
      
      return {
        id: violationId,
        workflowId: input.workflowId,
        nodeId: input.nodeId,
        type: input.type,
        severity: input.severity,
        message: input.message,
        timestamp: now,
        details: input.details,
      }
    })
  
  const listViolations: DAGSessionService["listViolations"] = (workflowId) =>
    Effect.sync(() => {
      let results: any[] = []
      Database.use((db) => {
        results = db.select().from(dagViolations).where(eq(dagViolations.workflow_id, workflowId)).all()
      })
      
      return results.map(row => ({
        id: row.violation_id,
        workflowId: row.workflow_id,
        nodeId: row.node_id ?? undefined,
        type: row.violation_type as DAGViolationType,
        severity: row.severity as DAGViolationSeverity,
        message: row.message,
        timestamp: new Date(row.created_at).toISOString(),
        details: row.details ? JSON.parse(row.details) : undefined,
      }))
    })
  
  const listAllWorkflows: DAGSessionService["listAllWorkflows"] = () =>
    Effect.sync(() => {
      let results: any[] = []
      Database.use((db) => {
        results = db.select().from(dagWorkflows).all()
      })
      
      return results.map(row => ({
        id: row.workflow_id,
        chat_session_id: row.chat_session_id,
        config: row.config ? JSON.parse(row.config) : {},
        metadata: row.metadata ? JSON.parse(row.metadata) : {},
        status: row.status as DAGWorkflowStatus,
        start_time: row.started_at ?? row.created_at,
        end_time: row.completed_at,
        current_node: null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at,
        duration_ms: row.completed_at ? row.completed_at - (row.started_at ?? row.created_at) : null,
        node_sessions: {},
        violations: [],
      }))
    })
  
  return {
    createWorkflow,
    getWorkflow,
    listWorkflowsByChatSession,
    updateWorkflowStatus,
    createNode,
    getNode,
    listNodes,
    updateNodeStatus,
    createViolation,
    listViolations,
    listAllWorkflows,
  } satisfies DAGSessionService
})

export const DAGSessionService = {
  make,
}
