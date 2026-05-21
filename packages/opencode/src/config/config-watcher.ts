/**
 * WP-C2: bridge file-system config changes to the SettingsHook `ConfigChange`
 * event.
 *
 * Subscribes to the GlobalBus (Node EventEmitter — cross-instance, sync) at
 * app-runtime layer scope. When a `file.watcher.updated` event whose path
 * basename is a recognized config file fires, the listener resolves the source
 * instance via InstanceStore and fires `SettingsHook.trigger({event:"ConfigChange"})`
 * for that instance.
 *
 * Subscribing via GlobalBus (not Bus.Service.subscribeCallback) is intentional:
 * Bus subscriptions require per-instance InstanceRef, which is not available
 * at the app-runtime Layer.effectDiscard layer-construction site. GlobalBus
 * has no such dependency — `InstanceStore.provide({directory})` is the path
 * back into instance scope for the trigger call.
 *
 * Failure policy: dispatch is fire-and-forget via `bridge.fork(...).pipe(Effect.ignore)`.
 * A hook failure must never crash the file watcher producer.
 */
import { Effect, Layer } from "effect"
import path from "node:path"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { FileWatcher } from "@/file/watcher"
import { SettingsHook } from "@/hook/settings"
import { InstanceStore } from "@/project/instance-store"

const CONFIG_BASENAMES = new Set(["opencode.json", "opencode.jsonc", "config.json"])

function isConfigPath(filePath: string): boolean {
  return CONFIG_BASENAMES.has(path.basename(filePath))
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settingsHook = yield* SettingsHook.Service
    const store = yield* InstanceStore.Service
    const bridge = yield* EffectBridge.make()

    const handler = (evt: GlobalEvent) => {
      const payload = evt.payload
      if (!payload || payload.type !== FileWatcher.Event.Updated.type) return
      const props = payload.properties as { file: string; event: string } | undefined
      if (!props || !isConfigPath(props.file)) return
      const directory = evt.directory
      if (!directory) return

      // store.provide loads (or returns cached) instance context for `directory`
      // then runs the wrapped effect with InstanceRef set. The instance IS
      // already loaded — the file-watcher event proves it — so this is a
      // cache hit, not a fresh boot.
      bridge.fork(
        store
          .provide(
            { directory },
            settingsHook
              .trigger(
                {
                  event: "ConfigChange",
                  configPath: props.file,
                  changes: { event: props.event },
                },
                { sessionID: "", transcriptPath: "" },
              )
              .pipe(Effect.asVoid),
          )
          .pipe(Effect.ignore),
      )
    }

    GlobalBus.on("event", handler)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", handler)))
  }),
)

export const defaultLayer = layer

export * as ConfigWatcher from "./config-watcher"
