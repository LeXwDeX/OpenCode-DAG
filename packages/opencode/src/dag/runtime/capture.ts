/**
 * DAG structured-output schema registry + validation.
 *
 * The schema for each child session is held in-memory (it comes from the
 * workflow config and is re-registered on recovery). The validated payload
 * is persisted to the `captured_output` column of `workflow_node` via
 * DagStore — surviving process restarts.
 */

const schemas = new Map<string, Record<string, unknown>>()

export function registerCaptureSlot(sessionID: string, schema: Record<string, unknown>): void {
  schemas.set(sessionID, schema)
}

export function hasCaptureSlot(sessionID: string): boolean {
  return schemas.has(sessionID)
}

export function getCaptureSchema(sessionID: string): Record<string, unknown> | undefined {
  return schemas.get(sessionID)
}

export function clearCaptureSlot(sessionID: string): void {
  schemas.delete(sessionID)
}

export function validatePayload(sessionID: string, payload: unknown): { ok: true } | { ok: false; error: string; notAvailable?: boolean } {
  const schema = schemas.get(sessionID)
  if (!schema) return { ok: false, error: "submit_result is not available in this session", notAvailable: true }
  return validateAgainstSchema(payload, schema)
}

export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  const type = schema["type"]
  if (typeof type === "string") {
    if (type === "object" && (typeof value !== "object" || value === null || Array.isArray(value)))
      return { ok: false, error: `expected type "object", got ${Array.isArray(value) ? "array" : typeof value}` }
    if (type === "array" && !Array.isArray(value))
      return { ok: false, error: `expected type "array", got ${typeof value}` }
    if (type === "string" && typeof value !== "string")
      return { ok: false, error: `expected type "string", got ${typeof value}` }
    if (type === "number" && typeof value !== "number")
      return { ok: false, error: `expected type "number", got ${typeof value}` }
    if (type === "integer" && (typeof value !== "number" || !Number.isInteger(value)))
      return { ok: false, error: `expected type "integer", got ${typeof value === "number" && !Number.isInteger(value) ? "non-integer number" : typeof value}` }
    if (type === "boolean" && typeof value !== "boolean")
      return { ok: false, error: `expected type "boolean", got ${typeof value}` }
  }

  const required = schema["required"]
  if (Array.isArray(required) && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const field of required) {
      if (typeof field === "string" && !(field in obj))
        return { ok: false, error: `missing required field: "${field}"` }
    }
  }

  const properties = schema["properties"]
  if (typeof properties === "object" && properties !== null && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const props = properties as Record<string, unknown>
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in obj && typeof propSchema === "object" && propSchema !== null) {
        const result = validateAgainstSchema(obj[key], propSchema as Record<string, unknown>)
        if (!result.ok) return { ok: false, error: `field "${key}": ${result.error}` }
      }
    }
  }

  const items = schema["items"]
  if (Array.isArray(value) && typeof items === "object" && items !== null) {
    for (let i = 0; i < value.length; i++) {
      const result = validateAgainstSchema(value[i], items as Record<string, unknown>)
      if (!result.ok) return { ok: false, error: `item[${i}]: ${result.error}` }
    }
  }

  return { ok: true }
}
