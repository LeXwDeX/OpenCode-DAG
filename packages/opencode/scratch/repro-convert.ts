// ─────────────────────────────────────────────────────────────────────────────
// repro-convert.ts — Manual repro harness for the ModelMessage schema error
//
//   "Invalid prompt: The messages do not match the ModelMessage[] schema."
//   (AI SDK AI_InvalidPromptError, thrown locally by standardizePrompt)
//
// WHAT THIS IS
//   A standalone debugging script (NOT part of the test suite, NOT product code)
//   used to pin down which stored part `metadata` shapes break replay. It runs the
//   REAL MessageV2.toModelMessages() conversion, then feeds the result into
//   AI SDK generateText() with a MockLanguageModelV3 (from "ai/test"), so it
//   exercises the exact validation path the app hits — without any network/model.
//
// ROOT CAUSE IT DEMONSTRATES
//   AI SDK requires providerOptions to match record<string, record<string, json>>.
//   A TOP-LEVEL SCALAR in a part's metadata (e.g. { foo: "bar" }, { count: 5 })
//   is emitted as providerOptions and FAILS schema validation. Nested records
//   (e.g. { anthropic: { signature: "S" } }) are fine.
//
//   In message-v2.ts the text part (line ~802) and reasoning part (line ~911)
//   attach `part.metadata` RAW; the tool path uses providerMeta() which only
//   strips `providerExecuted` — so any other stray scalar still slips through
//   (see case M5 below).
//
// WHY MODEL-SWITCH TRIGGERS IT
//   All metadata attachment is guarded by `differentModel ? {} : ...`, computed
//   per-message. Metadata is replayed only when the current model == the model
//   that authored the message. That's why line 11 pins the current model to the
//   SAME model as the authored messages (differentModel=false) to reproduce.
//   Switching onto/back to the authoring model re-enables its corrupt metadata.
//
// HOW TO RUN
//   bun packages/opencode/repro-convert.ts
//
// EXPECTED OUTPUT (current/buggy behavior)
//   M1 text meta scalar      -> SEND-FAIL  (providerOptions:{foo:"bar"})
//   M2 reasoning meta scalar -> SEND-FAIL  (providerOptions:{count:5})
//   M3 reasoning meta nested -> PASS       (valid nested record)
//   M4 tool object output    -> PASS
//   M5 tool meta scalar      -> SEND-FAIL  (providerExecuted stripped, weird:"x" survives)
//   M6 text meta null        -> PASS
//   M7 tool input string     -> PASS
//
//   Once the sanitizeProviderMetadata fix lands, M1/M2/M5 should flip to PASS.
//
// STATUS: kept intentionally as a living repro for the providerMetadata sanitize
// work. Update the M-cases if the conversion contract changes.
// ─────────────────────────────────────────────────────────────────────────────
import { MessageV2 } from "./src/session/message-v2"
import { generateText } from "ai"
import { MockLanguageModelV3 } from "ai/test"

const wp = (info: any, parts: any[]) => ({ info, parts })
const U = (id: string, text: string) => wp({ id, role: "user", sessionID: "s", time: { created: 1 }, providerID: "anthropic", modelID: "claude" }, [{ id: id+"p", messageID: id, sessionID: "s", type: "text", text }])
const A = (id: string, parts: any[], prov="anthropic", mid="claude-sonnet-4", extra: any = {}) => wp({ id, role: "assistant", sessionID: "s", time: { created: 2, completed: 3 }, providerID: prov, modelID: mid, mode: "build", agent: "build", path: { cwd: "/", root: "/" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, ...extra }, parts.map((p,i)=>({ id: id+"p"+i, messageID: id, sessionID: "s", ...p })))
const mock = new MockLanguageModelV3({ doGenerate: async () => ({ finishReason:'stop', usage:{inputTokens:1,outputTokens:1,totalTokens:2}, content:[{type:'text',text:'ok'}], warnings:[] }) })

// SAME model so metadata is kept (differentModel=false): current model = anthropic/claude-sonnet-4
const same: any = { providerID: "anthropic", id: "claude-sonnet-4", api: { npm: "@ai-sdk/anthropic", id: "claude-sonnet-4" } }

async function run(label: string, msgs: any[], model: any = same) {
  let out
  try { out = await MessageV2.toModelMessages(msgs as any, model as any) }
  catch (e: any) { console.log(`CONVERT-THREW ${label}: ${e?.name}: ${String(e?.message).split("\n")[0]}`); return }
  try { await generateText({ model: mock, messages: out as any }); console.log(`PASS ${label} [${out.map((m:any)=>m.role).join(",")}]`) }
  catch (e: any) { console.log(`SEND-FAIL ${label}: ${e?.name}: ${String(e?.message).split("\n")[0]}`); console.log("   OUT:", JSON.stringify(out)) }
}

// M1: text with metadata top-level SCALAR (invalid providerOptions shape), same model -> kept
await run("M1 text meta scalar", [U("u1","x"), A("a1",[{type:"text", text:"hi", metadata:{ foo: "bar" }}])])
// M2: reasoning with metadata top-level scalar, same model -> kept
await run("M2 reasoning meta scalar", [U("u1","x"), A("a1",[{type:"text",text:"hi"},{type:"reasoning", text:"r", metadata:{ count: 5 }}])])
// M3: reasoning metadata nested record (valid) same model
await run("M3 reasoning meta nested", [U("u1","x"), A("a1",[{type:"text",text:"hi"},{type:"reasoning", text:"r", metadata:{ anthropic:{ signature:"S" }}}])])
// M4: tool completed with OBJECT structured output (no text field)
await run("M4 tool object output", [U("u1","x"), A("a1",[{type:"tool", tool:"bash", callID:"c1", state:{status:"completed", input:{command:"ls"}, output:{ rows: [1,2,3] }, time:{start:2,end:3}}, metadata:{}}])])
// M5: tool completed metadata with scalar (callProviderMetadata) same model
await run("M5 tool meta scalar", [U("u1","x"), A("a1",[{type:"tool", tool:"bash", callID:"c1", state:{status:"completed", input:{command:"ls"}, output:"ok", time:{start:2,end:3}}, metadata:{ providerExecuted:true, weird:"x" }}])])
// M6: text metadata = null
await run("M6 text meta null", [U("u1","x"), A("a1",[{type:"text", text:"hi", metadata: null}])])
// M7: tool input is a string (not object)
await run("M7 tool input string", [U("u1","x"), A("a1",[{type:"tool", tool:"bash", callID:"c1", state:{status:"completed", input:"ls", output:"ok", time:{start:2,end:3}}, metadata:{}}])])
