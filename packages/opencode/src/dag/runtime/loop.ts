export * as DagLoop from "./loop"

import { Effect, Layer, Context, Stream, Scope, Semaphore, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowRuntime, type SchedulingNode } from "@opencode-ai/core/dag/core/scheduling"
import { isWorkflowTerminalStatus } from "@opencode-ai/core/dag/core/types"
import { Dag, type WorkflowConfig, parseWorkflowConfig } from "../dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { resolveTemplate } from "../templates/resolve"
import { spawnNode, attachNodeCompletionWatcher } from "./spawn"
import { evaluateCondition, resolveInputMapping } from "./eval"
import { reconcileWorkflow, makeSessionStatusChecker } from "./recovery"

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DagLoop") {}

export const SUCCESS_TERMINAL = new Set(["completed", "skipped", "aborted", "cancelled"])

export function toSchedulingNodes(nodes: readonly DagStore.NodeRow[]): SchedulingNode[] {
  return nodes.map((n) => ({
    id: n.id,
    dependsOn: n.dependsOn,
    required: n.required,
    status: SUCCESS_TERMINAL.has(n.status)
      ? ("satisfied" as const)
      : n.status === "failed"
        ? ("unsatisfied" as const)
        : n.status === "running"
          ? ("running" as const)
          : ("pending" as const),
  }))
}

interface WorkflowEntry {
  runtime: WorkflowRuntime
  semaphore: Semaphore.Semaphore
  evalLock: Semaphore.Semaphore
  parentSessionID: string
  config: WorkflowConfig | undefined
  fibers: Map<string, Fiber.Fiber<unknown, unknown>>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* DagStore.Service
    const dag = yield* Dag.Service
    const agentSvc = yield* Agent.Service
    const sessionSvc = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service

    const state = yield* InstanceState.make(
      Effect.fn("DagLoop.state")(function* (ctx) {
        const scope = yield* Scope.Scope
        const runtimes = new Map<string, WorkflowEntry>()

        const spawnReady = Effect.fn("DagLoop.spawnReady")(function* (dagID: string) {
          const entry = runtimes.get(dagID)
          if (!entry) return
          const ready = entry.runtime.getReadyNodes()
          for (const nodeID of ready) {
            const node = yield* store.getNode(nodeID)
            if (!node) continue
            const nodeConfig = entry.config?.nodes.find((n) => n.id === nodeID)

            if (nodeConfig?.condition) {
              const allNodes = yield* store.getNodes(dagID)
              const outputs: Record<string, unknown> = {}
              for (const dep of node.dependsOn) {
                const depNode = allNodes.find((n) => n.id === dep)
                if (depNode) outputs[dep] = { output: depNode.output }
              }
              if (!evaluateCondition(nodeConfig.condition, outputs)) {
                entry.runtime.markSatisfied(nodeID)
                yield* dag.nodeSkipped(dagID, nodeID, "condition_false").pipe(Effect.ignore)
                continue
              }
            }

            const promptParts: { type: "text"; text: string }[] = []

            let resolvedMapping: Record<string, unknown> = {}
            if (nodeConfig?.input_mapping) {
              const allNodes = yield* store.getNodes(dagID)
              resolvedMapping = resolveInputMapping(nodeConfig.input_mapping, (depId) => {
                const depNode = allNodes.find((n) => n.id === depId)
                return depNode?.output ?? null
              })
            }

            let promptText: string
            if (nodeConfig?.prompt_template) {
              const resolved = yield* resolveTemplate(nodeConfig.prompt_template, ctx.directory).pipe(
                Effect.tap((text) =>
                  text.trim() === ""
                    ? Effect.logWarning("DAG node resolved template is empty", { dagID, nodeID })
                    : Effect.void,
                ),
                Effect.map((text) => ({ ok: true as const, text })),
                Effect.catch((err: unknown) =>
                  Effect.gen(function* () {
                    yield* dag.nodeFailed(dagID, nodeID, `Template resolution failed: ${String(err)}`, "exec_failed").pipe(Effect.ignore)
                    return { ok: false as const, text: "" }
                  }),
                ),
              )
              if (!resolved.ok) {
                entry.runtime.markUnsatisfied(nodeID)
                continue
              }
              promptText = resolved.text
            } else {
              promptText = node.name
            }

            for (const [key, value] of Object.entries(resolvedMapping)) {
              if (value !== null && value !== undefined) {
                promptText = promptText.replaceAll(`{{${key}}}`, String(value))
              }
            }

            promptParts.push({ type: "text", text: promptText })

            if (Object.keys(resolvedMapping).length > 0) {
              promptParts.push({ type: "text", text: `\n\nContext:\n${JSON.stringify(resolvedMapping, null, 2)}` })
            }

            entry.runtime.markRunning(nodeID)
            const oldFiber = entry.fibers.get(nodeID)
            if (oldFiber) yield* Fiber.interrupt(oldFiber).pipe(Effect.ignore)
            yield* spawnNode(entry.semaphore, {
              dagID,
              nodeID,
              node,
              parentSessionID: entry.parentSessionID,
              promptParts,
              outputSchema: nodeConfig?.output_schema as Record<string, unknown> | undefined,
            }).pipe(
              Effect.tap((result) => Effect.sync(() => entry.fibers.set(nodeID, result.fiber))),
              Effect.provideService(Dag.Service, dag),
              Effect.provideService(Agent.Service, agentSvc),
              Effect.provideService(Session.Service, sessionSvc),
              Effect.provideService(SessionPrompt.Service, promptSvc),
              Effect.catchCause((cause) =>
                dag.nodeFailed(dagID, nodeID, String(cause), "exec_failed"),
              ),
              Effect.ignore,
            )
          }
        })

        const checkCompletion = Effect.fn("DagLoop.checkCompletion")(function* (dagID: string) {
          const entry = runtimes.get(dagID)
          if (!entry) return
          if (!entry.runtime.isComplete()) return
          const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
          if (wf && isWorkflowTerminalStatus(wf.status as never)) return
          if (entry.runtime.hasRequiredFailure()) yield* dag.cancel(dagID)
          else yield* dag.complete(dagID)
        })

        const checkSessionStatus = makeSessionStatusChecker(sessionSvc)

        const recoverWorkflow = Effect.fn("DagLoop.recoverWorkflow")(function* (wf: DagStore.WorkflowRow) {
          const dagID = wf.id
          yield* reconcileWorkflow(dagID, checkSessionStatus).pipe(
            Effect.provideService(Dag.Service, dag),
            Effect.ignore,
          )
          const config = parseWorkflowConfig(wf.config)
          const nodes = yield* store.getNodes(dagID)
          const maxConcurrency = Math.max(1, config?.max_concurrency ?? 4)
          const runtime = new WorkflowRuntime(toSchedulingNodes(nodes), maxConcurrency)
          const semaphore = Semaphore.makeUnsafe(maxConcurrency)
          const isPaused = wf.status === "paused"
          if (isPaused) runtime.setPaused(true)
          const entry: WorkflowEntry = { runtime, semaphore, evalLock: Semaphore.makeUnsafe(1), parentSessionID: wf.sessionId, config, fibers: new Map() }
          runtimes.set(dagID, entry)
          // Re-attach completion watchers for running nodes whose child sessions
          // may still be active. Without this, no fiber observes the child
          // session's terminal event and the node stays stuck in running.
          for (const node of nodes) {
            if (node.status !== "running" || !node.childSessionId) continue
            const fiber = yield* attachNodeCompletionWatcher(dagID, node.id, node.childSessionId, checkSessionStatus, entry.semaphore).pipe(
              Effect.provideService(Dag.Service, dag),
            )
            entry.fibers.set(node.id, fiber)
          }
          if (!isPaused) {
            yield* spawnReady(dagID)
            yield* checkCompletion(dagID)
          }
        })

        const runningWfs = yield* store.listByStatus("running").pipe(Effect.orDie)
        const pausedWfs = yield* store.listByStatus("paused").pipe(Effect.orDie)
        for (const wf of [...runningWfs, ...pausedWfs]) {
          yield* recoverWorkflow(wf).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DagLoop recovery failed for workflow", { dagID: wf.id, cause }),
            ),
          )
        }

        yield* events.subscribe(DagEvent.WorkflowStarted).pipe(
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              if (runtimes.has(dagID)) return
              const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
              if (!wf) return
              const config = parseWorkflowConfig(wf.config)
              const nodes = yield* store.getNodes(dagID)
              const maxConcurrency = Math.max(1, config?.max_concurrency ?? 4)
              const runtime = new WorkflowRuntime(toSchedulingNodes(nodes), maxConcurrency)
              const semaphore = Semaphore.makeUnsafe(maxConcurrency)
              runtimes.set(dagID, { runtime, semaphore, evalLock: Semaphore.makeUnsafe(1), parentSessionID: wf.sessionId, config, fibers: new Map() })
              yield* spawnReady(dagID)
              yield* checkCompletion(dagID)
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped,
        )

        for (const def of [DagEvent.NodeCompleted, DagEvent.NodeSkipped]) {
          yield* events.subscribe(def).pipe(
            Stream.filter((e) => runtimes.has(e.data.dagID as string)),
            Stream.runForEach((evt) =>
              Effect.gen(function* () {
                const dagID = evt.data.dagID as string
                const entry = runtimes.get(dagID)
                if (!entry) return
                yield* entry.evalLock.withPermits(1)(
                  Effect.gen(function* () {
                    entry.fibers.delete(evt.data.nodeID as string)
                    entry.runtime.markSatisfied(evt.data.nodeID as string)
                    yield* spawnReady(dagID)
                    yield* checkCompletion(dagID)
                  }),
                )
              }).pipe(Effect.ignore),
            ),
            Effect.forkScoped,
          )
        }

        yield* events.subscribe(DagEvent.NodeCancelled).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              const nodeID = evt.data.nodeID as string
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  const fiber = entry.fibers.get(nodeID)
                  if (fiber) {
                    yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                    entry.fibers.delete(nodeID)
                  }
                  entry.runtime.markSatisfied(nodeID)
                  yield* spawnReady(dagID)
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped,
        )

        yield* events.subscribe(DagEvent.NodeFailed).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  entry.fibers.delete(evt.data.nodeID as string)
                  entry.runtime.markUnsatisfied(evt.data.nodeID as string)
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped,
        )

        yield* events.subscribe(DagEvent.WorkflowPaused).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const entry = runtimes.get(evt.data.dagID as string)
              if (!entry) return
              yield* entry.evalLock.withPermits(1)(Effect.sync(() => entry.runtime.setPaused(true)))
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped,
        )

        yield* events.subscribe(DagEvent.WorkflowResumed).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  entry.runtime.setPaused(false)
                  yield* spawnReady(dagID)
                }),
              )
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped,
        )

        yield* events.subscribe(DagEvent.WorkflowReplanned).pipe(
          Stream.filter((e) => runtimes.has(e.data.dagID as string)),
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              const entry = runtimes.get(dagID)
              if (!entry) return
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
                  if (wf) entry.config = parseWorkflowConfig(wf.config)
                  const nodes = yield* store.getNodes(dagID)
                  entry.runtime.rebuildGraph(toSchedulingNodes(nodes))
                  yield* spawnReady(dagID)
                  yield* checkCompletion(dagID)
                }),
              )
            }).pipe(Effect.ignore),
          ),
          Effect.forkScoped,
        )

        for (const def of [DagEvent.WorkflowCompleted, DagEvent.WorkflowFailed, DagEvent.WorkflowCancelled]) {
          yield* events.subscribe(def).pipe(
            Stream.filter((e) => runtimes.has(e.data.dagID as string)),
            Stream.runForEach((evt) =>
              Effect.gen(function* () {
                const dagID = evt.data.dagID as string
                const entry = runtimes.get(dagID)
                if (entry) {
                  for (const fiber of entry.fibers.values()) {
                    yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                  }
                  entry.fibers.clear()
                }
                runtimes.delete(dagID)
              }).pipe(Effect.ignore),
            ),
            Effect.forkScoped,
          )
        }

        return {}
      }),
    )

    const init = Effect.fn("DagLoop.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(DagStore.defaultLayer),
  Layer.provide(Dag.defaultLayer),
  Layer.provide(Agent.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(SessionPrompt.defaultLayer),
)

export const node = LayerNode.make(layer, [
  EventV2Bridge.node,
  DagStore.node,
  Dag.node,
  Agent.node,
  Session.node,
  SessionPrompt.node,
])
