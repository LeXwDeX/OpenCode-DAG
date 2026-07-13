export * as Dag from "./dag"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { DateTime, Effect, Layer, Context } from "effect"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { validateRequiredNodes } from "@opencode-ai/core/dag/core/required-validator"
import { planReplan } from "@opencode-ai/core/dag/core/replan"
import {
  getValidNextWorkflowStatuses,
  getValidNextNodeStatuses,
  isWorkflowTerminalStatus,
  InvalidTransitionError,
  WorkflowStatus,
  NodeStatus,
} from "@opencode-ai/core/dag/core/types"

// Re-export domain types
export const ID = DagEvent.DagID
export type ID = typeof ID.Type
export const NodeID = DagEvent.NodeID
export type NodeID = typeof NodeID.Type

/** A node as declared in the workflow's YAML config. */
export interface NodeConfig {
  id: string
  name: string
  worker_type: string
  depends_on: string[]
  required: boolean
  prompt_template: { id?: string; inline?: string; input?: Record<string, unknown> }
  worker_config?: { use_worktree?: boolean; timeout_ms?: number; retry?: { max_attempts: number; delay_ms: number } }
  input_mapping?: Record<string, string>
  report_to_parent?: boolean
  condition?: string
  model?: { modelID: string; providerID: string }
  restart?: boolean
  cancel?: boolean
  output_schema?: Record<string, unknown>
}

export interface WorkflowConfig {
  name: string
  description?: string
  max_concurrency: number
  timeout_ms?: number
  report_strategy?: "silent" | "on_completion" | "on_converge"
  replan_policy?: { allow_kill_running?: boolean; orphan_strategy?: "auto_cancel" | "auto_fail" | "rewire_required" }
  nodes: NodeConfig[]
}

export interface Interface {
  readonly create: (input: {
    projectID: string
    sessionID: string
    title: string
    config: WorkflowConfig
  }) => Effect.Effect<ID, Error>
  readonly store: DagStore.Interface
  readonly pause: (dagID: string) => Effect.Effect<void, Error>
  readonly resume: (dagID: string) => Effect.Effect<void, Error>
  readonly cancel: (dagID: string) => Effect.Effect<void, Error>
  readonly complete: (dagID: string) => Effect.Effect<void, Error>
  readonly replan: (dagID: string, fragment: { nodes: NodeConfig[] }) => Effect.Effect<
    { cancel: string[]; restart: string[]; replace: string[]; add: string[]; ignore: string[] },
    Error
  >
  readonly nodeStarted: (dagID: string, nodeID: string, childSessionID: string) => Effect.Effect<void, Error>
  readonly nodeCompleted: (dagID: string, nodeID: string, output: unknown) => Effect.Effect<void, Error>
  readonly nodeFailed: (dagID: string, nodeID: string, reason: string, trigger: string) => Effect.Effect<void, Error>
  readonly nodeSkipped: (dagID: string, nodeID: string, reason: string) => Effect.Effect<void, Error>
  readonly nodeCancelled: (dagID: string, nodeID: string) => Effect.Effect<void, Error>
  readonly nodeRestarted: (dagID: string, nodeID: string, childSessionID: string) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Dag") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* DagStore.Service

    const guardWorkflow = Effect.fn("Dag.guardWorkflow")(function* (dagID: string, target: WorkflowStatus) {
      const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
      if (!wf) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      const current = wf.status as WorkflowStatus
      if (!getValidNextWorkflowStatuses(current).includes(target)) {
        return yield* Effect.fail(new InvalidTransitionError(dagID, current, target))
      }
    })

    const guardNode = Effect.fn("Dag.guardNode")(function* (nodeID: string, target: NodeStatus) {
      const node = yield* store.getNode(nodeID).pipe(Effect.orDie)
      if (!node) return yield* Effect.fail(new Error(`Node not found: ${nodeID}`))
      const current = node.status as NodeStatus
      if (!getValidNextNodeStatuses(current).includes(target)) {
        return yield* Effect.fail(new InvalidTransitionError(nodeID, current, target))
      }
    })

    const create = Effect.fn("Dag.create")(function* (input: {
      projectID: string
      sessionID: string
      title: string
      config: WorkflowConfig
    }) {
      const validation = validateRequiredNodes({
        nodes: input.config.nodes.map((n) => ({ id: n.id, depends_on: n.depends_on, required: n.required })),
      })
      if (!validation.valid) return yield* Effect.fail(new Error(`Invalid workflow config: ${validation.errors.join("; ")}`))

      const dagID = DagEvent.DagID.create()
      const ts = yield* DateTime.now
      yield* events.publish(DagEvent.WorkflowCreated, {
        dagID,
        projectID: input.projectID as never,
        sessionID: input.sessionID as never,
        title: input.title,
        config: JSON.stringify(input.config),
        status: "pending",
        timestamp: ts,
      })
      for (const node of input.config.nodes) {
        yield* events.publish(DagEvent.NodeRegistered, {
          dagID,
          nodeID: node.id as never,
          name: node.name,
          workerType: node.worker_type,
          dependsOn: node.depends_on.map((d) => d as never),
          required: node.required,
          model: node.model as never,
          timestamp: ts,
        })
      }
      const startTs = yield* DateTime.now
      yield* events.publish(DagEvent.WorkflowStarted, { dagID, timestamp: startTs })
      return dagID
    })

    const pause = Effect.fn("Dag.pause")(function* (dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.PAUSED)
      yield* events.publish(DagEvent.WorkflowPaused, { dagID: dagID as ID, timestamp: yield* DateTime.now })
    })
    const resume = Effect.fn("Dag.resume")(function* (dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.RUNNING)
      yield* events.publish(DagEvent.WorkflowResumed, { dagID: dagID as ID, timestamp: yield* DateTime.now })
    })
    const cancel = Effect.fn("Dag.cancel")(function* (dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.CANCELLED)
      yield* events.publish(DagEvent.WorkflowCancelled, { dagID: dagID as ID, timestamp: yield* DateTime.now })
    })
    const complete = Effect.fn("Dag.complete")(function* (dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.COMPLETED)
      const nodes = yield* store.getNodes(dagID)
      for (const node of nodes) {
        if (node.status === "pending" || node.status === "queued") {
          yield* events.publish(DagEvent.NodeSkipped, {
            dagID: dagID as ID,
            nodeID: node.id as never,
            reason: "agent_complete",
            timestamp: yield* DateTime.now,
          })
        }
      }
      yield* events.publish(DagEvent.WorkflowCompleted, { dagID: dagID as ID, durationMs: 0 as never, timestamp: yield* DateTime.now })
    })

    const replan = Effect.fn("Dag.replan")(function* (dagID: string, fragment: { nodes: NodeConfig[] }) {
      const nodes = yield* store.getNodes(dagID)
      const plan = planReplan(
        { nodes: nodes.map((n) => ({ id: n.id, status: n.status as never, depends_on: n.dependsOn })) },
        { nodes: fragment.nodes.map((n) => ({ id: n.id, depends_on: n.depends_on, restart: n.restart, cancel: n.cancel })) },
      )
      if (plan.errors.length > 0) return yield* Effect.fail(new Error(`Replan rejected: ${plan.errors.join("; ")}`))
      const fragmentById = new Map(fragment.nodes.map((n) => [n.id, n]))
      const nodeById = new Map(nodes.map((n) => [n.id, n]))
      for (const id of plan.add) {
        const node = fragmentById.get(id)!
        yield* events.publish(DagEvent.NodeRegistered, {
          dagID: dagID as ID,
          nodeID: id as never,
          name: node.name,
          workerType: node.worker_type,
          dependsOn: node.depends_on.map((d) => d as never),
          required: node.required,
          model: node.model as never,
          timestamp: yield* DateTime.now,
        })
      }
      for (const id of plan.cancel) {
        yield* events.publish(DagEvent.NodeCancelled, {
          dagID: dagID as ID,
          nodeID: id as never,
          timestamp: yield* DateTime.now,
        })
      }
      for (const id of plan.restart) {
        yield* events.publish(DagEvent.NodeRestarted, {
          dagID: dagID as ID,
          nodeID: id as never,
          childSessionID: (nodeById.get(id)?.childSessionId ?? "") as never,
          timestamp: yield* DateTime.now,
        })
      }
      yield* events.publish(DagEvent.WorkflowReplanned, {
        dagID: dagID as ID,
        added: plan.add.length as never,
        removed: plan.cancel.length as never,
        replaced: plan.replace.length as never,
        restarted: plan.restart.length as never,
        timestamp: yield* DateTime.now,
      })
      return { cancel: plan.cancel, restart: plan.restart, replace: plan.replace, add: plan.add, ignore: plan.ignore }
    })

    const nodeStarted = Effect.fn("Dag.nodeStarted")(function* (dagID: string, nodeID: string, childSessionID: string) {
      yield* guardNode(nodeID, NodeStatus.RUNNING)
      yield* events.publish(DagEvent.NodeStarted, { dagID: dagID as ID, nodeID: nodeID as never, childSessionID: childSessionID as never, timestamp: yield* DateTime.now })
    })
    const nodeCompleted = Effect.fn("Dag.nodeCompleted")(function* (dagID: string, nodeID: string, output: unknown) {
      yield* guardNode(nodeID, NodeStatus.COMPLETED)
      yield* events.publish(DagEvent.NodeCompleted, { dagID: dagID as ID, nodeID: nodeID as never, output, durationMs: 0 as never, timestamp: yield* DateTime.now })
    })
    const nodeFailed = Effect.fn("Dag.nodeFailed")(function* (dagID: string, nodeID: string, reason: string, trigger: string) {
      yield* guardNode(nodeID, NodeStatus.FAILED)
      yield* events.publish(DagEvent.NodeFailed, { dagID: dagID as ID, nodeID: nodeID as never, reason, trigger: trigger as never, timestamp: yield* DateTime.now })
    })
    const nodeSkipped = Effect.fn("Dag.nodeSkipped")(function* (dagID: string, nodeID: string, reason: string) {
      yield* guardNode(nodeID, NodeStatus.SKIPPED)
      yield* events.publish(DagEvent.NodeSkipped, { dagID: dagID as ID, nodeID: nodeID as never, reason: reason as never, timestamp: yield* DateTime.now })
    })
    const nodeCancelled = Effect.fn("Dag.nodeCancelled")(function* (dagID: string, nodeID: string) {
      yield* guardNode(nodeID, NodeStatus.SKIPPED)
      yield* events.publish(DagEvent.NodeCancelled, { dagID: dagID as ID, nodeID: nodeID as never, timestamp: yield* DateTime.now })
    })
    const nodeRestarted = Effect.fn("Dag.nodeRestarted")(function* (dagID: string, nodeID: string, childSessionID: string) {
      yield* guardNode(nodeID, NodeStatus.PENDING)
      yield* events.publish(DagEvent.NodeRestarted, { dagID: dagID as ID, nodeID: nodeID as never, childSessionID: childSessionID as never, timestamp: yield* DateTime.now })
    })

    return Service.of({ create, store, pause, resume, cancel, complete, replan, nodeStarted, nodeCompleted, nodeFailed, nodeSkipped, nodeCancelled, nodeRestarted })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(DagProjector.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, DagStore.node, DagProjector.node])

