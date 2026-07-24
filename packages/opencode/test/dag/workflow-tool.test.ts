import { describe, expect, it } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { Dag } from "@/dag/dag"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Parameters, WorkflowTool } from "@/tool/workflow"
import { testEffect } from "../lib/effect"

const projectID = "project_test"
const created: Parameters<Dag.Interface["create"]>[0][] = []
const runtime = testEffect(
  Layer.mergeAll(
    Layer.succeed(
      Agent.Service,
      Agent.Service.of({
        get: () => Effect.succeed({}),
      } as unknown as Agent.Interface),
    ),
    Layer.succeed(
      Truncate.Service,
      Truncate.Service.of({
        output: (content) => Effect.succeed({ content, truncated: false }),
      } as Truncate.Interface),
    ),
    Layer.succeed(
      Dag.Service,
      Dag.Service.of({
        create: (input: Parameters<Dag.Interface["create"]>[0]) =>
          Effect.sync(() => {
            created.push(input)
            return Dag.ID.create()
          }),
        store: {
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
                : undefined,
            ),
          getNodes: () =>
            Effect.succeed([
              {
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
              },
            ]),
        },
      } as unknown as Dag.Interface),
    ),
    Layer.succeed(
      Session.Service,
      Session.Service.of({
        get: (id: Parameters<Session.Interface["get"]>[0]) => Effect.succeed({ id, projectID } as Session.Info),
      } as unknown as Session.Interface),
    ),
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

  it("defaults an omitted node required flag to false", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    const input = decode({
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
    })

    expect(input.config?.nodes[0]?.required).toBe(false)
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
      created.length = 0
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
      expect(created).toHaveLength(1)
      expect(created[0]?.projectID).toBe(projectID)
      expect(created[0]?.sessionID).toBe(parentID)
    }),
  )

  runtime.effect("start passes the decoded required default to Dag.create", () =>
    Effect.gen(function* () {
      created.length = 0
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

      expect(created[0]?.config.nodes[0]?.required).toBe(false)
    }),
  )

  runtime.effect("start rejects a project ID outside the parent session project", () =>
    Effect.gen(function* () {
      created.length = 0
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
      expect(created).toHaveLength(0)
    }),
  )
})
