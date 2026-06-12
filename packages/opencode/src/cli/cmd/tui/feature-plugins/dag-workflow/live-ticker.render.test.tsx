/** @jsxImportSource @opentui/solid */
/**
 * Regression test for the LiveTicker crash:
 * box-level <text> elements nested inside a <span> (TextNodeRenderable) threw
 * "TextNodeRenderable only accepts strings, TextNodeRenderable instances, or StyledText instances"
 * whenever the LIVE branch rendered. The fix uses nested <span> with style={{ fg }}.
 *
 * LiveTicker depends on useTheme (full provider chain), so this test guards the
 * equivalent render structure (text > span > span with ternary switching) instead
 * of mounting LiveTicker directly.
 */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"

// Replicates LiveTicker's fixed render structure.
function TickerStructure(props: { summary: () => string | null }) {
  return (
    <box>
      <text>
        {props.summary() ? (
          <span>
            <span style={{ fg: "#ff0000" }}>LIVE </span>
            <span>{props.summary() ?? ""}</span>
          </span>
        ) : (
          <span>idle</span>
        )}
      </text>
    </box>
  )
}

test("LIVE branch renders without throwing when summary is non-null initially", async () => {
  let error: unknown = null
  try {
    await testRender(() => <TickerStructure summary={() => "hello"} />, {})
  } catch (e) {
    error = e
  }
  expect(error).toBeNull()
})

test("switching summary null→value→value→null→value does not throw", async () => {
  const [summary, setSummary] = createSignal<string | null>(null)
  let error: unknown = null
  try {
    await testRender(() => <TickerStructure summary={summary} />, {})
    setSummary("hello")
    setSummary("world")
    setSummary(null)
    setSummary("again")
  } catch (e) {
    error = e
  }
  expect(error).toBeNull()
  expect(summary()).toBe("again")
})
