export const ToolID = "sandbox"
export type ToolID = typeof ToolID

export const StatusToolID = "sandbox_status"
export type StatusToolID = typeof StatusToolID

// Permission key used with ctx.ask. Kept as a plain string so users can allow it
// via config (`permission: { sandbox: "allow" }`) without any central registry.
export const Permission = "sandbox"

export * as SandboxID from "./id"
