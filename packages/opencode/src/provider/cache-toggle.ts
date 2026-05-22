/**
 * Runtime toggle for explicit prompt caching (cache_control markers).
 *
 * Default: enabled. When enabled, `applyCaching` in transform.ts adds
 * `cache_control: { type: "ephemeral" }` to system / trailing messages
 * so that providers supporting explicit context caching (Anthropic,
 * DashScope / alibaba-cn, OpenRouter, Bedrock, Copilot …) can reuse
 * prefix tokens across turns.
 *
 * Toggle at runtime with the `/cache` command.
 */

let _enabled = true

export const CacheToggle = {
  get enabled() {
    return _enabled
  },

  enable() {
    _enabled = true
  },

  disable() {
    _enabled = false
  },

  toggle(): boolean {
    _enabled = !_enabled
    return _enabled
  },
}
