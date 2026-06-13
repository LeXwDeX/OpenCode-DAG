import { describe, expect, it } from "bun:test"

describe("dialog ESC targeted bindings", () => {
  it("DialogPrompt keeps a textarea-targeted ESC binding", async () => {
    const source = await Bun.file(new URL("./dialog-prompt.tsx", import.meta.url)).text()
    const bugFix = source.slice(source.indexOf("BUG-4 fix"))

    expect(bugFix).toContain("target: textareaTarget")
    expect(bugFix).toContain('key: "escape"')
    expect(bugFix).toContain("cmd: () => dialog.clear()")
  })

  it("DialogSelect keeps an input-targeted ESC binding", async () => {
    const source = await Bun.file(new URL("./dialog-select.tsx", import.meta.url)).text()
    const bugFix = source.slice(source.indexOf("BUG-4 fix"))

    expect(source).toContain("createSignal<InputRenderable>()")
    expect(source).toContain("setInputTarget(r)")
    expect(bugFix).toContain("target: inputTarget")
    expect(bugFix).toContain('key: "escape"')
    expect(bugFix).toContain("cmd: () => dialog.clear()")
  })
})
