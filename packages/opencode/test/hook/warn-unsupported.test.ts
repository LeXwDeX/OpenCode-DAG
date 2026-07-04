import { describe, expect, test } from "bun:test"
import { detectUnsupportedFields, type Settings } from "@/hook/settings"

// hooks-api-fidelity: async / asyncRewake / `if` are all fully implemented
// (hook-async-execution + condition-filter) and MUST NOT be flagged as
// unsupported. Only `shell` remains a runtime placeholder and MUST still be
// flagged so users know it is inert.

const hooks = (hook: Record<string, unknown>): Settings["hooks"] => ({
  SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "true", ...hook }] }],
})

describe("detectUnsupportedFields", () => {
  test("async / asyncRewake are NOT flagged (implemented)", () => {
    const unsupported = detectUnsupportedFields(hooks({ async: true, asyncRewake: true }))
    expect(unsupported).toEqual([])
  })

  test("if is NOT flagged (condition-filter implements it)", () => {
    const unsupported = detectUnsupportedFields(hooks({ if: "Bash(npm *)" }))
    expect(unsupported).toEqual([])
  })

  test("shell is still flagged (placeholder)", () => {
    const unsupported = detectUnsupportedFields(hooks({ shell: "powershell" }))
    expect(unsupported).toHaveLength(1)
    expect(unsupported[0]).toMatchObject({ field: "shell", value: "powershell", eventName: "SessionStart" })
  })

  test("only shell is flagged when if+shell+async all present", () => {
    const unsupported = detectUnsupportedFields(
      hooks({ if: "Edit(*.ts)", shell: "bash", async: true, asyncRewake: true }),
    )
    expect(unsupported.map((u) => u.field).sort()).toEqual(["shell"])
  })

  test("undefined / empty hooks yield no flags", () => {
    expect(detectUnsupportedFields(undefined)).toEqual([])
    expect(detectUnsupportedFields({})).toEqual([])
  })
})
