"use strict";

const { isPlainObject } = require("../../../src/utilities/object/isPlainObject");

describe("isPlainObject", () => {
  // ── true cases ────────────────────────────────────────────────────────────

  test("empty object — true", () => {
    expect(isPlainObject({})).toBe(true);
  });

  test("object with keys — true", () => {
    expect(isPlainObject({ a: 1, b: 2 })).toBe(true);
  });

  test("nested object — true", () => {
    expect(isPlainObject({ a: { b: 1 } })).toBe(true);
  });

  test("object with array value — true (object itself is plain)", () => {
    expect(isPlainObject({ tags: [1, 2, 3] })).toBe(true);
  });

  test("Object.create(null) — true (no prototype, still non-null object)", () => {
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  // ── false cases ───────────────────────────────────────────────────────────

  test("null — false", () => {
    expect(isPlainObject(null)).toBe(false);
  });

  test("array — false", () => {
    expect(isPlainObject([1, 2, 3])).toBe(false);
  });

  test("empty array — false", () => {
    expect(isPlainObject([])).toBe(false);
  });

  test("string — false", () => {
    expect(isPlainObject("hello")).toBe(false);
  });

  test("number — false", () => {
    expect(isPlainObject(42)).toBe(false);
  });

  test("zero — false", () => {
    expect(isPlainObject(0)).toBe(false);
  });

  test("boolean true — false", () => {
    expect(isPlainObject(true)).toBe(false);
  });

  test("boolean false — false", () => {
    expect(isPlainObject(false)).toBe(false);
  });

  test("undefined — false", () => {
    expect(isPlainObject(undefined)).toBe(false);
  });

  test("function — false", () => {
    expect(isPlainObject(() => {})).toBe(false);
  });

  test("class instance — true", () => {
    expect(isPlainObject(new Date())).toBe(true);
  });

  test("Map — true", () => {
    expect(isPlainObject(new Map())).toBe(true);
  });

  test("Set — true", () => {
    expect(isPlainObject(new Set())).toBe(true);
  });

  test("RegExp — true", () => {
    expect(isPlainObject(/regex/)).toBe(true);
  });

  // ── frozen export ─────────────────────────────────────────────────────────

  test("frozen — cannot add properties", () => {
    const mod = require("../../../src/utilities/object/isPlainObject");
    expect(() => { mod.foo = 1; }).toThrow();
  });

  test("named export matches default", () => {
    const mod = require("../../../src/utilities/object/isPlainObject");
    expect(mod.isPlainObject).toBe(mod);
  });
});
