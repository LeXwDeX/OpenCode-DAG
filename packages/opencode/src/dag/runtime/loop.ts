export * as DagLoop from "./loop"

import { Effect, Layer, Context, Stream, Semaphore, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { DagStore } from "@opencode-ai/core/dag/store"
import { WorkflowRuntime, type SchedulingNode } from "@opencode-ai/core/dag/core/scheduling"
import { isWorkflowTerminalStatus } from "@opencode-ai/core/dag/core/types"
import { Dag, type WorkflowConfig, parseWorkflowConfig } from "../dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { resolveTemplate } from "../templates/resolve"
import { spawnNode } from "./spawn"
import { registerCaptureSlot } from "./capture"
import { evaluateCondition, resolveInputMapping } from "./eval"
import { reconcileWorkflow, makeSessionStatusChecker } from "./recovery"

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DagLoop") {}

export const SUCCESS_TERMINAL = new Set(["completed", "skipped", "aborted"])

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
        const runtimes = new Map<string, WorkflowEntry>()
        const wakeInFlight = new Set<string>()
        const wakePending = new Set<string>()

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
              const condResult = evaluateCondition(nodeConfig.condition, outputs)
              if (!condResult.ok) {
                yield* dag.nodeFailed(dagID, nodeID, condResult.error, "exec_failed").pipe(Effect.ignore)
                entry.runtime.markUnsatisfied(nodeID)
                continue
              }
              if (!condResult.value) {
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

            if (nodeConfig?.output_schema) {
              promptParts.push({
                type: "text",
                text: `\n\nYou MUST call the submit_result tool with a JSON payload matching this schema before ending your turn:\n${JSON.stringify(nodeConfig.output_schema, null, 2)}`,
              })
            }

            entry.runtime.markRunning(nodeID)
            const oldFiber = entry.fibers.get(nodeID)
            yield* abortChild(nodeID, node.childSessionId).pipe(Effect.ignore)
            if (oldFiber) yield* Fiber.interrupt(oldFiber).pipe(Effect.ignore)
            yield* spawnNode(entry.semaphore, {
              dagID,
              nodeID,
              node,
              parentSessionID: entry.parentSessionID,
              promptParts,
              outputSchema: nodeConfig?.output_schema as Record<string, unknown> | undefined,
              timeoutMs: nodeConfig?.worker_config?.timeout_ms,
              reportToParent: nodeConfig?.report_to_parent,
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

        // Best-effort abort of a durable child session, independent of whether
        // a local wrapper fiber still exists.  Used at every replacement,
        // cancellation, failure, and workflow-terminal cleanup site.
        const abortChild = Effect.fnUntraced(function* (nodeID: string, childSessionId: string | null) {
          if (!childSessionId) return
          yield* promptSvc.cancel(childSessionId as never).pipe(Effect.ignore)
        })

        const recoverWorkflow = Effect.fn("DagLoop.recoverWorkflow")(function* (wf: DagStore.WorkflowRow) {
          const dagID = wf.id
          const config = parseWorkflowConfig(wf.config)
          yield* reconcileWorkflow(dagID, checkSessionStatus, (sid) => promptSvc.cancel(sid as never), config).pipe(
            Effect.provideService(Dag.Service, dag),
            Effect.ignore,
          )
          const nodes = yield* store.getNodes(dagID)
          const maxConcurrency = Math.max(1, config?.max_concurrency ?? 5)
          const runtime = new WorkflowRuntime(toSchedulingNodes(nodes), maxConcurrency)
          const semaphore = Semaphore.makeUnsafe(maxConcurrency)
          const isPaused = wf.status === "paused"
          if (isPaused) runtime.setPaused(true)
          const entry: WorkflowEntry = { runtime, semaphore, evalLock: Semaphore.makeUnsafe(1), parentSessionID: wf.sessionId, config, fibers: new Map() }
          runtimes.set(dagID, entry)
          // Re-register capture slots for running nodes whose child sessions
          // may still call submit_result. No persistent watcher is forked
          // (by design — see dag-module-cleanup design D1). reconcileWorkflow
          // (above) already published terminal events for settled sessions.
          // Still-active sessions whose fibers died with the crashed process
          // remain running until a post-crash continuation mechanism is built.
          for (const node of nodes) {
            if (node.status !== "running" || !node.childSessionId) continue
            const nodeConfig = entry.config?.nodes.find((n) => n.id === node.id)
            if (nodeConfig?.output_schema && node.childSessionId) {
              registerCaptureSlot(node.childSessionId, nodeConfig.output_schema as Record<string, unknown>)
            }
          }
          if (!isPaused) {
            yield* entry.evalLock.withPermits(1)(
              Effect.gen(function* () {
                yield* spawnReady(dagID)
                yield* checkCompletion(dagID)
              }),
            )
          }
        })

        yield* events.subscribe(DagEvent.WorkflowStarted).pipe(
          Stream.runForEach((evt) =>
            Effect.gen(function* () {
              const dagID = evt.data.dagID as string
              if (runtimes.has(dagID)) return
              const wf = yield* store.getWorkflow(dagID).pipe(Effect.orDie)
              if (!wf) return
              const config = parseWorkflowConfig(wf.config)
              const nodes = yield* store.getNodes(dagID)
              const maxConcurrency = Math.max(1, config?.max_concurrency ?? 5)
              const runtime = new WorkflowRuntime(toSchedulingNodes(nodes), maxConcurrency)
              const semaphore = Semaphore.makeUnsafe(maxConcurrency)
              const entry: WorkflowEntry = { runtime, semaphore, evalLock: Semaphore.makeUnsafe(1), parentSessionID: wf.sessionId, config, fibers: new Map() }
              runtimes.set(dagID, entry)
              yield* entry.evalLock.withPermits(1)(
                Effect.gen(function* () {
                  yield* spawnReady(dagID)
                  yield* checkCompletion(dagID)
                }),
              )
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
                // P1-2: trigger wake check directly on node terminal —
                // the parent session may already be idle (no new idle event
                // will fire), so we can't rely on the idle subscription alone.
                yield* tryDeliverWake(entry.parentSessionID).pipe(Effect.ignore)
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
                  const node = yield* store.getNode(nodeID)
                  yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                  if (fiber) {
                    yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                    entry.fibers.delete(nodeID)
                  }
                  entry.runtime.markUnsatisfied(nodeID)
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
                    const nid = evt.data.nodeID as string
                    const fiber = entry.fibers.get(nid)
                    entry.fibers.delete(nid)
                    // #3: only markUnsatisfied if the runtime still tracks this
                    // node as non-terminal. A stale NodeFailed event (e.g. from
                    // a replan-ceiling check after the node already completed)
                    // would incorrectly flip a satisfied node to unsatisfied.
                    if (entry.runtime.isActive(nid)) {
                      const node = yield* store.getNode(nid)
                      yield* abortChild(nid, node?.childSessionId ?? null).pipe(Effect.ignore)
                      if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                      entry.runtime.markUnsatisfied(nid)
                    }
                    yield* checkCompletion(dagID)
                  }),
                )
                yield* tryDeliverWake(entry.parentSessionID).pipe(Effect.ignore)
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
                const parentSessionID = entry?.parentSessionID
                if (entry) {
                  yield* entry.evalLock.withPermits(1)(
                    Effect.gen(function* () {
                      for (const [nodeID, fiber] of entry.fibers) {
                        const node = yield* store.getNode(nodeID)
                        yield* abortChild(nodeID, node?.childSessionId ?? null).pipe(Effect.ignore)
                        yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
                      }
                      entry.fibers.clear()
                      runtimes.delete(dagID)
                    }),
                  )
                }
                // P1-6: trigger wake on workflow terminal so the parent
                // learns the final outcome even if no idle event fires.
                if (parentSessionID) {
                  yield* tryDeliverWake(parentSessionID).pipe(Effect.ignore)
                }
              }).pipe(Effect.ignore),
            ),
            Effect.forkScoped,
          )
        }

        // ── D2+D7: Autonomous wake — extracted as reusable function ────
        // Called from both the idle-event subscription AND node-terminal
        // event handlers, so a wake fires even when the parent session is
        // already idle (P1-2 fix).

        let tryDeliverWake: (sessionID: string) => Effect.Effect<void> = () => Effect.void
        tryDeliverWake = Effect.fn("DagLoop.tryDeliverWake")(function* (sessionID: string) {
          if (wakeInFlight.has(sessionID)) {
            wakePending.add(sessionID)
            return
          }
          wakeInFlight.add(sessionID)
          // #4: drain loop — deliver ALL pending unreported rows, not just one.
          // Each iteration delivers at most one to keep messages coherent,
          // then re-checks for additional rows.
          try {
            const deliveredDagIDs = new Set<string>()
            for (;;) {
              const unreportedNodes = yield* store.getUnreportedWakeNodes(sessionID).pipe(
                Effect.catch(() => Effect.succeed([] as DagStore.NodeRow[])),
              )
              const unreportedWorkflows = yield* store.getUnreportedWakeWorkflows(sessionID).pipe(
                Effect.catch(() => Effect.succeed([] as DagStore.WorkflowRow[])),
              )
              const hasUnreported = unreportedNodes.length > 0 || unreportedWorkflows.length > 0

              if (!hasUnreported) {
                // A terminal event can commit between either query. Coalesce
                // its trigger into another durable read before declaring idle.
                if (wakePending.delete(sessionID)) continue
                // D7: if we delivered at least one wake in this call and no more
                // unreported rows remain, check for orchestrator-unresponsive.
                // #5: scoped per-workflow — only fail the workflow whose node
                // was reported, not any other workflow under the same session.
                // Skip paused workflows (they intentionally have no ready nodes).
                if (deliveredDagIDs.size > 0) {
                  for (const dagID of deliveredDagIDs) {
                    const entry = runtimes.get(dagID)
                    if (!entry) continue
                    if (entry.runtime.isPaused()) continue
                    if (entry.runtime.hasRunning()) continue
                    if (entry.runtime.getReadyNodes().length > 0) continue
                    if (entry.runtime.isComplete()) continue
                    yield* dag.fail(dagID, "orchestrator_unresponsive").pipe(Effect.ignore)
                  }
                }
                return
              }

              // Preemption guard (task 3.3): abort if fresher user message exists
              const msgs = yield* sessionSvc.messages({ sessionID: SessionID.make(sessionID), limit: 20 }).pipe(Effect.catch(() => Effect.succeed([])))
              let lastUserAt = -1
              let lastAsstAt = -1
              for (const m of msgs) {
                const t = m.info.time?.created
                if (typeof t !== "number") continue
                if (m.info.role === "user" && t > lastUserAt) lastUserAt = t
                else if (m.info.role === "assistant" && t > lastAsstAt) lastAsstAt = t
              }
              if (lastUserAt > lastAsstAt) return

              // D6: prioritize node-level wake, then workflow-terminal wake
              const targetNode = unreportedNodes[0]
              const targetWorkflow = targetNode ? undefined : unreportedWorkflows[0]
              if (!targetNode && !targetWorkflow) return

              const summary = targetNode
                ? `[DAG Node Result] Node "${targetNode.name}" ${targetNode.status}: ${typeof targetNode.output === "string" ? targetNode.output.slice(0, 500) : targetNode.errorReason ?? "(no output)"}\n\nYou MUST act on this workflow in this turn (workflow tool: extend / control replan / complete / cancel). If this turn ends with the workflow stalled and no action taken, it will be failed with reason "orchestrator_unresponsive".`
                : `[DAG Workflow ${targetWorkflow!.status}] Workflow "${targetWorkflow!.title}" has reached terminal status.`

              // Persist wake_reported AFTER successful delivery only.
              // A failure stays durable for a later idle event or restart scan;
              // it must not spin synchronously on the same row.
              const didDeliver = yield* promptSvc.prompt({
                sessionID: SessionID.make(sessionID),
                parts: [{ type: "text", text: summary }],
              }).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (targetNode) {
                      yield* store.markNodeWakeReported(targetNode.id)
                      deliveredDagIDs.add(targetNode.workflowId)
                    }
                    if (targetWorkflow) {
                      yield* store.markWorkflowWakeReported(targetWorkflow.id)
                      deliveredDagIDs.add(targetWorkflow.id)
                    }
                  }),
                ),
                Effect.as(true),
                Effect.catchCause(() =>
                  Effect.logWarning("DAG wake delivery failed", { sessionID }).pipe(Effect.as(false)),
                ),
              )
              if (!didDeliver) return
              // Loop continues to drain remaining unreported rows
            }
          } finally {
            const retry = wakePending.delete(sessionID)
            wakeInFlight.delete(sessionID)
            if (retry) yield* tryDeliverWake(sessionID)
          }
        })

        // Idle-event subscription: the primary wake trigger
        yield* events.subscribe(SessionStatusEvent.Status).pipe(
          Stream.filter((evt) => evt.data.status.type === "idle"),
          Stream.runForEach((evt) =>
            tryDeliverWake(evt.data.sessionID as string).pipe(Effect.ignore),
          ),
          Effect.forkScoped,
        )

        // Install all live event handlers before spawning recovery watchers so
        // a child that settles immediately cannot leave the runtime stale.
        const runningWfs = yield* store.listByStatus("running").pipe(Effect.orDie)
        const pausedWfs = yield* store.listByStatus("paused").pipe(Effect.orDie)
        for (const wf of [...runningWfs, ...pausedWfs]) {
          yield* recoverWorkflow(wf).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DagLoop recovery failed for workflow", { dagID: wf.id, cause }),
            ),
          )
        }

        // Terminal rows can survive a process crash after projection but before
        // parent delivery. Re-enter the normal serialized drain for every
        // affected parent session without waiting for a new status event.
        const pendingWakeSessions = yield* store.getSessionsWithUnreportedWakes().pipe(
          Effect.catch(() => Effect.succeed([] as string[])),
        )
        for (const sessionID of pendingWakeSessions) {
          yield* tryDeliverWake(sessionID).pipe(Effect.forkScoped)
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
