import * as OpenTUI from "@opentui/core"
import * as Log from "@opencode-ai/core/util/log"

// NOTE: Audio API is fork-side; @opentui/core 0.1.x doesn't export it from the
// main entry. We treat it as opaque + nullable: types stub here, runtime access
// goes through `(OpenTUI as any).Audio` so the feature degrades gracefully when
// the upstream package doesn't expose Audio.
type AudioSound = number
type AudioVoice = number
type AudioPlayOptions = Record<string, unknown>
type AudioErrorContext = unknown
type Audio = {
  on(event: "error", handler: (error: Error, context: AudioErrorContext) => void): void
  isStarted(): boolean
  start(): boolean
  play(sound: AudioSound, options?: AudioPlayOptions): AudioVoice | null
  loadSound(bytes: Uint8Array): Promise<AudioSound | null>
  stopVoice(voice: AudioVoice): boolean
  dispose(): void
}
const AudioCtor: { create(options: { autoStart: boolean }): Audio } | undefined = (OpenTUI as any).Audio

const log = Log.create({ service: "tui.audio" })

let audio: Audio | null | undefined
const sounds = new Map<string, Promise<AudioSound | null>>()

function getAudio() {
  if (audio !== undefined) return audio
  if (!AudioCtor) {
    audio = null
    return null
  }
  try {
    const next = AudioCtor.create({ autoStart: false })
    next.on("error", (error: Error, context: AudioErrorContext) => {
      log.debug("tui audio error", { error, context })
    })
    audio = next
    return next
  } catch (error) {
    log.debug("failed to create tui audio", { error })
    audio = null
    return null
  }
}

export function loadSoundFile(file: string) {
  const current = getAudio()
  if (!current) return Promise.resolve(null)
  const cached = sounds.get(file)
  if (cached) return cached
  const task = Bun.file(file)
    .bytes()
    .then((bytes) => current.loadSound(bytes))
    .catch((error) => {
      log.debug("failed to load tui sound", { file, error })
      return null
    })
  sounds.set(file, task)
  return task
}

export function play(sound: AudioSound, options?: AudioPlayOptions) {
  const current = getAudio()
  if (!current) return null
  if (!current.isStarted() && !current.start()) return null
  return current.play(sound, options)
}

export function stopVoice(voice: AudioVoice) {
  return audio?.stopVoice(voice) ?? false
}

export function dispose() {
  audio?.dispose()
  audio = undefined
  sounds.clear()
}

export * as TuiAudio from "./audio"
