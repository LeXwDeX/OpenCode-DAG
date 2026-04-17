#!/usr/bin/env bun
// Simplified local build script that skips generate.ts (models-snapshot already created)

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const VERSION = process.env.OPENCODE_VERSION || "0.0.4"
const CHANNEL = "dev"

console.log(`Building opencode v${VERSION} (${CHANNEL})`)

// Load migrations
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]))
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

const plugin = createSolidTransformPlugin()
const pkg = await Bun.file(path.join(dir, "package.json")).json()

const name = `${pkg.name}-windows-x64`
console.log(`building ${name}`)
await $`mkdir -p dist/${name}/bin`

const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
const workerPath = "./src/cli/cmd/tui/worker.ts"
const rgPath = "./src/file/ripgrep.worker.ts"

const bunfsRoot = "B:/~BUN/root/"
const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

await Bun.build({
  conditions: ["browser"],
  tsconfig: "./tsconfig.json",
  plugins: [plugin],
  external: ["node-gyp"],
  format: "esm",
  minify: true,
  splitting: true,
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    target: name.replace(pkg.name, "bun") as any,
    outfile: `dist/${name}/bin/opencode`,
    execArgv: [`--user-agent=opencode/${VERSION}`, "--use-system-ca", "--"],
    windows: {},
  },
  entrypoints: [
    "./src/index.ts",
    parserWorker,
    workerPath,
    rgPath,
  ],
  define: {
    OPENCODE_VERSION: `'${VERSION}'`,
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
    OPENCODE_WORKER_PATH: workerPath,
    OPENCODE_RIPGREP_WORKER_PATH: rgPath,
    OPENCODE_CHANNEL: `'${CHANNEL}'`,
    OPENCODE_LIBC: "",
  },
})

// Smoke test
const binaryPath = `dist/${name}/bin/opencode.exe`
console.log(`Binary built: ${binaryPath}`)
try {
  const versionOutput = await $`${binaryPath} --version`.text()
  console.log(`Smoke test passed: ${versionOutput.trim()}`)
} catch (e) {
  console.error(`Smoke test failed:`, e)
}

console.log(`\nDone! Binary at: ${path.resolve(dir, binaryPath)}`)
