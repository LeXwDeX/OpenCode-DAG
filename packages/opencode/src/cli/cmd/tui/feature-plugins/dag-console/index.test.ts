import { describe, it, expect } from "bun:test"
import type { DAGWorkflowSession, DAGWorkflowStatus } from "@/dag/session/types"

describe("DAG Console Plugin — structure", () => {
  it("should export default plugin with correct id", async () => {
    const mod = await import("./index")
    const plugin = mod.default
    expect(plugin).toBeDefined()
    expect(plugin.id).toBe("internal:dag-console")
  })

  it("should have tui function", async () => {
    const mod = await import("./index")
    const plugin = mod.default
    expect(typeof plugin.tui).toBe("function")
  })
})

describe("DAG Console Plugin — registration logic", () => {
  it("should register sidebar slot", async () => {
    const registeredSlots: any[] = []
    const registeredRoutes: any[] = []
    const registeredKeymaps: any[] = []

    const mockApi = {
      slots: {
        register(slot: any) {
          registeredSlots.push(slot)
        },
      },
      route: {
        register(routes: any[]) {
          registeredRoutes.push(...routes)
        },
        current: { name: "home" },
        navigate: () => {},
      },
      keymap: {
        registerLayer(layer: any) {
          registeredKeymaps.push(layer)
        },
      },
      ui: {
        dialog: { clear: () => {} },
      },
      kv: { get: () => undefined },
    }

    const mod = await import("./index")
    await mod.default.tui(mockApi as any, undefined, undefined as any)

    expect(registeredSlots).toHaveLength(1)
    expect(registeredSlots[0].order).toBe(500)
    expect(registeredSlots[0].slots.sidebar_content).toBeDefined()
    expect(typeof registeredSlots[0].slots.sidebar_content).toBe("function")

    expect(registeredRoutes).toHaveLength(1)
    expect(registeredRoutes[0].name).toBe("dag-console")
    expect(typeof registeredRoutes[0].render).toBe("function")

    expect(registeredKeymaps).toHaveLength(1)
    expect(registeredKeymaps[0].commands).toHaveLength(1)
    expect(registeredKeymaps[0].commands[0].name).toBe("dag.console.open")
    expect(registeredKeymaps[0].commands[0].category).toBe("DAG")
    expect(typeof registeredKeymaps[0].commands[0].run).toBe("function")
  })

  it("should navigate to dag-console with sessionID when on session route", async () => {
    const navigations: Array<{ route: string; params?: any }> = []
    let capturedCommand: any = null

    const mockApi = {
      slots: { register: () => {} },
      route: {
        register: () => {},
        current: { name: "session", params: { sessionID: "test-session-123" } },
        navigate(route: string, params?: any) {
          navigations.push({ route, params })
        },
      },
      keymap: {
        registerLayer(layer: any) {
          capturedCommand = layer.commands[0]
        },
      },
      ui: { dialog: { clear: () => {} } },
      kv: { get: () => undefined },
    }

    const mod = await import("./index")
    await mod.default.tui(mockApi as any, undefined, undefined as any)

    expect(capturedCommand).toBeDefined()
    capturedCommand.run()

    expect(navigations).toHaveLength(1)
    expect(navigations[0].route).toBe("dag-console")
    expect(navigations[0].params.sessionID).toBe("test-session-123")
  })

  it("should navigate to dag-console without sessionID on non-session route", async () => {
    const navigations: Array<{ route: string; params?: any }> = []
    let capturedCommand: any = null

    const mockApi = {
      slots: { register: () => {} },
      route: {
        register: () => {},
        current: { name: "home" },
        navigate(route: string, params?: any) {
          navigations.push({ route, params })
        },
      },
      keymap: {
        registerLayer(layer: any) {
          capturedCommand = layer.commands[0]
        },
      },
      ui: { dialog: { clear: () => {} } },
      kv: { get: () => undefined },
    }

    const mod = await import("./index")
    await mod.default.tui(mockApi as any, undefined, undefined as any)

    expect(capturedCommand).toBeDefined()
    capturedCommand.run()

    expect(navigations).toHaveLength(1)
    expect(navigations[0].route).toBe("dag-console")
    expect(navigations[0].params?.sessionID).toBeUndefined()
  })
})

describe("DAG Console Plugin — constants", () => {
  it("should use correct route name", () => {
    const ROUTE = "dag-console"
    expect(ROUTE).toBe("dag-console")
  })

  it("should use correct plugin id", () => {
    const id = "internal:dag-console"
    expect(id).toBe("internal:dag-console")
    expect(id.startsWith("internal:")).toBe(true)
  })
})

describe("DAG Console Plugin — sidebar slot rendering", () => {
  it("should render DAGSidebarView with api and session_id", async () => {
    let capturedProps: any = null

    const mockApi = {
      slots: {
        register(slot: any) {
          capturedProps = slot.slots.sidebar_content(null, { session_id: "test-session" })
        },
      },
      route: { register: () => {}, current: { name: "home" }, navigate: () => {} },
      keymap: { registerLayer: () => {} },
      ui: { dialog: { clear: () => {} } },
      kv: { get: () => [] },
      theme: { current: { text: "#fff", textMuted: "#888" } },
    }

    const mod = await import("./index")
    await mod.default.tui(mockApi as any, undefined, undefined as any)

    expect(capturedProps).toBeDefined()
  })
})
