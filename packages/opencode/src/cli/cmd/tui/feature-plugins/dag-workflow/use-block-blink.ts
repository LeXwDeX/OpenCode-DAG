/** @jsxImportSource @opentui/solid */
/**
 * useBlockBlink — running 状态节点的方块闪烁 hook。
 *
 * 在 ● (solid) 和 ○ (hollow) 之间定时切换，所有 running 节点共享同一帧。
 * 只有有 running 节点时才启动定时器（按需），组件卸载自动清理。
 *
 * 架构约束：
 * - 纯 Solid signal + setInterval，无外部依赖
 * - 帧字符在 MAP_GLYPH 中定义，需由调用方传入确保一致性
 */
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

const BLINK_INTERVAL_MS = 500

const BLINK_FRAMES = ["●", "○"] as const

/**
 * useBlockBlink — 返回当前帧字符的 accessor。
 *
 * @param active 当有 running 节点时返回 true，控制定时器启停（按需轮转）。
 * @returns 当前帧字符串的 accessor；active 为 false 时返回 "●"（solid）。
 */
export function useBlockBlink(active: Accessor<boolean>): Accessor<string> {
  const [frame, setFrame] = createSignal(0)

  createEffect(() => {
    if (!active()) return
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % BLINK_FRAMES.length)
    }, BLINK_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))
  })

  return () => (active() ? BLINK_FRAMES[frame()] : BLINK_FRAMES[0])
}
