import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Exit } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Question } from "@/question"
import { Notification } from "@/notification"
import { SettingsHook, type HookPayload } from "@/hook/settings"
import { registerElicitationHandler, setActiveElicitationSession } from "@/mcp/elicitation"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EffectBridge } from "@/effect/bridge"
import { disposeAllInstances, testInstanceStoreLayer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// mcp-elicitation-notification — task 5.4: real in-memory MCP round-trip.
//
// A stub MCP `Server` exposes a tool whose handler calls `server.elicitInput(...)`,
// sending `elicitation/create` to the connected `Client`. The client has the real
// `registerElicitationHandler` wired (the same registration `watch()` performs in
// production), so the request flows: server → transport → client handler
// (`handleElicitation`) → Question service → user reply → accept → server receives
// the elicited content → `callTool` resolves.
//
// This closes the gap between the adapter unit/integration tests (which exercise
// `handleElicitation` directly) and the real SDK transport dispatch, and verifies
// the 5.4 concern end-to-end: the elicitation renders (Question surfaces), resolves
// (reply → accept), and does not corrupt the in-flight tool call. The blocking
// Question.ask during a tool call is exactly the "during a streaming turn" shape —
// an MCP tool blocks on elicitation exactly as it blocks on any slow operation.

afterEach(async () => {
  setActiveElicitationSession(undefined)
  await disposeAllInstances()
})

const emptyResult = {
  blocked: undefined,
  permissionDecision: undefined,
  permissionDecisionReason: undefined,
  additionalContexts: [] as string[],
  systemMessages: [] as string[],
  hookSpecificOutput: undefined,
}
function recorderLayer() {
  const recorded: HookPayload[] = []
  const layer = Layer.succeed(
    SettingsHook.Service,
    SettingsHook.Service.of({
      trigger: (payload: HookPayload) => Effect.sync(() => (recorded.push(payload), { ...emptyResult })),
      list: () => Effect.succeed([]),
    }),
  )
  return { recorded, layer }
}

const rec = recorderLayer()
const env = Layer.mergeAll(
  Question.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer)),
  Notification.defaultLayer,
  rec.layer,
  testInstanceStoreLayer,
)
const it = testEffect(env)

const SESSION = "ses_elicitation_transport"
const STALE_SESSION = "ses_elicitation_transport_stale"

/**
 * Build a stub MCP server whose only tool, "pick", elicits a color choice from
 * the user and returns the elicitation outcome as the tool result text.
 */
function makeStubServer(): Server {
  const server = new Server({ name: "elicitation-stub", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "pick", description: "Elicit a color choice", inputSchema: { type: "object", properties: {} } },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async () => {
    const result = await server.elicitInput({
      message: "Pick a color",
      requestedSchema: {
        type: "object",
        properties: { color: { type: "string", enum: ["red", "green", "blue"] } },
      },
    })
    return {
      content: [{ type: "text", text: `elicit ${result.action}: ${JSON.stringify(result.content)}` }],
    } as never
  })
  return server
}

const awaitValue = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Fiber.await(fiber)
    if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
    return exit.value
  })

describe("mcp elicitation — real transport round-trip (5.4)", () => {
  it.instance("server elicits mid-tool-call; client surfaces, user replies, accept round-trips", () =>
    Effect.gen(function* () {
      const question = yield* Question.Service
      // Build the bridge inside the test context so handleElicitation (run via
      // bridge.promise from the elicitation handler) sees Question + SettingsHook
      // + Notification.
      const bridge = yield* EffectBridge.make()

      // Real client + stub server linked by an in-memory transport pair.
      const client = new Client(
        { name: "opencode", version: "0.0.0" },
        { capabilities: { elicitation: {}, roots: {} } },
      )
      registerElicitationHandler(client, bridge)
      const server = makeStubServer()
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => Promise.all([client.close(), server.close()])).pipe(Effect.catch(() => Effect.void)),
      )
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      yield* Effect.promise(() => Promise.all([client.connect(clientTransport), server.connect(serverTransport)]))

      // Drive the tool call. Production MCP tool execution sets the active
      // session synchronously around the server call (the SDK transport dispatch
      // breaks AsyncLocalStorage, so SessionContext alone is insufficient — see
      // elicitation.ts). The test mirrors that by setting the fallback directly.
      const before = rec.recorded.length
      const cleanup = setActiveElicitationSession(SESSION)
      yield* Effect.addFinalizer(() => Effect.sync(cleanup))
      const staleCleanup = setActiveElicitationSession(STALE_SESSION)
      yield* Effect.addFinalizer(() => Effect.sync(staleCleanup))
      staleCleanup()
      const callFiber = yield* Effect.promise(() => client.callTool({ name: "pick", arguments: {} })).pipe(Effect.forkScoped)

      // The elicitation surfaces as a pending Question.
      const pending = yield* pollWithTimeout(
        Effect.gen(function* () {
          const items = yield* question.list()
          return items.length === 1 ? (items as readonly Question.Request[]) : undefined
        }),
        "elicitation never surfaced as a Question",
        "15 seconds",
      )
      expect(String(pending[0].sessionID)).toBe(SESSION)

      // Reply "green" → adapter validates, accepts, returns content to the server.
      yield* question.reply({ requestID: pending[0].id, answers: [["green"]] })
      const callResult = (yield* awaitValue(callFiber)) as { content?: Array<{ type: string; text?: string }> }

      // The server's tool received the elicited content and returned it.
      const text = callResult.content?.[0]?.text ?? ""
      expect(text).toContain("elicit accept")
      expect(text).toContain("green")

      // Elicitation + ElicitationResult hooks fired through the real transport path.
      const events = rec.recorded.slice(before)
      expect(events.filter((p) => p.event === "Elicitation")).toHaveLength(1)
      expect(
        events.filter(
          (p) => p.event === "ElicitationResult" && JSON.stringify((p as { result?: unknown }).result).includes("green"),
        ),
      ).toHaveLength(1)
    }),
  )
})
