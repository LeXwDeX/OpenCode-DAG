import { describe, expect, it } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { DagStore } from "@opencode-ai/core/dag/store"
import { DagEvent } from "@opencode-ai/schema/dag-event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Parameters, WorkflowTool } from "@/tool/workflow"
import { testEffect } from "../lib/effect"

const projectID = "project_test"
const published: Array<{ type: string; data: unknown }> = []
const store = Layer.mock(DagStore.Service, {
  getWorkflow: (id: string) =>
    Effect.succeed(
      id === "dag_status"
        ? {
            id,
            projectId: projectID,
            sessionId: "ses_workflow_parent",
            title: "Status workflow",
            status: "running",
            config: "{}",
            seq: 1,
            wakeReported: false,
            startedAt: 1,
            completedAt: null,
            timeCreated: 1,
            timeUpdated: 2,
          }
        : id === "dag_defaults"
          ? {
              id,
              projectId: projectID,
              sessionId: "ses_workflow_parent",
              title: "Configured defaults",
              status: "running",
              config: JSON.stringify({
                name: "configured-defaults",
                node_defaults: {
                  required: true,
                  report_to_parent: true,
                  worker_config: { timeout_ms: 1234 },
                  model: {
                    providerID: "local-proxy-compatible",
                    modelID: "local-proxy-compatible/glm-5.2",
                  },
                },
                max_concurrency: 5,
                max_node_replan_attempts: 5,
                max_total_nodes: 100,
                nodes: [],
              }),
              seq: 1,
              wakeReported: false,
              startedAt: 1,
              completedAt: null,
              timeCreated: 1,
              timeUpdated: 2,
            }
        : undefined,
    ),
  getNodes: (id: string) =>
    Effect.succeed(
      id === "dag_status"
        ? [{
        id: "node_running",
        workflowId: "dag_status",
        name: "Running node",
        workerType: "build",
        status: "running",
        required: true,
        dependsOn: [],
        modelId: null,
        modelProviderId: null,
        childSessionId: "ses_child",
        output: null,
        capturedOutput: null,
        errorReason: null,
        deadlineMs: null,
        wakeEligible: true,
        wakeReported: false,
        replanAttempts: 0,
        seq: 1,
        startedAt: 1,
        completedAt: null,
        timeCreated: 1,
        timeUpdated: 2,
          }]
        : [],
    ),
})
const events = Layer.mock(EventV2Bridge.Service, {
  publish: (definition, data) =>
    Effect.sync(() => {
      published.push({ type: definition.type, data })
      return { id: "event_test", type: definition.type, data } as never
    }),
})
const dag = Dag.layer.pipe(
  Layer.provide(store),
  Layer.provide(events),
)
const runtime = testEffect(
  Layer.mergeAll(
    Layer.mock(Agent.Service, {
      get: () =>
        Effect.succeed({
          name: "build",
          mode: "all",
          permission: [],
          options: {},
          description: "",
          prompt: "",
          tools: {},
          hooks: {},
        }),
    }),
    Layer.mock(Truncate.Service, {
      output: (content) => Effect.succeed({ content, truncated: false }),
    }),
    dag,
    Layer.mock(Session.Service, {
      get: (id: Parameters<Session.Interface["get"]>[0]) => Effect.succeed({ id, projectID } as Session.Info),
    }),
  ),
)

describe("workflow tool schema (negative tests)", () => {
  it("action field accepts start/extend/control/status", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "start", config: { name: "test", nodes: [], max_concurrency: 3 } })).not.toThrow()
    expect(() => decode({ action: "extend", workflow_id: "wf-1", nodes: [] })).not.toThrow()
    expect(() => decode({ action: "control", workflow_id: "wf-1", operation: "pause" })).not.toThrow()
    expect(() => decode({ action: "status", workflow_id: "wf-1" })).not.toThrow()
  })

  it("action field rejects unknown actions", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "delete" })).toThrow()
  })

  it("no node_complete action exists", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "node_complete" })).toThrow()
  })

  it("no unsupported read-only actions exist (list/history/logs)", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "list" })).toThrow()
    expect(() => decode({ action: "history" })).toThrow()
    expect(() => decode({ action: "logs" })).toThrow()
  })

  it("control operation accepts pause/resume/cancel/replan/step/complete", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    for (const op of ["pause", "resume", "cancel", "replan", "step", "complete"]) {
      expect(() => decode({ action: "control", workflow_id: "wf-1", operation: op })).not.toThrow()
    }
  })

  it("control operation rejects unknown operations", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "control", workflow_id: "wf-1", operation: "delete" })).toThrow()
    expect(() => decode({ action: "control", workflow_id: "wf-1", operation: "start" })).toThrow()
  })

  it("leaves omitted node defaults unresolved for the workflow config", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    const input = decode({
      action: "start",
      config: {
        name: "required-default",
        node_defaults: {
          required: true,
          report_to_parent: true,
          worker_config: { timeout_ms: 1234 },
          model: { providerID: "configured", modelID: "configured/model" },
        },
        nodes: [
          {
            id: "optional-node",
            name: "Optional node",
            worker_type: "build",
            depends_on: [],
            prompt_template: { inline: "work" },
          },
        ],
      },
    })

    expect(input.config?.nodes[0]?.required).toBeUndefined()
    expect(input.config?.node_defaults).toEqual({
      required: true,
      report_to_parent: true,
      worker_config: { timeout_ms: 1234 },
      model: { providerID: "configured", modelID: "configured/model" },
    })
  })
})

describe("workflow tool execution", () => {
  runtime.effect("description retains the workflow action reference after guidance migration", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()

      for (const action of ["start", "extend", "status", "control"]) {
        expect(workflow.description).toContain(`**${action}**`)
      }
      expect(workflow.description).toContain("Do not poll")
      expect(workflow.description).not.toContain("$ARGUMENTS")
    }),
  )

  runtime.effect("status returns the durable workflow and node state", () =>
    Effect.gen(function* () {
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const result = yield* workflow.execute(
        {
          action: "status",
          workflow_id: "dag_status",
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(result.output).toContain('"status": "running"')
      expect(result.output).toContain('"id": "node_running"')
      expect(result.output).toContain('"child_session_id": "ses_child"')
    }),
  )

  runtime.effect("start derives the project ID from the parent session", () =>
    Effect.gen(function* () {
      published.length = 0
      const parentID = SessionID.make("ses_workflow_parent")
      const info = yield* WorkflowTool
      const workflow = yield* info.init()

      const result = yield* workflow.execute(
        {
          action: "start",
          config: {
            name: "project-id-regression",
            nodes: [],
          },
        },
        {
          sessionID: parentID,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      const workflowID = result.metadata.workflowId
      expect(workflowID).toBeDefined()
      expect(result.output).toContain("Do not poll")
      expect(published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data).toEqual(
        expect.objectContaining({ projectID, sessionID: parentID }),
      )
    }),
  )

  runtime.effect("start passes the decoded required default to Dag.create", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()

      yield* workflow.execute(
        {
          action: "start",
          config: {
            name: "required-default",
            nodes: [
              {
                id: "optional-node",
                name: "Optional node",
                worker_type: "build",
                depends_on: [],
                prompt_template: { inline: "work" },
              },
            ],
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toEqual(
        expect.objectContaining({ required: false }),
      )
    }),
  )

  runtime.effect("start resolves omitted values from workflow config defaults", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()

      yield* workflow.execute(
        {
          action: "start",
          config: {
            name: "configured-defaults",
            node_defaults: {
              required: true,
              report_to_parent: true,
              worker_config: { timeout_ms: 1234 },
              model: {
                providerID: "local-proxy-compatible",
                modelID: "local-proxy-compatible/glm-5.2",
              },
            },
            nodes: [
              {
                id: "inherits",
                name: "Inherits defaults",
                worker_type: "general",
                depends_on: [],
                prompt_template: { inline: "work" },
              },
              {
                id: "overrides",
                name: "Overrides defaults",
                worker_type: "general",
                depends_on: [],
                required: false,
                report_to_parent: false,
                worker_config: { timeout_ms: 4321 },
                prompt_template: { inline: "work" },
                model: { providerID: "other", modelID: "other-model" },
              },
            ],
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      const created = published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data as {
        config?: string
      }
      const config = JSON.parse(created.config ?? "{}")
      expect(config).toEqual(
        expect.objectContaining({
          max_concurrency: 5,
          max_node_replan_attempts: 5,
          max_total_nodes: 100,
        }),
      )
      expect(config.nodes[0]).toEqual(
        expect.objectContaining({
          required: true,
          report_to_parent: true,
          worker_config: { timeout_ms: 1234 },
          model: { providerID: "local-proxy-compatible", modelID: "glm-5.2" },
        }),
      )
      expect(config.nodes[1]).toEqual(
        expect.objectContaining({
          required: false,
          report_to_parent: false,
          worker_config: { timeout_ms: 4321 },
          model: { providerID: "other", modelID: "other-model" },
        }),
      )
    }),
  )

  runtime.effect("start canonicalizes a provider-qualified model ID", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()

      yield* workflow.execute(
        {
          action: "start",
          config: {
            name: "canonical-model",
            nodes: [
              {
                id: "worker",
                name: "Worker",
                worker_type: "general",
                depends_on: [],
                prompt_template: { inline: "work" },
                model: {
                  providerID: "local-proxy-compatible",
                  modelID: "local-proxy-compatible/glm-5.2",
                },
              },
            ],
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toEqual(
        expect.objectContaining({
          model: {
            providerID: "local-proxy-compatible",
            modelID: "glm-5.2",
          },
        }),
      )
      const created = published.find((event) => event.type === DagEvent.WorkflowCreated.type)?.data as {
        config?: string
      }
      expect(JSON.parse(created.config ?? "{}").nodes[0].model).toEqual({
        providerID: "local-proxy-compatible",
        modelID: "glm-5.2",
      })
    }),
  )

  runtime.effect("extend resolves new nodes from the persisted workflow defaults", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()

      yield* workflow.execute(
        {
          action: "extend",
          workflow_id: "dag_defaults",
          nodes: [
            {
              id: "added",
              name: "Added node",
              worker_type: "general",
              depends_on: [],
              prompt_template: { inline: "work" },
            },
          ],
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toEqual(
        expect.objectContaining({
          nodeID: "added",
          required: true,
          model: {
            providerID: "local-proxy-compatible",
            modelID: "glm-5.2",
          },
        }),
      )
      const updated = published.find((event) => event.type === DagEvent.WorkflowConfigUpdated.type)?.data as {
        config?: string
      }
      expect(JSON.parse(updated.config ?? "{}").nodes[0]).toEqual(
        expect.objectContaining({
          report_to_parent: true,
          worker_config: { timeout_ms: 1234 },
        }),
      )
    }),
  )

  runtime.effect("replan resolves new nodes from the persisted workflow defaults", () =>
    Effect.gen(function* () {
      published.length = 0
      const info = yield* WorkflowTool
      const workflow = yield* info.init()

      yield* workflow.execute(
        {
          action: "control",
          workflow_id: "dag_defaults",
          operation: "replan",
          fragment: {
            name: "replan-fragment",
            nodes: [
              {
                id: "replanned",
                name: "Replanned node",
                worker_type: "general",
                depends_on: [],
                prompt_template: { inline: "work" },
              },
            ],
          },
        },
        {
          sessionID: SessionID.make("ses_workflow_parent"),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context,
      )

      expect(published.find((event) => event.type === DagEvent.NodeRegistered.type)?.data).toEqual(
        expect.objectContaining({
          nodeID: "replanned",
          required: true,
          model: {
            providerID: "local-proxy-compatible",
            modelID: "glm-5.2",
          },
        }),
      )
      const updated = published.find((event) => event.type === DagEvent.WorkflowConfigUpdated.type)?.data as {
        config?: string
      }
      expect(JSON.parse(updated.config ?? "{}").nodes[0]).toEqual(
        expect.objectContaining({
          report_to_parent: true,
          worker_config: { timeout_ms: 1234 },
        }),
      )
    }),
  )

  runtime.effect("start rejects a project ID outside the parent session project", () =>
    Effect.gen(function* () {
      published.length = 0
      const parentID = SessionID.make("ses_workflow_parent")
      const info = yield* WorkflowTool
      const workflow = yield* info.init()
      const exit = yield* workflow
        .execute(
          {
            action: "start",
            project_id: "project_other",
            config: {
              name: "project-id-mismatch",
              nodes: [],
            },
          },
          {
            sessionID: parentID,
            messageID: MessageID.ascending(),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          } satisfies Tool.Context,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(published).toHaveLength(0)
    }),
  )
})
