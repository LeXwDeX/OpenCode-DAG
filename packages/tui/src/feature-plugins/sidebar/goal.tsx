import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { Show } from "solid-js"
import { createStore, produce } from "solid-js/store"

const id = "internal:sidebar-goal"

interface GoalState {
  goal: string
  status: string
  turnsUsed: number
  maxTurns: number
}

const STATUS_LABEL: Record<string, string> = {
  active: "进行中",
  achieved: "已达成",
  paused: "已暂停",
}

const tui: TuiPlugin = async (api) => {
  // Store created inside tui() — after the Solid runtime is fully initialized.
  // Module-level createStore was interfering with TUI render init in Windows Terminal.
  const [goals, setGoals] = createStore<Record<string, GoalState>>({})

  function View(props: { api: TuiPluginApi; session_id: string }) {
    const theme = () => props.api.theme.current
    const goal = () => goals[props.session_id]
    const goalText = () => goal()?.goal

    return (
      <Show when={goalText()}>
        {(text) => {
          const g = goal()
          if (!g) return null
          return (
            <box>
              <text fg={theme().text}>{`目标 [${STATUS_LABEL[g.status] ?? g.status}]`}</text>
              <text fg={theme().textMuted}>{text().length > 60 ? text().slice(0, 57) + "..." : text()}</text>
              <text fg={theme().textMuted}>{`${g.turnsUsed}/${g.maxTurns} 轮`}</text>
            </box>
          )
        }}
      </Show>
    )
  }

  const on = api.event.on as (type: string, handler: (event: { type: string; properties: Record<string, unknown> }) => void) => () => void

  on("goal.set", (e) => {
    const p = e.properties
    setGoals(p.sessionID as string, { goal: p.goal as string, status: "active", turnsUsed: 0, maxTurns: p.maxTurns as number })
  })

  on("goal.updated", (e) => {
    const p = e.properties
    setGoals(p.sessionID as string, { goal: p.goal as string, status: p.status as string, turnsUsed: p.turnsUsed as number, maxTurns: p.maxTurns as number })
  })

  on("goal.continued", (e) => {
    const p = e.properties
    setGoals(produce((draft) => {
      const goal = draft[p.sessionID as string]
      if (!goal) return
      goal.turnsUsed = p.turnsUsed as number
      goal.maxTurns = p.maxTurns as number
    }))
  })

  on("goal.achieved", (e) => {
    const p = e.properties
    setGoals(p.sessionID as string, "status", "achieved" as any)
  })

  on("goal.paused", (e) => {
    const p = e.properties
    setGoals(p.sessionID as string, "status", "paused" as any)
  })

  on("goal.cleared", (e) => {
    const p = e.properties
    setGoals(produce((draft) => { delete draft[p.sessionID as string] }))
  })

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
