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
  it("action field accepts start/extend/control", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "start", config: { name: "test", nodes: [], max_concurrency: 3 } })).not.toThrow()
    expect(() => decode({ action: "extend", workflow_id: "wf-1", nodes: [] })).not.toThrow()
    expect(() => decode({ action: "control", workflow_id: "wf-1", operation: "pause" })).not.toThrow()
  })

  it("action field rejects unknown actions", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "delete" })).toThrow()
    expect(() => decode({ action: "status" })).toThrow()
  })

  it("no node_complete action exists", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "node_complete" })).toThrow()
  })

  it("no read-only actions exist (status/list/history/logs)", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(() => decode({ action: "status" })).toThrow()
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
})

describe("workflow tool execution", () => {
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
