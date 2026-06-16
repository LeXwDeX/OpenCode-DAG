/** @jsxImportSource @opentui/solid */
/**
 * useSpinner — running 状态节点的动态 ASCII spinner hook。
 *
 * 用 setInterval 驱动 signal 帧切换，实现 ⠋⠙⠹ 旋转效果。
 * 只有有 running 节点时才启动定时器（按需），组件卸载自动清理。
 *
 * 架构约束：
 * - 纯 Solid signal + setInterval，无外部依赖
 * - 帧序列使用 Braille 区字符（U+2800-U+28FF），Bun.stringWidth 计为 1 列
 */
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

/** Braille spinner 帧序列（宽度 1 列，兼容主流终端） */
export const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"] as const
const SPINNER_INTERVAL_MS = 120

/**
 * useSpinner — 返回当前帧 index 的 accessor。
 *
 * @param active 当有 running 节点时返回 true，控制定时器启停（按需轮转）。
 * @returns 当前帧字符串的 accessor；active 为 false 时返回空串。
 */
export function useSpinner(active: Accessor<boolean>): Accessor<string> {
  const [frame, setFrame] = createSignal(0)

  createEffect(() => {
    if (!active()) return
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
    }, SPINNER_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))
  })

  return () => (active() ? SPINNER_FRAMES[frame()] : "")
}
