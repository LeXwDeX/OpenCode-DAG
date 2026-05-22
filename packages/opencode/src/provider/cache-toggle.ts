/**
 * Runtime toggle for explicit prompt caching (cache_control markers).
 *
 * Two-level control:
 *   1. Global toggle (master switch) — controlled via `/cache` command.
 *      When disabled, caching is off for ALL agents regardless of per-agent config.
 *   2. Per-agent config (`cache` field in agent definition):
 *      - `true`  → always cache (if global is enabled)
 *      - `false` → never cache
 *      - `"auto"` or undefined → heuristic decision
 *
 * Auto heuristics:
 *   - Subagent with steps ≤ 3: skip (short-lived, cache won't be reused)
 *   - Subagent with steps > 3: cache (multi-turn iteration)
 *   - Primary agent with < 4 messages: skip (prefix too short)
 *   - Primary agent with ≥ 4 messages: cache (long conversation, prefix reuse)
 */

import type { Agent } from "@/agent/agent"

let _globalEnabled = true

export const CacheToggle = {
  /** Global master switch */
  get enabled() {
    return _globalEnabled
  },

  enable() {
    _globalEnabled = true
  },

  disable() {
    _globalEnabled = false
  },

  toggle(): boolean {
    _globalEnabled = !_globalEnabled
    return _globalEnabled
  },

  /**
   * Resolve whether to apply caching for a specific agent call.
   *
   * @param agent - The agent info (mode, steps, cache config)
   * @param messageCount - Number of messages in the conversation
   * @returns true if cache_control markers should be added
   */
  resolve(agent: Agent.Info | undefined, messageCount: number): boolean {
    // Global master switch
    if (!_globalEnabled) return false

    // No agent info → default to enabled
    if (!agent) return true

    // Per-agent explicit config
    const agentCache = agent.cache
    if (agentCache === true) return true
    if (agentCache === false) return false

    // Auto heuristics (agentCache === "auto" or undefined)
    const isSubagent = agent.mode === "subagent"
    const steps = agent.steps ?? 0

    if (isSubagent) {
      // Short-lived subagents: skip caching (won't be reused)
      // Long-running subagents: cache (multi-turn iteration)
      return steps > 3
    }

    // Primary/all agents: cache if conversation is long enough
    return messageCount >= 4
  },
}
