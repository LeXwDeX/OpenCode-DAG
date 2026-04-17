import path from "path"
import os from "os"

const marks: Array<[string, number]> = []
const t0 = performance.now()

export function mark(label: string) {
  marks.push([label, performance.now() - t0])
}

export async function flush() {
  if (marks.length === 0) return
  const lines = marks.map(([label, ms]) => `[${ms.toFixed(1)}ms] ${label}`)
  const logPath = path.join(os.homedir(), ".config", "opencode", "startup-trace.log")
  const content = new Date().toISOString() + "\n" + lines.join("\n") + "\n\n"
  const file = Bun.file(logPath)
  const existing = await file.exists() ? await file.text() : ""
  await Bun.write(file, existing + content)
}
