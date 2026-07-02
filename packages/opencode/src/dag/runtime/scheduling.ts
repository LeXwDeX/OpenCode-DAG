/**
 * DAG event-driven scheduling — replaces the old while(true)+sleep(100) polling.
 *
 * Subscribes to node terminal events (completed/failed/skipped/cancelled) via
 * EventV2 and re-evaluates readiness after each transition. When a node becomes
 * ready and the concurrency budget allows, spawnNode is called.
 *
 * The scheduling loop is per-workflow: each running workflow gets its own
 * subscription + semaphore.
 *
 * Bug fixes applied:
 * - `done` Set now only holds SUCCESS-terminal nodes (completed/skipped/aborted/
 *   cancelled). `failed` nodes are tracked separately in `failed` so that
 *   DependencyGraph.getExecutableNodes() correctly treats failed deps as
 *   unsatisfied (not as completed), and maybeComplete distinguishes success
 *   from failure.
 * - The 4 terminal-event subscriptions are forked in PARALLEL (one fiber each)
 *   rather than serially awaited — the old `for` loop only ever ran the first
 *   subscribe because the stream never completed.
 */

import { Effect, Semaphore, Stream } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { Dag } from "../dag"
import type { WorkflowConfig } from "../dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import type { DagStore } from "@opencode-ai/core/dag/store"
import { DependencyGraph } from "@opencode-ai/core/dag/core/graph"
import { resolveTemplate } from "../templates/resolve"
import { spawnNode, type NodeSpawnInput } from "./spawn"

export interface SchedulingDeps {
  readonly dag: Dag.Interface
  readonly store: DagStore.Interface
  readonly promptOps: NodeSpawnInput["promptOps"]
  readonly parentSessionID: string
  readonly parentModelID: string
  readonly parentProviderID: string
  /** Project root for `.opencode/dag-prompts/` template resolution. */
  readonly projectDir: string
}

/** Statuses that satisfy a dependency (downstream can proceed). */
const SUCCESS_TERMINAL = new Set(["completed", "skipped", "aborted", "cancelled"])
/** Statuses that do NOT satisfy a dependency (downstream is blocked/orphaned). */
const FAILED_TERMINAL = new Set(["failed"])
const ALL_TERMINAL = new Set([...SUCCESS_TERMINAL, ...FAILED_TERMINAL])

/**
 * Start scheduling for a workflow. Returns an Effect that runs until the workflow
 * reaches a terminal state. Fork-detach it.
 *
 * Service requirements are carried through the Effect type: EventV2.Service (for
 * subscription) + Dag.Service + Agent.Service + Session.Service (for spawn).
 */
export function startScheduling(
  dagID: string,
  maxConcurrency: number,
  deps: SchedulingDeps,
): Effect.Effect<void, Error, EventV2.Service | Dag.Service | Agent.Service | Session.Service> {
  return Effect.gen(function* () {
    const semaphore = Semaphore.makeUnsafe(maxConcurrency)
    const nodes = yield* deps.store.getNodes(dagID)
    const graph = buildGraph(nodes)

    /** Nodes whose dependencies are satisfied (success-terminal only). */
    const done = new Set<string>()
    /** Nodes that failed — tracked so maybeComplete can detect required-failure. */
    const failed = new Set<string>()
    const running = new Set<string>()

    for (const node of nodes) {
      if (SUCCESS_TERMINAL.has(node.status)) done.add(node.id)
      else if (FAILED_TERMINAL.has(node.status)) failed.add(node.id)
    }

    // Initial spawn pass
    yield* spawnReadyNodes(dagID, graph, done, running, semaphore, deps)

    // Subscribe to terminal events and re-evaluate on each.
    // Each event type gets its own forked fiber — they run in parallel so
    // no single long-lived stream blocks the others.
    const events = yield* EventV2.Service
    const terminalEventTypes = [DagEvent.NodeCompleted, DagEvent.NodeFailed, DagEvent.NodeSkipped, DagEvent.NodeCancelled]

    for (const evt of terminalEventTypes) {
      yield* Effect.forkDetach(
        events.subscribe(evt).pipe(
          Stream.filter((e) => e.data.dagID === (dagID as never)),
          Stream.runForEach(() =>
            Effect.gen(function* () {
              // Re-read node statuses from store to get the latest state
              const currentNodes = yield* deps.store.getNodes(dagID)
              done.clear()
              failed.clear()
              for (const n of currentNodes) {
                if (SUCCESS_TERMINAL.has(n.status)) {
                  done.add(n.id)
                  running.delete(n.id)
                } else if (FAILED_TERMINAL.has(n.status)) {
                  failed.add(n.id)
                  running.delete(n.id)
                }
              }
              yield* spawnReadyNodes(dagID, graph, done, running, semaphore, deps)
              yield* maybeComplete(dagID, graph, done, failed, currentNodes, deps)
            }),
          ),
        ),
      )
    }
  })
}

function buildGraph(nodes: DagStore.NodeRow[]): DependencyGraph {
  const graph = new DependencyGraph()
  for (const node of nodes) graph.addNode(node.id)
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (graph.hasNode(dep)) graph.addEdge(node.id, dep)
    }
  }
  return graph
}

function spawnReadyNodes(
  dagID: string,
  graph: DependencyGraph,
  done: Set<string>,
  running: Set<string>,
  semaphore: Semaphore.Semaphore,
  deps: SchedulingDeps,
): Effect.Effect<void, Error, Dag.Service | Agent.Service | Session.Service> {
  return Effect.gen(function* () {
    // Load the workflow config once to resolve prompt templates for all nodes
    // in this pass. The config column holds a JSON-serialized WorkflowConfig.
    const wf = yield* deps.store.getWorkflow(dagID).pipe(Effect.orDie)
    const config: WorkflowConfig | undefined = wf ? (JSON.parse(wf.config) as WorkflowConfig) : undefined
    const nodeConfigs = new Map((config?.nodes ?? []).map((n) => [n.id, n]))

    // getExecutableNodes checks if all deps are in `done` (success-terminal).
    // A failed dep is NOT in `done`, so downstream nodes won't be spawned —
    // they'll be caught by maybeComplete's orphan/required-fail logic instead.
    const executable = graph.getExecutableNodes(done)
    for (const nodeID of executable) {
      if (done.has(nodeID) || running.has(nodeID)) continue
      const node = yield* deps.store.getNode(nodeID)
      if (!node) continue

      // Resolve the prompt template for this node; fall back to node name if
      // the template is missing or fails to resolve (never spawn an empty prompt).
      const nodeConfig = nodeConfigs.get(nodeID)
      let promptText = node.name
      if (nodeConfig?.prompt_template) {
        promptText = yield* resolveTemplate(nodeConfig.prompt_template, deps.projectDir).pipe(
          Effect.catch(() => Effect.succeed(node.name)),
        )
      }

      running.add(nodeID)
      yield* spawnNode(semaphore, {
        dagID,
        nodeID,
        node,
        parentSessionID: deps.parentSessionID,
        parentModelID: deps.parentModelID,
        parentProviderID: deps.parentProviderID,
        promptParts: [{ type: "text", text: promptText }] as never,
        promptOps: deps.promptOps,
      }).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* deps.dag.nodeFailed(dagID, nodeID, String(cause), "exec_failed")
          }),
        ),
      )
    }
  })
}

function maybeComplete(
  dagID: string,
  graph: DependencyGraph,
  done: Set<string>,
  failed: Set<string>,
  nodes: DagStore.NodeRow[],
  deps: SchedulingDeps,
): Effect.Effect<void, Error, Dag.Service> {
  return Effect.gen(function* () {
    const allNodeIds = graph.getAllNodes()
    const allDone = allNodeIds.every((id) => done.has(id) || failed.has(id))
    if (!allDone) return

    // A required node failed → the workflow fails (not completes).
    const requiredFailed = nodes.some((n) => n.required && failed.has(n.id))
    if (requiredFailed) {
      yield* deps.dag.cancel(dagID)
    } else {
      yield* deps.dag.complete(dagID)
    }
  })
}
