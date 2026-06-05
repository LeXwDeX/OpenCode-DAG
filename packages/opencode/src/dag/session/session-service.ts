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
        results = db.select().from(dagViolations)
          .where(eq(dagViolations.workflow_id, workflowId))
          .all()
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
  } satisfies DAGSessionService
})

export const DAGSessionService = {
  make,
}
