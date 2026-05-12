#!/usr/bin/env bun
//
// Prefetch the ripgrep binary into every dist/opencode-<name>/bin output produced
// by build.ts, so air-gapped users never hit the runtime download in
// packages/opencode/src/file/ripgrep.ts.
//
// Strategy:
//   1. Scan dist/opencode-* directories (created by build.ts).
//   2. Derive the upstream ripgrep PLATFORM key from each directory name.
//      Several variants (baseline / musl) share the same rg binary, so we
//      cache one download per rg-key under dist/.rg-cache/.
//   3. Extract rg (or rg.exe) into each dist/opencode-<name>/bin/, where
//      opencode's which("rg") step picks it up before any network fallback.
//
// Usage:
//   bun run script/prefetch-ripgrep.ts                # all platforms in dist/
//   bun run script/prefetch-ripgrep.ts --only <dir>   # one directory only
//   bun run script/prefetch-ripgrep.ts --version 15.1.0
//
// Exit codes:
//   0 success / 1 fatal error / 2 no matching dist directories found.

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pkgDir = path.resolve(__dirname, "..")

// Keep in sync with packages/opencode/src/file/ripgrep.ts
const DEFAULT_VERSION = "15.1.0"
const PLATFORM = {
  "arm64-darwin": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
  "arm64-linux": { platform: "aarch64-unknown-linux-gnu", extension: "tar.gz" },
  "x64-darwin": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
  "x64-linux": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
  "arm64-win32": { platform: "aarch64-pc-windows-msvc", extension: "zip" },
  "ia32-win32": { platform: "i686-pc-windows-msvc", extension: "zip" },
  "x64-win32": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
} as const

type RgKey = keyof typeof PLATFORM

const args = process.argv.slice(2)
const versionFlag = args.indexOf("--version")
const version = versionFlag >= 0 ? args[versionFlag + 1] : DEFAULT_VERSION
const onlyFlag = args.indexOf("--only")
const only = onlyFlag >= 0 ? args[onlyFlag + 1] : undefined

const distDir = path.join(pkgDir, "dist")
if (!fs.existsSync(distDir)) {
  console.error(`[prefetch-ripgrep] no dist/ directory at ${distDir}; build first.`)
  process.exit(2)
}

const dirs = fs
  .readdirSync(distDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith("opencode-"))
  .map((e) => e.name)
  .filter((name) => (only ? name === only : true))

if (dirs.length === 0) {
  console.error(`[prefetch-ripgrep] no opencode-* directories under ${distDir}.`)
  process.exit(2)
}

const cacheDir = path.join(distDir, ".rg-cache")
fs.mkdirSync(cacheDir, { recursive: true })

/**
 * Map a build.ts output directory like "opencode-windows-x64-baseline" to the
 * ripgrep PLATFORM key. The `baseline` / `musl` modifiers do not affect rg.
 */
function deriveRgKey(dirName: string): RgKey | undefined {
  // dirName = opencode-<os>-<arch>[-modifier...]
  const parts = dirName.split("-")
  if (parts.length < 3) return undefined
  const [, osTok, archTok] = parts
  const os = osTok === "windows" ? "win32" : osTok
  const arch = archTok
  const key = `${arch}-${os}` as RgKey
  return key in PLATFORM ? key : undefined
}

async function fetchArchive(rgKey: RgKey): Promise<string> {
  const cfg = PLATFORM[rgKey]
  const filename = `ripgrep-${version}-${cfg.platform}.${cfg.extension}`
  const cached = path.join(cacheDir, filename)
  if (fs.existsSync(cached) && fs.statSync(cached).size > 0) {
    console.log(`[prefetch-ripgrep] cache hit: ${filename}`)
    return cached
  }
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${filename}`
  console.log(`[prefetch-ripgrep] downloading ${url}`)
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok) throw new Error(`download failed ${res.status} ${res.statusText}: ${url}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength === 0) throw new Error(`empty archive: ${url}`)
  fs.writeFileSync(cached, buf)
  return cached
}

async function extractRg(archive: string, rgKey: RgKey, targetBinDir: string): Promise<void> {
  const cfg = PLATFORM[rgKey]
  const rgName = cfg.extension === "zip" ? "rg.exe" : "rg"
  const targetPath = path.join(targetBinDir, rgName)
  if (fs.existsSync(targetPath)) {
    console.log(`[prefetch-ripgrep]   rg already present at ${path.relative(pkgDir, targetPath)}`)
    return
  }
  fs.mkdirSync(targetBinDir, { recursive: true })
  // Extract to a sibling temp dir, then copy.
  // On Windows, Git Bash's cygwin tar treats `D:\foo` as a remote `host:path`,
  // so spawn the Windows-native tar.exe (libarchive, accepts native paths and
  // handles both .tar.gz and .zip) directly via Bun.spawnSync — bypassing the
  // shell entirely. On POSIX, just use system tar the same way.
  const tmp = path.join(cacheDir, `extract-${rgKey}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  const tarBin =
    process.platform === "win32" && fs.existsSync("C:\\Windows\\System32\\tar.exe")
      ? "C:\\Windows\\System32\\tar.exe"
      : "tar"
  const proc = Bun.spawnSync({
    cmd: [tarBin, "-xf", archive, "-C", tmp],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    throw new Error(
      `tar extract failed (exit ${proc.exitCode}) for ${archive}\nstderr: ${proc.stderr?.toString() ?? ""}`,
    )
  }
  // ripgrep archives extract to ripgrep-<version>-<platform>/rg(.exe)
  const subdirs = fs.readdirSync(tmp, { withFileTypes: true }).filter((e) => e.isDirectory())
  let extractedRg: string | undefined
  for (const d of subdirs) {
    const candidate = path.join(tmp, d.name, rgName)
    if (fs.existsSync(candidate)) {
      extractedRg = candidate
      break
    }
  }
  if (!extractedRg) {
    throw new Error(`rg binary not found inside archive ${archive}`)
  }
  fs.copyFileSync(extractedRg, targetPath)
  if (cfg.extension !== "zip") fs.chmodSync(targetPath, 0o755)
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`[prefetch-ripgrep]   wrote ${path.relative(pkgDir, targetPath)}`)
}

let injected = 0
const skipped: string[] = []
for (const dirName of dirs) {
  const rgKey = deriveRgKey(dirName)
  if (!rgKey) {
    skipped.push(`${dirName} (unsupported platform)`)
    continue
  }
  console.log(`[prefetch-ripgrep] ${dirName} -> ${rgKey}`)
  const archive = await fetchArchive(rgKey)
  const binDir = path.join(distDir, dirName, "bin")
  await extractRg(archive, rgKey, binDir)
  injected++
}

console.log(`[prefetch-ripgrep] done: ${injected} directory(ies) injected, ${skipped.length} skipped.`)
if (skipped.length) {
  for (const s of skipped) console.log(`  - skip ${s}`)
}
