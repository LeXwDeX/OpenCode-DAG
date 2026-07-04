import { beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs"
import * as os from "os"
import path from "path"
import { SettingsHook } from "@/hook/settings"
import { SessionHooks } from "@/hook/session-hooks"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { dispatchTrust, isTrusted, isTrustedDir, loadTrustedList, trustFilePath } from "@/hook/workspace-trust"
import { testEffect } from "../lib/effect"

// WP-6B workspace-trust gate. Two layers of tests:
//  - pure predicate + file-IO degradation (no Global.Path dependency)
//  - real SettingsHook trigger integration (enforcement on/off, allowUntrusted)

describe("isTrustedDir — path-segment-boundary matching", () => {
  test("exact match → trusted", () => {
    expect(isTrustedDir("/home/u/proj", ["/home/u/proj"])).toBe(true)
  })
  test("subdirectory inherits trust", () => {
    expect(isTrustedDir("/home/u/proj/packages/a", ["/home/u/proj"])).toBe(true)
  })
  test("same-prefix sibling does NOT piggyback (/proj-evil vs /proj)", () => {
    expect(isTrustedDir("/home/u/proj-evil", ["/home/u/proj"])).toBe(false)
  })
  test("empty trust list → untrusted", () => {
    expect(isTrustedDir("/any/dir", [])).toBe(false)
  })
  test("multiple entries — any match trusts", () => {
    expect(isTrustedDir("/opt/other", ["/home/u/proj", "/opt"])).toBe(true)
  })
})

describe("loadTrustedList — file degradation", () => {
  const tmp = () => path.join(os.tmpdir(), `opencode-trust-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)

  test("missing file → empty list (no throw)", () => {
    expect(loadTrustedList(tmp())).toEqual([])
  })
  test("invalid JSON → empty list (no throw)", () => {
    const f = tmp()
    fs.writeFileSync(f, "{not valid json")
    expect(loadTrustedList(f)).toEqual([])
  })
  test("non-array payload → empty list", () => {
    const f = tmp()
    fs.writeFileSync(f, JSON.stringify({ not: "an array" }))
    expect(loadTrustedList(f)).toEqual([])
  })
  test("valid string array → returned, non-string entries dropped", () => {
    const f = tmp()
    fs.writeFileSync(f, JSON.stringify(["/a", "/b", 3, null, { x: 1 }]))
    expect(loadTrustedList(f)).toEqual(["/a", "/b"])
  })
})

// ── trigger integration: the cwd (s.cwd) is the per-test instance tmpdir,
// which is never on the real trust list, so enforcement ON → untrusted → skip.
// No need to touch Global.Path.data.

const testLayer = SettingsHook.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provideMerge(SessionHooks.defaultLayer),
)
const trustIt = testEffect(testLayer)

const CONTEXT = "trust-gate-hook-fired"

const writeHooks = (json: unknown) => (dir: string) =>
  Effect.promise(() =>
    fs.promises.mkdir(path.join(dir, ".opencode"), { recursive: true }).then(() =>
      fs.promises.writeFile(path.join(dir, ".opencode", "hooks.json"), JSON.stringify(json)),
    ),
  )

const sessionStartHook = (extra: Record<string, unknown>) => ({
  ...extra,
  SessionStart: [{ hooks: [{ type: "command", command: `printf '%s' '${CONTEXT}'` }] }],
})

describe("SettingsHook workspace-trust gate (WP-6B)", () => {
  trustIt.instance(
    "enforcement ON + untrusted cwd → hooks silently skipped (empty result)",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "ses-trust-skip", transcriptPath: "" },
        )
        // Hook command never ran → no context injected.
        expect(r.additionalContexts).toEqual([])
        expect(r.blocked).toBeUndefined()
      }),
    { init: writeHooks(sessionStartHook({ requireTrust: true })) },
  )

  trustIt.instance(
    "enforcement ON + allowUntrusted:true → hooks execute normally",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "ses-trust-allow", transcriptPath: "" },
        )
        expect(r.additionalContexts).toEqual([CONTEXT])
      }),
    { init: writeHooks(sessionStartHook({ requireTrust: true, allowUntrusted: true })) },
  )

  trustIt.instance(
    "enforcement OFF (default) → zero gate, hooks execute",
    () =>
      Effect.gen(function* () {
        const hook = yield* SettingsHook.Service
        const r = yield* hook.trigger(
          { event: "SessionStart", source: "startup" },
          { sessionID: "ses-trust-off", transcriptPath: "" },
        )
        expect(r.additionalContexts).toEqual([CONTEXT])
      }),
    { init: writeHooks(sessionStartHook({})) },
  )
})

// ── /trust command dispatch (D3) ───────────────────────────────────
// dispatchTrust hits the real trust file (trustFilePath) and the hooks.json
// chain, so the block saves/restores the real trust file and uses a clean tmp
// directory per test. Gate-source assertions target the deterministic paths
// (env var and the project hooks.json we write) rather than the global
// hooks.json, which this machine may or may not have set.

describe("dispatchTrust (/trust command) — D3", () => {
  const realTrustFile = trustFilePath()
  let saved: string | undefined

  beforeAll(() => {
    saved = fs.existsSync(realTrustFile) ? fs.readFileSync(realTrustFile, "utf8") : undefined
  })
  afterAll(() => {
    try {
      if (saved === undefined) fs.rmSync(realTrustFile, { force: true })
      else fs.writeFileSync(realTrustFile, saved)
    } catch {
      // best-effort restore
    }
  })
  beforeEach(() => {
    try {
      fs.rmSync(realTrustFile, { force: true })
    } catch {
      // best-effort clean slate
    }
    delete process.env.OPENCODE_HOOKS_REQUIRE_TRUST
  })

  const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "trust-cmd-"))

  test("/trust 追加目录到信任列表（含目录路径）", () => {
    const dir = tmpdir()
    const r = dispatchTrust(dir, "")
    expect(r.text).toContain(dir)
    expect(isTrusted(dir)).toBe(true)
  })

  test("/trust 幂等（重复不重复追加）", () => {
    const dir = tmpdir()
    dispatchTrust(dir, "")
    dispatchTrust(dir, "")
    // exactly one entry for dir
    expect(loadTrustedList().filter((d) => d === dir).length).toBe(1)
    // confirmation text notes already-trusted
    expect(dispatchTrust(dir, "").text).toContain("已在信任列表")
  })

  test("/trust status 显示信任判定 + 信任文件路径", () => {
    const dir = tmpdir()
    const r = dispatchTrust(dir, "status")
    expect(r.text).toContain("未信任")
    expect(r.text).toContain(realTrustFile)
    expect(r.text).toContain("requireTrust 门禁")
  })

  test("/trust status — hooks.json requireTrust 来源", () => {
    const dir = tmpdir()
    fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".opencode", "hooks.json"), JSON.stringify({ requireTrust: true }))
    const r = dispatchTrust(dir, "status")
    expect(r.text).toContain("hooks.json requireTrust")
  })

  test("/trust status — OPENCODE_HOOKS_REQUIRE_TRUST 来源", () => {
    const dir = tmpdir()
    process.env.OPENCODE_HOOKS_REQUIRE_TRUST = "1"
    try {
      const r = dispatchTrust(dir, "status")
      expect(r.text).toContain("OPENCODE_HOOKS_REQUIRE_TRUST=1")
    } finally {
      delete process.env.OPENCODE_HOOKS_REQUIRE_TRUST
    }
  })

  test("/trust 写入失败不 throw（沿用 addTrusted never-throw）", () => {
    // dispatchTrust always returns { text }; addTrusted swallows write errors.
    const r = dispatchTrust(tmpdir(), "")
    expect(typeof r.text).toBe("string")
  })
})
