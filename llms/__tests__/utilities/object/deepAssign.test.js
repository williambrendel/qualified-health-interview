"use strict";

const { deepAssign } = require("../../../src/utilities/object/deepAssign");

describe("deepAssign", () => {
  // ── no mutation ───────────────────────────────────────────────────────────

  test("does not mutate base", () => {
    const base = { a: 1 };
    deepAssign(base, { b: 2 });
    expect(base).toEqual({ a: 1 });
  });

  test("does not mutate override", () => {
    const override = { b: 2 };
    deepAssign({ a: 1 }, override);
    expect(override).toEqual({ b: 2 });
  });

  // ── single source ─────────────────────────────────────────────────────────

  test("single source — returns copy of base", () => {
    expect(deepAssign({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("base only — result is not same reference", () => {
    const base = { a: 1 };
    expect(deepAssign(base)).not.toBe(base);
  });

  // ── shallow merge ─────────────────────────────────────────────────────────

  test("override wins on conflict", () => {
    expect(deepAssign({ a: 1, b: 2 }, { b: 99 })).toEqual({ a: 1, b: 99 });
  });

  test("adds new keys from override", () => {
    expect(deepAssign({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("override with same value — no change", () => {
    expect(deepAssign({ a: 1 }, { a: 1 })).toEqual({ a: 1 });
  });

  // ── deep merge ────────────────────────────────────────────────────────────

  test("nested plain objects — deep merged", () => {
    expect(deepAssign(
      { input: { standard: 3.00, cacheWrite: 3.75, cacheRead: 0.30 } },
      { input: { standard: 2.00 } }
    )).toEqual({ input: { standard: 2.00, cacheWrite: 3.75, cacheRead: 0.30 } });
  });

  test("deeply nested — all levels merged", () => {
    expect(deepAssign(
      { a: { b: { c: 1, d: 2 } } },
      { a: { b: { c: 99 } } }
    )).toEqual({ a: { b: { c: 99, d: 2 } } });
  });

  test("adds new nested key without removing siblings", () => {
    expect(deepAssign(
      { a: { x: 1 } },
      { a: { y: 2 } }
    )).toEqual({ a: { x: 1, y: 2 } });
  });

  test("three-level deep nesting", () => {
    expect(deepAssign(
      { a: { b: { c: { d: 1, e: 2 } } } },
      { a: { b: { c: { d: 99 } } } }
    )).toEqual({ a: { b: { c: { d: 99, e: 2 } } } });
  });

  // ── arrays replaced, not merged ───────────────────────────────────────────

  test("array in override replaces base array entirely", () => {
    expect(deepAssign({ tags: ["a", "b"] }, { tags: ["c"] })).toEqual({ tags: ["c"] });
  });

  test("array in base — override plain object replaces it", () => {
    expect(deepAssign({ x: [1, 2, 3] }, { x: { a: 1 } })).toEqual({ x: { a: 1 } });
  });

  test("plain object in base — override array replaces it", () => {
    expect(deepAssign({ x: { a: 1 } }, { x: [1, 2, 3] })).toEqual({ x: [1, 2, 3] });
  });

  // ── falsy sources skipped ─────────────────────────────────────────────────

  test("null source skipped", () => {
    expect(deepAssign({ a: 1 }, null, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("undefined source skipped", () => {
    expect(deepAssign({ a: 1 }, undefined, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("false source skipped", () => {
    expect(deepAssign({ a: 1 }, false, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("zero source skipped", () => {
    expect(deepAssign({ a: 1 }, 0, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("empty string source skipped", () => {
    expect(deepAssign({ a: 1 }, "", { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  // ── variadic ──────────────────────────────────────────────────────────────

  test("three sources — rightmost wins on conflict", () => {
    expect(deepAssign({ a: 1 }, { a: 2, b: 3 }, { b: 99 })).toEqual({ a: 2, b: 99 });
  });

  test("four sources — left-to-right precedence", () => {
    expect(deepAssign({ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 })).toEqual({ a: 4 });
  });

  test("deep merge across three sources", () => {
    expect(deepAssign(
      { x: { a: 1, b: 2, c: 3 } },
      { x: { a: 10 } },
      { x: { b: 20 } }
    )).toEqual({ x: { a: 10, b: 20, c: 3 } });
  });

  // ── pricing config use case ───────────────────────────────────────────────

  test("pricing partial override — sibling rates preserved", () => {
    expect(deepAssign(
      { input: { standard: 3.00, cacheWrite: 3.75, cacheRead: 0.30 }, batchDiscount: 0.5 },
      { input: { standard: 2.00 }, batchDiscount: 0.4 }
    )).toEqual({ input: { standard: 2.00, cacheWrite: 3.75, cacheRead: 0.30 }, batchDiscount: 0.4 });
  });

  test("pricing — override only output rate", () => {
    expect(deepAssign(
      { input: { standard: 3.00 }, output: { standard: 15.00 } },
      { output: { standard: 10.00 } }
    )).toEqual({ input: { standard: 3.00 }, output: { standard: 10.00 } });
  });

  // ── falsy base ────────────────────────────────────────────────────────────

  test("null base — treated as empty object", () => {
    expect(deepAssign(null, { a: 1 })).toEqual({ a: 1 });
  });

  test("undefined base — treated as empty object", () => {
    expect(deepAssign(undefined, { a: 1 })).toEqual({ a: 1 });
  });

  // ── primitive values ──────────────────────────────────────────────────────

  test("null value in override — sets key to null", () => {
    expect(deepAssign({ a: 1 }, { a: null })).toEqual({ a: null });
  });

  test("zero value in override — sets key to 0", () => {
    expect(deepAssign({ a: 1 }, { a: 0 })).toEqual({ a: 0 });
  });

  test("false value in override — sets key to false", () => {
    expect(deepAssign({ a: true }, { a: false })).toEqual({ a: false });
  });

  test("empty string value — sets key to empty string", () => {
    expect(deepAssign({ a: "hello" }, { a: "" })).toEqual({ a: "" });
  });

  // ── frozen export ─────────────────────────────────────────────────────────

  test("frozen — cannot add properties", () => {
    const mod = require("../../../src/utilities/object/deepAssign");
    expect(() => { mod.foo = 1; }).toThrow();
  });

  test("named export matches default", () => {
    const mod = require("../../../src/utilities/object/deepAssign");
    expect(mod.deepAssign).toBe(mod);
  });
});
