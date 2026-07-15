export * as Dag from "./dag"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { DateTime, Effect, Layer, Context, Schema, Option } from "effect"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { DagProjector } from "@opencode-ai/core/dag/projector"
import { DagStore } from "@opencode-ai/core/dag/store"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { validateRequiredNodes } from "@opencode-ai/core/dag/core/required-validator"
import { buildGraph } from "@opencode-ai/core/dag/core/scheduling"
import { CycleError } from "@opencode-ai/core/dag/core/graph"
import { planReplan } from "@opencode-ai/core/dag/core/replan"
import {
  getValidNextWorkflowStatuses,
  getValidNextNodeStatuses,
  isWorkflowTerminalStatus,
  isNodeTerminalStatus,
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
  worker_config?: { timeout_ms?: number }
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
  max_concurrency?: number
  max_node_replan_attempts?: number
  max_total_nodes?: number
  nodes: NodeConfig[]
}

/**
 * Merge the current workflow config with a replan fragment, applying the plan
 * buckets (cancel / restart / replace / add) to produce the single-source-of-truth
 * post-replan config. Pure function — no I/O.
 *
 * - cancelled nodes are removed
 * - replaced nodes take the fragment's definition
 * - restarted (running) nodes take the fragment's definition (restart = new def)
 * - added nodes (new ids from fragment) are appended
 * - terminal + running-unchanged nodes keep their current definition
 */
export function computeMergedConfig(
  current: WorkflowConfig,
  fragment: { nodes: NodeConfig[] },
  plan: { cancel: string[]; restart: string[]; replace: string[]; add: string[] },
): WorkflowConfig {
  const fragmentById = new Map(fragment.nodes.map((n) => [n.id, n]))
  const cancelSet = new Set(plan.cancel)
  const restartSet = new Set(plan.restart)
  const replaceSet = new Set(plan.replace)
  const surviving = current.nodes
    .filter((n) => !cancelSet.has(n.id))
    .map((n) =>
      restartSet.has(n.id) || replaceSet.has(n.id)
        ? fragmentById.get(n.id) ?? n
        : n,
    )
  const added = plan.add.map((id) => fragmentById.get(id)).filter((n): n is NodeConfig => n !== undefined)
  return { ...current, nodes: [...surviving, ...added] }
}

const parseJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export function parseWorkflowConfig(raw: string): WorkflowConfig | undefined {
  const parsed = parseJsonOption(raw)
  if (Option.isNone(parsed) || typeof parsed.value !== "object" || parsed.value === null) return undefined
  return parsed.value as WorkflowConfig
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
  readonly fail: (dagID: string, reason: string) => Effect.Effect<void, Error>
  readonly replan: (dagID: string, fragment: { nodes: NodeConfig[] }) => Effect.Effect<
    { cancel: string[]; restart: string[]; replace: string[]; add: string[]; ignore: string[] },
    Error
  >
  readonly nodeStarted: (dagID: string, nodeID: string, childSessionID: string, deadlineMs?: number, wakeEligible?: boolean) => Effect.Effect<void, Error>
  readonly nodeCompleted: (dagID: string, nodeID: string, output: unknown) => Effect.Effect<void, Error>
  readonly nodeFailed: (dagID: string, nodeID: string, reason: string, trigger: string) => Effect.Effect<void, Error>
  readonly nodeSkipped: (dagID: string, nodeID: string, reason: string) => Effect.Effect<void, Error>
  readonly nodeCancelled: (dagID: string, nodeID: string) => Effect.Effect<void, Error>
  readonly nodeRestarted: (dagID: string, nodeID: string, childSessionID: string) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Dag") {}

const DEFAULT_MAX_NODE_REPLAN_ATTEMPTS = 5
const DEFAULT_MAX_TOTAL_NODES = 100

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

      // Full-graph cycle detection — validates ALL nodes (not just required),
      // so a cycle among optional nodes cannot silently create a zombie graph.
      // buildGraph throws CycleError via addEdge's wouldCreateCycle pre-check.
      const cyclePath: string[] | null = yield* Effect.sync(() => {
        try {
          const graph = buildGraph(
            input.config.nodes.map((n) => ({ id: n.id, dependsOn: n.depends_on, status: "pending" as const, required: n.required })),
          )
          return graph.hasCycle() ? (graph.findCycles()[0] ?? null) : null
        } catch (e) {
          if (e instanceof CycleError) return e.cycle
          throw e
        }
      })
      if (cyclePath) {
        return yield* Effect.fail(new Error(`Workflow config contains a dependency cycle: ${cyclePath.join(" -> ")}`))
      }

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
    // Publish terminal node events for any non-terminal nodes so the read
    // model stays consistent after workflow termination.  Running nodes get
    // NodeFailed (or NodeSkipped when failRunning=false); pending/queued
    // nodes always get NodeSkipped.  The projector's status guards make this
    // safe against races — a node that transitioned between the read and the
    // publish is silently left at its current status.
    const terminateNonTerminalNodes = Effect.fnUntraced(function* (dagID: string, skipReason: "agent_complete" | "workflow_cancelled" | "workflow_failed", failReason: string, failRunning: boolean) {
      const nodes = yield* store.getNodes(dagID)
      for (const node of nodes) {
        if (isNodeTerminalStatus(node.status as NodeStatus)) continue
        const ts = yield* DateTime.now
        if (failRunning && node.status === "running") {
          yield* events.publish(DagEvent.NodeFailed, {
            dagID: dagID as ID,
            nodeID: node.id as never,
            reason: failReason,
            trigger: "exec_failed" as never,
            timestamp: ts,
          })
        } else {
          yield* events.publish(DagEvent.NodeSkipped, {
            dagID: dagID as ID,
            nodeID: node.id as never,
            reason: skipReason,
            timestamp: ts,
          })
        }
      }
    })

    const cancel = Effect.fn("Dag.cancel")(function* (dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.CANCELLED)
      yield* events.publish(DagEvent.WorkflowCancelled, { dagID: dagID as ID, timestamp: yield* DateTime.now })
      yield* terminateNonTerminalNodes(dagID, "workflow_cancelled", "workflow_cancelled", false)
    })
    const complete = Effect.fn("Dag.complete")(function* (dagID: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.COMPLETED)
      yield* terminateNonTerminalNodes(dagID, "agent_complete", "", false)
      yield* events.publish(DagEvent.WorkflowCompleted, { dagID: dagID as ID, durationMs: 0 as never, timestamp: yield* DateTime.now })
    })

    const fail = Effect.fn("Dag.fail")(function* (dagID: string, reason: string) {
      yield* guardWorkflow(dagID, WorkflowStatus.FAILED)
      yield* events.publish(DagEvent.WorkflowFailed, { dagID: dagID as ID, reason, failedNodes: [] as never, timestamp: yield* DateTime.now })
      yield* terminateNonTerminalNodes(dagID, "workflow_failed", reason, true)
    })

    const replan = Effect.fn("Dag.replan")(function* (dagID: string, fragment: { nodes: NodeConfig[] }) {
      const wf = yield* store.getWorkflow(dagID)
      if (!wf) return yield* Effect.fail(new Error(`Workflow not found: ${dagID}`))
      const nodes = yield* store.getNodes(dagID)
      const plan = planReplan(
        { nodes: nodes.map((n) => ({ id: n.id, status: n.status as never, depends_on: n.dependsOn })) },
        { nodes: fragment.nodes.map((n) => ({ id: n.id, depends_on: n.depends_on, restart: n.restart, cancel: n.cancel })) },
      )
      if (plan.errors.length > 0) return yield* Effect.fail(new Error(`Replan rejected: ${plan.errors.join("; ")}`))

      const wfConfig = parseWorkflowConfig(wf.config)
      const maxReplanAttempts = wfConfig?.max_node_replan_attempts ?? DEFAULT_MAX_NODE_REPLAN_ATTEMPTS
      const maxTotalNodes = wfConfig?.max_total_nodes ?? DEFAULT_MAX_TOTAL_NODES

      // Enforce total node ceiling BEFORE any event publication so a rejected
      // replan leaves no durable side effects. Count ALL nodes ever registered
      // (cumulative lifetime) — terminal nodes still count toward the cap.
      if (nodes.length + plan.add.length > maxTotalNodes) {
        return yield* Effect.fail(new Error(`Total node ceiling exceeded: ${nodes.length} existing + ${plan.add.length} new > ${maxTotalNodes} max`))
      }

      const nodeById = new Map(nodes.map((n) => [n.id, n]))
      const ceilingBreached: string[] = []
      for (const id of plan.restart) {
        const existing = nodeById.get(id)
        if (existing && existing.replanAttempts >= maxReplanAttempts) {
          yield* nodeFailed(dagID, id, "replan attempt ceiling exceeded", "exec_failed").pipe(Effect.ignore)
          ceilingBreached.push(id)
        }
      }
      const effectiveRestart = plan.restart.filter((id) => !ceilingBreached.includes(id))

      const fragmentById = new Map(fragment.nodes.map((n) => [n.id, n]))
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
      // Replaced nodes: re-publish NodeRegistered so the projector upserts the
      // new definition (worker_type, model, depends_on) into the read-model row.
      for (const id of plan.replace) {
        const node = fragmentById.get(id)
        if (!node) continue
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
      for (const id of effectiveRestart) {
        yield* events.publish(DagEvent.NodeRestarted, {
          dagID: dagID as ID,
          nodeID: id as never,
          childSessionID: (nodeById.get(id)?.childSessionId ?? "") as never,
          timestamp: yield* DateTime.now,
        })
      }

      // #6: build effective plan that excludes ceiling-breached restarts
      const effectivePlan = { ...plan, restart: effectiveRestart }

      // Persist the merged config using the effective plan (without ceiling-breached restarts)
      if (wfConfig) {
        const mergedConfig = computeMergedConfig(wfConfig, fragment, effectivePlan)
        yield* events.publish(DagEvent.WorkflowConfigUpdated, {
          dagID: dagID as ID,
          config: JSON.stringify(mergedConfig),
          timestamp: yield* DateTime.now,
        })
      } else {
        yield* Effect.logWarning("Dag.replan: failed to parse current config JSON — node definitions from fragment may be lost", { dagID })
      }

      // #7: max_total_nodes check is non-atomic (read-then-publish). This is
      // acceptable because the ceiling is a fail-safe, not a correctness
      // invariant — concurrent replans slightly exceeding the limit is better
      // than serializing all replans. The projector's INSERT ON CONFLICT
      // ensures no duplicate node IDs.
      yield* events.publish(DagEvent.WorkflowReplanned, {
        dagID: dagID as ID,
        added: effectivePlan.add.length as never,
        removed: effectivePlan.cancel.length as never,
        replaced: effectivePlan.replace.length as never,
        restarted: effectivePlan.restart.length as never,
        timestamp: yield* DateTime.now,
      })
      return { cancel: effectivePlan.cancel, restart: effectivePlan.restart, replace: effectivePlan.replace, add: effectivePlan.add, ignore: effectivePlan.ignore }
    })

    const nodeStarted = Effect.fn("Dag.nodeStarted")(function* (dagID: string, nodeID: string, childSessionID: string, deadlineMs?: number, wakeEligible?: boolean) {
      yield* guardNode(nodeID, NodeStatus.RUNNING)
      yield* events.publish(DagEvent.NodeStarted, { dagID: dagID as ID, nodeID: nodeID as never, childSessionID: childSessionID as never, deadlineMs, wakeEligible, timestamp: yield* DateTime.now })
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
      yield* guardNode(nodeID, NodeStatus.FAILED)
      yield* events.publish(DagEvent.NodeCancelled, { dagID: dagID as ID, nodeID: nodeID as never, timestamp: yield* DateTime.now })
    })
    const nodeRestarted = Effect.fn("Dag.nodeRestarted")(function* (dagID: string, nodeID: string, childSessionID: string) {
      yield* guardNode(nodeID, NodeStatus.PENDING)
      yield* events.publish(DagEvent.NodeRestarted, { dagID: dagID as ID, nodeID: nodeID as never, childSessionID: childSessionID as never, timestamp: yield* DateTime.now })
    })

    return Service.of({ create, store, pause, resume, cancel, complete, fail, replan, nodeStarted, nodeCompleted, nodeFailed, nodeSkipped, nodeCancelled, nodeRestarted })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(DagProjector.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, DagStore.node, DagProjector.node])

