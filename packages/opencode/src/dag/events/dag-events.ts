import { z } from "zod"

// ============================================================================
// DAG Event Bus Types
// ============================================================================

/**
 * Workflow state changes
 */
export const WorkflowCreatedEventData = z.object({
  workflowId: z.string(),
  chatSessionId: z.string(),
  config: z.any(),
})
export type WorkflowCreatedEvent = z.infer<typeof WorkflowCreatedEventData>

export const WorkflowStartedEventData = z.object({
  workflowId: z.string(),
  chatSessionId: z.string(),
  startedAt: z.number(),
})
export type WorkflowStartedEvent = z.infer<typeof WorkflowStartedEventData>

export const WorkflowCompletedEventData = z.object({
  workflowId: z.string(),
  chatSessionId: z.string(),
  completedAt: z.number(),
  durationMs: z.number(),
})
export type WorkflowCompletedEvent = z.infer<typeof WorkflowCompletedEventData>

export const WorkflowFailedEventData = z.object({
  workflowId: z.string(),
  chatSessionId: z.string(),
  failedAt: z.number(),
  reason: z.string(),
  durationMs: z.number().optional(),
})
export type WorkflowFailedEvent = z.infer<typeof WorkflowFailedEventData>

/**
 * Node state changes
 */
export const NodeQueuedEventData = z.object({
  nodeId: z.string(),
  workflowId: z.string(),
  chatSessionId: z.string(),
  queuedAt: z.number(),
})
export type NodeQueuedEvent = z.infer<typeof NodeQueuedEventData>

export const NodeStartedEventData = z.object({
  nodeId: z.string(),
  workflowId: z.string(),
  chatSessionId: z.string(),
  startedAt: z.number(),
})
export type NodeStartedEvent = z.infer<typeof NodeStartedEventData>

export const NodeCompletedEventData = z.object({
  nodeId: z.string(),
  workflowId: z.string(),
  chatSessionId: z.string(),
  completedAt: z.number(),
  durationMs: z.number(),
  output: z.any().optional(),
})
export type NodeCompletedEvent = z.infer<typeof NodeCompletedEventData>

export const NodeFailedEventData = z.object({
  nodeId: z.string(),
  workflowId: z.string(),
  chatSessionId: z.string(),
  failedAt: z.number(),
  error: z.string(),
  durationMs: z.number().optional(),
})
export type NodeFailedEvent = z.infer<typeof NodeFailedEventData>

/**
 * Violation events
 */
export const ViolationDetectedEventData = z.object({
  workflowId: z.string(),
  chatSessionId: z.string(),
  violationType: z.string(),
  message: z.string(),
  nodeId: z.string().optional(),
  severity: z.enum(["error", "warning", "info"]),
  detectedAt: z.number(),
})
export type ViolationDetectedEvent = z.infer<typeof ViolationDetectedEventData>

export const ViolationRecordedEventData = z.object({
  violationId: z.string(),
  workflowId: z.string(),
  chatSessionId: z.string(),
  violationType: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  recordedAt: z.number(),
})
export type ViolationRecordedEvent = z.infer<typeof ViolationRecordedEventData>

/**
 * DAG Event Bus event map
 */
export interface DAGEventBusEvents {
  "dag:workflow:created": WorkflowCreatedEvent
  "dag:workflow:started": WorkflowStartedEvent
  "dag:workflow:completed": WorkflowCompletedEvent
  "dag:workflow:failed": WorkflowFailedEvent
  "dag:node:queued": NodeQueuedEvent
  "dag:node:started": NodeStartedEvent
  "dag:node:completed": NodeCompletedEvent
  "dag:node:failed": NodeFailedEvent
  "dag:violation:detected": ViolationDetectedEvent
  "dag:violation:recorded": ViolationRecordedEvent
}

/**
 * Type-safe event names
 */
export type DAGEventName = keyof DAGEventBusEvents

/**
 * Generic event payload
 */
export type DAGEventPayload<T extends DAGEventName> = DAGEventBusEvents[T]
