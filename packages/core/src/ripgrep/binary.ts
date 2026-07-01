import path from "path"
import { Context, Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "../cross-spawn-spawner"
import { LayerNode } from "../effect/layer-node"
import { httpClient } from "../effect/layer-node-platform"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { which } from "../util/which"

export namespace RipgrepBinary {
  const VERSION = "15.1.0"
  const PLATFORM = {
    "arm64-darwin": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
    "arm64-linux": { platform: "aarch64-unknown-linux-gnu", extension: "tar.gz" },
    "x64-darwin": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
    "x64-linux": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
    "arm64-win32": { platform: "aarch64-pc-windows-msvc", extension: "zip" },
    "ia32-win32": { platform: "i686-pc-windows-msvc", extension: "zip" },
    "x64-win32": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
  } as const

  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/RipgrepBinary") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const spawner = yield* ChildProcessSpawner

      const run = Effect.fnUntraced(function* (command: string, args: string[]) {
        const handle = yield* spawner.spawn(ChildProcess.make(command, args, { extendEnv: true, stdin: "ignore" }))
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        )
        return { stdout, stderr, code }
      }, Effect.scoped)

      const extract = Effect.fnUntraced(function* (
        archive: string,
        config: (typeof PLATFORM)[keyof typeof PLATFORM],
        target: string,
      ) {
        const dir = yield* fs.makeTempDirectoryScoped({ directory: Global.Path.bin, prefix: "ripgrep-" })

        if (config.extension === "zip") {
          // Windows only (all win32 platforms in the PLATFORM table use zip).
          // Resolve bsdtar by absolute path instead of relying on PATH: on
          // GitHub Windows runners, Git for Windows' GNU tar
          // (C:\Program Files\Git\usr\bin\tar.exe) shadows System32\tar.exe
          // (bsdtar) in PATH, and GNU tar treats `C:\Users\...` as an SSH-style
          // `host:path`, producing "Cannot connect to C: resolve failed".
          // System32 bsdtar natively understands Windows drive paths.
          // SystemRoot is virtually always set on Windows; fall back to the
          // literal name only if it is somehow absent (cross-spawn will then
          // do PATH lookup, which still works on stock Windows without Git).
          const systemRoot = process.env.SystemRoot
          const tarExe = systemRoot ? path.join(systemRoot, "System32", "tar.exe") : "tar"
          const result = yield* run(tarExe, ["-xf", archive, "-C", dir])
          if (result.code !== 0)
            throw new Error(
              result.stderr.trim() || result.stdout.trim() || `ripgrep extraction failed with code ${result.code}`,
            )
        }

        if (config.extension === "tar.gz") {
          const result = yield* run("tar", ["-xzf", archive, "-C", dir])
          if (result.code !== 0)
            throw new Error(
              result.stderr.trim() || result.stdout.trim() || `ripgrep extraction failed with code ${result.code}`,
            )
        }

        const extracted = path.join(
          dir,
          `ripgrep-${VERSION}-${config.platform}`,
          process.platform === "win32" ? "rg.exe" : "rg",
        )
        if (!(yield* fs.isFile(extracted))) throw new Error(`ripgrep archive did not contain executable: ${extracted}`)

        yield* fs.copyFile(extracted, target)
        if (process.platform !== "win32") yield* fs.chmod(target, 0o755)
      }, Effect.scoped)

      return Service.of({
        filepath: yield* Effect.cached(
          Effect.gen(function* () {
            const system = yield* Effect.sync(() => which(process.platform === "win32" ? "rg.exe" : "rg"))
            if (system && (yield* fs.isFile(system).pipe(Effect.orDie))) return system

            const target = path.join(Global.Path.bin, `rg${process.platform === "win32" ? ".exe" : ""}`)
            if (yield* fs.isFile(target).pipe(Effect.orDie)) return target

            const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
            const config = PLATFORM[platformKey]
            if (!config) throw new Error(`unsupported platform for ripgrep: ${platformKey}`)

            const filename = `ripgrep-${VERSION}-${config.platform}.${config.extension}`
            const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${filename}`
            const archive = path.join(Global.Path.bin, filename)

            yield* Effect.logInfo("downloading ripgrep", { url })
            yield* fs.ensureDir(Global.Path.bin).pipe(Effect.orDie)
            const bytes = yield* HttpClientRequest.get(url).pipe(
              http.execute,
              Effect.flatMap((response) => response.arrayBuffer),
              Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
            )
            if (bytes.byteLength === 0) throw new Error(`failed to download ripgrep from ${url}`)

            yield* fs.writeWithDirs(archive, new Uint8Array(bytes))
            yield* extract(archive, config, target)
            yield* fs.remove(archive, { force: true }).pipe(Effect.ignore)
            return target
          }),
        ),
      })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
  )

  export const node = LayerNode.make(layer, [FSUtil.node, httpClient, CrossSpawnSpawner.node])
}
