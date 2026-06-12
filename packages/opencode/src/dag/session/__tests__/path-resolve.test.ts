// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 the fork author (see NOTICE file for attribution).
// Licensed under GNU AGPL v3; modifications must be open-sourced.

/**
 * WP3B: path-resolve.ts — pure dot-notation resolver unit tests.
 *
 * Tests the shared resolvePath function + PATH_NOT_FOUND sentinel.
 * Pure function: no DB, no Effect, no logging.
 *
 * Acceptance:
 * - Present path → resolved value
 * - Missing segment → PATH_NOT_FOUND
 * - Non-object intermediate → PATH_NOT_FOUND
 * - Array intermediate → PATH_NOT_FOUND
 * - Empty path → return obj itself (matches original algorithm: split("") = [""] )
 */

import { describe, it, expect } from "bun:test"
import { resolvePath, PATH_NOT_FOUND } from "../path-resolve"

describe("resolvePath — present path returns value", () => {
  it("resolves single-segment path", () => {
    expect(resolvePath({ foo: 42 }, "foo")).toBe(42)
  })

  it("resolves multi-segment dot path", () => {
    expect(resolvePath({ a: { b: { c: "deep" } } }, "a.b.c")).toBe("deep")
  })

  it("resolves path to nested object", () => {
    const obj = { x: { y: { z: 1 } } }
    expect(resolvePath(obj, "x.y")).toEqual({ z: 1 })
  })

  it("resolves path to array value", () => {
    expect(resolvePath({ arr: [1, 2] }, "arr")).toEqual([1, 2])
  })

  it("resolves path to null value (null is a valid value)", () => {
    expect(resolvePath({ key: null }, "key")).toBeNull()
  })

  it("resolves path to undefined value", () => {
    // "key" exists in object, even though value is undefined
    const obj: Record<string, unknown> = { key: undefined }
    expect(resolvePath(obj, "key")).toBeUndefined()
  })

  it("resolves path to 0 (falsy but present)", () => {
    expect(resolvePath({ count: 0 }, "count")).toBe(0)
  })

  it("resolves path to empty string", () => {
    expect(resolvePath({ text: "" }, "text")).toBe("")
  })
})

describe("resolvePath — missing segment returns PATH_NOT_FOUND", () => {
  it("top-level key absent", () => {
    expect(resolvePath({ a: 1 }, "b")).toBe(PATH_NOT_FOUND)
  })

  it("nested key absent", () => {
    expect(resolvePath({ a: { b: 1 } }, "a.c")).toBe(PATH_NOT_FOUND)
  })

  it("deeply nested path with missing tail", () => {
    expect(resolvePath({ a: { b: { c: 1 } } }, "a.b.d")).toBe(PATH_NOT_FOUND)
  })
})

describe("resolvePath — non-object intermediate returns PATH_NOT_FOUND", () => {
  it("string intermediate blocks navigation", () => {
    expect(resolvePath({ a: "text" }, "a.b")).toBe(PATH_NOT_FOUND)
  })

  it("number intermediate blocks navigation", () => {
    expect(resolvePath({ a: 42 }, "a.b")).toBe(PATH_NOT_FOUND)
  })

  it("boolean intermediate blocks navigation", () => {
    expect(resolvePath({ a: true }, "a.b")).toBe(PATH_NOT_FOUND)
  })

  it("null intermediate blocks navigation", () => {
    expect(resolvePath({ a: null }, "a.b")).toBe(PATH_NOT_FOUND)
  })
})

describe("resolvePath — array intermediate returns PATH_NOT_FOUND", () => {
  it("array at top-level blocks navigation", () => {
    // The obj itself is a Record, but path segments navigate into arrays
    const obj = { arr: [1, 2, 3] }
    expect(resolvePath(obj, "arr.0")).toBe(PATH_NOT_FOUND)
  })

  it("nested array intermediate blocks", () => {
    const obj = { a: { items: [1, 2] } }
    expect(resolvePath(obj, "a.items.0")).toBe(PATH_NOT_FOUND)
  })
})

describe("resolvePath — empty path behavior", () => {
  it("empty path returns the obj itself (split('') = [''], in-operator finds '' only if explicitly keyed)", () => {
    // "".split(".") = [""], then we check if "" is in the object.
    // For a normal object, "" is not a key → PATH_NOT_FOUND.
    const obj = { foo: 1 }
    expect(resolvePath(obj, "")).toBe(PATH_NOT_FOUND)
  })

  it("empty path with empty-string key present returns value", () => {
    const obj: Record<string, unknown> = { "": "empty-key" }
    expect(resolvePath(obj, "")).toBe("empty-key")
  })
})

describe("resolvePath — purity contract", () => {
  it("does not mutate input object", () => {
    const obj = { a: { b: 1 } }
    const snapshot = JSON.stringify(obj)
    resolvePath(obj, "a.b")
    resolvePath(obj, "a.missing")
    expect(JSON.stringify(obj)).toBe(snapshot)
  })

  it("idempotent", () => {
    const obj = { x: { y: "val" } }
    expect(resolvePath(obj, "x.y")).toBe(resolvePath(obj, "x.y"))
  })
})
