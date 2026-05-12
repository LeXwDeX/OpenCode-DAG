/**
 * Unit tests for buildAgentTools (WP-4D micro-WP-1).
 *
 * Covers contract slice only — agent loop is WP-4D-2 and out of scope here.
 * Each test resolves the real spawner / fs Services via testEffect, builds
 * the tool palette, and exercises one tool's `execute` directly.
 */
import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { buildAgentTools, __test__ } from "../../src/hook/agent-tools"
import type { HookJSONOutput } from "../../src/hook/settings"

const infra = Layer.mergeAll(CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer)
const it = testEffect(infra)

// Bare-minimum execute options shape — ai-SDK requires toolCallId/messages/abortSignal.
const execOpts = (signal: AbortSignal) =>
  ({
    toolCallId: "test-call",
    messages: [],
    abortSignal: signal,
  }) as never

function makeDeps(opts: { spawner: any; fs: AppFileSystem.Interface; cwd: string }) {
  const captured: { value: HookJSONOutput | null } = { value: null }
  const signal = new AbortController().signal
  const tools = buildAgentTools({ spawner: opts.spawner, fs: opts.fs, signal, cwd: opts.cwd, captured })
  return { tools, captured, signal }
}

describe("agent-tools / read_file", () => {
  it.live("relative path joins cwd", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const fsys = yield* AppFileSystem.Service
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "a.txt"), "hello\nworld"))
        const { tools, signal } = makeDeps({ spawner, fs: fsys, cwd: dir })
        const out: any = yield* Effect.promise(() => tools.read_file.execute!({ path: "a.txt" }, execOpts(signal)))
        expect(out.output).toBe("hello\nworld")
      }),
    ),
  )

  it.live("absolute path works", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const fsys = yield* AppFileSystem.Service
        const filepath = path.join(dir, "abs.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "abs-content"))
        const { tools, signal } = makeDeps({ spawner, fs: fsys, cwd: dir })
        const out: any = yield* Effect.promise(() => tools.read_file.execute!({ path: filepath }, execOpts(signal)))
        expect(out.output).toBe("abs-content")
      }),
    ),
  )

  it.live("offset+limit slices lines", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const fsys = yield* AppFileSystem.Service
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "lines.txt"), "1\n2\n3\n4\n5\n6"))
        const { tools, signal } = makeDeps({ spawner, fs: fsys, cwd: dir })
        const out: any = yield* Effect.promise(() =>
          tools.read_file.execute!({ path: "lines.txt", offset: 2, limit: 3 }, execOpts(signal)),
        )
        // offset=2 (1-indexed) → start at line 2 → "2\n3\n4"
        expect(out.output).toBe("2\n3\n4")
      }),
    ),
  )

  it.live("missing file returns Error: prefix, no throw", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const fsys = yield* AppFileSystem.Service
        const { tools, signal } = makeDeps({ spawner, fs: fsys, cwd: dir })
        const out: any = yield* Effect.promise(() =>
          tools.read_file.execute!({ path: "missing.txt" }, execOpts(signal)),
        )
        expect(typeof out.output).toBe("string")
        expect(out.output).toMatch(/^Error:/)
      }),
    ),
  )
})

describe("agent-tools / list_dir", () => {
  it.live("entries with trailing / for dirs", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const fsys = yield* AppFileSystem.Service
        yield* Effect.promise(() => fs.mkdir(path.join(dir, "subdir")))
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "file.txt"), "x"))
        const { tools, signal } = makeDeps({ spawner, fs: fsys, cwd: dir })
        const out: any = yield* Effect.promise(() => tools.list_dir.execute!({ path: dir }, execOpts(signal)))
        const lines = (out.output as string).split("\n")
        expect(lines).toContain("subdir/")
        expect(lines).toContain("file.txt")
      }),
    ),
  )
})

describe("agent-tools / grep", () => {
  it.live("matches pattern in single file, format path:line:content", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const fsys = yield* AppFileSystem.Service
        const filepath = path.join(dir, "g.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "alpha\nfoo bar\nbaz"))
        const { tools, signal } = makeDeps({ spawner, fs: fsys, cwd: dir })
        const out: any = yield* Effect.promise(() =>
          tools.grep.execute!({ pattern: "foo", path: filepath }, execOpts(signal)),
        )
        expect(out.output).toBe(`${filepath}:2:foo bar`)
      }),
    ),
  )
})

describe("agent-tools / bash whitelist", () => {
  it.live("'ls' executes against cwd", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const fsys = yield* AppFileSystem.Service
        yield* Effect.promise(() => fs.writeFile(path.join(dir, "marker.txt"), "x"))
        const { tools, signal } = makeDeps({ spawner, fs: fsys, cwd: dir })
        const out: any = yield* Effect.promise(() => tools.bash.execute!({ command: "ls" }, execOpts(signal)))
        expect(out.output).toContain("marker.txt")
        expect(out.output).toMatch(/^exit=0/)
      }),
    ),
  )

  it.live("rejects 'rm -rf /' with Error: prefix and never spawns", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const fsys = yield* AppFileSystem.Service
        const { tools, signal } = makeDeps({ spawner, fs: fsys, cwd: dir })
        const t0 = Date.now()
        const out: any = yield* Effect.promise(() =>
          tools.bash.execute!({ command: "rm -rf /" }, execOpts(signal)),
        )
        const elapsed = Date.now() - t0
        expect(out.output).toMatch(/^Error:/)
        expect(out.output).toContain("not in read-only whitelist")
        // No spawn should have been issued — pure regex/whitelist rejection.
        // Allow generous slack so noisy CI doesn't flake; spawn typically takes 50-500ms.
        expect(elapsed).toBeLessThan(50)
      }),
    ),
  )

  it.live("FORBIDDEN_META rejects 'ls; rm x'", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const fsys = yield* AppFileSystem.Service
        const { tools, signal } = makeDeps({ spawner, fs: fsys, cwd: dir })
        const out: any = yield* Effect.promise(() =>
          tools.bash.execute!({ command: "ls; rm x" }, execOpts(signal)),
        )
        expect(out.output).toContain("compound/redirect not allowed")
      }),
    ),
  )

  it.live("'git status' two-token whitelist passes inside a git repo", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner
          const fsys = yield* AppFileSystem.Service
          const { tools, signal } = makeDeps({ spawner, fs: fsys, cwd: dir })
          const out: any = yield* Effect.promise(() =>
            tools.bash.execute!({ command: "git status" }, execOpts(signal)),
          )
          // git status in clean repo: exit=0
          expect(out.output).toMatch(/^exit=0/)
        }),
      { git: true },
    ),
  )

  it.live("__test__.whitelistReject covers single + pair contract", () =>
    Effect.gen(function* () {
      // Pure contract checks — no Effect deps needed but kept inside .live for parity.
      expect(__test__.whitelistReject("ls")).toBeNull()
      expect(__test__.whitelistReject("git status")).toBeNull()
      expect(__test__.whitelistReject("sed -n 1,3p file")).toBeNull()
      expect(__test__.whitelistReject("rm -rf /")).toMatch(/not in read-only whitelist/)
      expect(__test__.whitelistReject("ls | cat")).toMatch(/compound\/redirect not allowed/)
      expect(__test__.whitelistReject("")).toBe("empty command")
    }),
  )
})

describe("agent-tools / synthetic_output", () => {
  it.live("writes captured.value with full HookJSONOutput shape", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const fsys = yield* AppFileSystem.Service
        const { tools, captured, signal } = makeDeps({ spawner, fs: fsys, cwd: dir })
        const args = {
          decision: "block" as const,
          reason: "policy violation",
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny" as const,
            permissionDecisionReason: "policy",
          },
        }
        const out: any = yield* Effect.promise(() => tools.synthetic_output.execute!(args, execOpts(signal)))
        expect(out.output).toBe("ok")
        expect(captured.value).toEqual(args)
      }),
    ),
  )
})
