/**
 * WP3 plugin entry 测试
 *
 * 测试策略：
 * - 验证 plugin 结构导出
 * - 验证 route 注册
 * - 验证 session_topbar slot 不再注册（已移除 TAB）
 */
import { describe, it, expect } from "bun:test"

describe("WP3 DAG Workflow Plugin — structure", () => {
  it("should export default plugin with correct id", async () => {
    const mod = await import("./index")
    const plugin = mod.default
    expect(plugin).toBeDefined()
    expect(plugin.id).toBe("internal:dag-workflow")
  })

  it("should have tui function", async () => {
    const mod = await import("./index")
    const plugin = mod.default
    expect(typeof plugin.tui).toBe("function")
  })
})

describe("WP3 DAG Workflow Plugin — registration logic", () => {
  it("should register dag-workflow route", async () => {
    const registeredRoutes: any[] = []

    const mockApi = {
      slots: { register: () => "" },
      route: {
        register(routes: any[]) {
          registeredRoutes.push(...routes)
        },
        current: { name: "home" },
        navigate: () => {},
      },
      keymap: { registerLayer: () => {} },
      ui: { dialog: { clear: () => {} } },
      kv: { get: () => undefined },
      tuiConfig: { lang: "en" },
    }

    const mod = await import("./index")
    await mod.default.tui(mockApi as any, undefined, undefined as any)

    expect(registeredRoutes).toHaveLength(1)
    expect(registeredRoutes[0].name).toBe("dag-workflow")
    expect(typeof registeredRoutes[0].render).toBe("function")
  })

  it("should not register session_topbar slot (removed)", async () => {
    const registeredSlots: any[] = []

    const mockApi = {
      slots: {
        register(slot: any) {
          registeredSlots.push(slot)
          return "slot-id"
        },
      },
      route: { register: () => {}, current: { name: "home" }, navigate: () => {} },
      keymap: { registerLayer: () => {} },
      ui: { dialog: { clear: () => {} } },
      kv: { get: () => undefined },
      tuiConfig: { lang: "en" },
    }

    const mod = await import("./index")
    await mod.default.tui(mockApi as any, undefined, undefined as any)

    expect(registeredSlots).toHaveLength(0)
  })
})
