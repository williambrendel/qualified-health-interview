"use strict";

const { dotProduct, dotProductUnsafe } = require("../../../src/utilities/math/dotProduct");

// ─────────────────────────────────────────────────────────────────────────────
// dotProductUnsafe
// ─────────────────────────────────────────────────────────────────────────────

describe("dotProductUnsafe", () => {
  // ── fast path ─────────────────────────────────────────────────────────────

  test("same reference and offset — l2SquaredUnsafe fast path", () => {
    const v = [3, 4];
    expect(dotProductUnsafe(v, v, 2, 0, 0)).toBe(25);
  });

  test("same reference different offset — no fast path", () => {
    // v[0..1] · v[2..3] = 1*3 + 2*4 = 11
    const v = [1, 2, 3, 4];
    expect(dotProductUnsafe(v, v, 2, 0, 2)).toBe(11);
  });

  // ── dim guard ─────────────────────────────────────────────────────────────

  test("dim=0 — returns 0", () => {
    expect(dotProductUnsafe([1, 2, 3], [4, 5, 6], 0, 0, 0)).toBe(0);
  });

  // ── small dim (remainder-only path) ───────────────────────────────────────

  test("dim=1", () => {
    expect(dotProductUnsafe([3], [4], 1, 0, 0)).toBe(12);
  });

  test("dim=2", () => {
    // 1*4 + 2*5 = 14
    expect(dotProductUnsafe([1, 2], [4, 5], 2, 0, 0)).toBe(14);
  });

  test("dim=3", () => {
    // 1*4 + 2*5 + 3*6 = 32
    expect(dotProductUnsafe([1, 2, 3], [4, 5, 6], 3, 0, 0)).toBe(32);
  });

  test("dim=3 — zero vector", () => {
    expect(dotProductUnsafe([0, 0, 0], [1, 2, 3], 3, 0, 0)).toBe(0);
  });

  // ── unrolled + remainder path ─────────────────────────────────────────────

  test("dim=5 — one unrolled iteration + 1 remainder", () => {
    // 1+4+9+16+25 = 55
    expect(dotProductUnsafe([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], 5, 0, 0)).toBe(55);
  });

  test("dim=8 — two unrolled iterations, no remainder", () => {
    // 1+4+9+16+25+36+49+64 = 204
    const v = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(dotProductUnsafe(v, v, 8, 0, 0)).toBe(204);
  });

  // ── sub-range ─────────────────────────────────────────────────────────────

  test("sub-range with offsets", () => {
    // v1[2..3] · v2[1..2] = 2*4 + 3*5 = 23
    expect(dotProductUnsafe([0, 1, 2, 3], [0, 4, 5, 6], 2, 2, 1)).toBe(23);
  });

  // ── misc ──────────────────────────────────────────────────────────────────

  test("negative values", () => {
    expect(dotProductUnsafe([-1, -2], [3, 4], 2, 0, 0)).toBe(-11);
  });

  test("exposed as dotProduct.dotProductUnsafe", () => {
    expect(dotProduct.dotProductUnsafe).toBe(dotProductUnsafe);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dotProduct (safe)
// ─────────────────────────────────────────────────────────────────────────────

describe("dotProduct", () => {
  // ── input normalization ───────────────────────────────────────────────────

  test("v1 falsy — falls back to v2", () => {
    expect(dotProduct(null, [3, 4])).toBe(25);
  });

  test("v2 falsy — falls back to v1", () => {
    expect(dotProduct([3, 4], null)).toBe(25);
  });

  test("both falsy — returns 0", () => {
    expect(dotProduct(null, null)).toBe(0);
  });

  test("non-array inputs — returns 0", () => {
    expect(dotProduct(42, "hello")).toBe(0);
  });

  test("empty arrays — returns 0", () => {
    expect(dotProduct([], [])).toBe(0);
  });

  // ── dim guard ─────────────────────────────────────────────────────────────

  test("dim=0 explicit — returns 0 without computing", () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6], 0)).toBe(0);
  });

  test("dim omitted — defaults to Math.min(v1.length, v2.length)", () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  // ── fast path ─────────────────────────────────────────────────────────────

  test("same reference — squared magnitude fast path", () => {
    const v = [3, 4];
    expect(dotProduct(v, v)).toBe(25);
  });

  test("single vector — v2 falls back to v1", () => {
    expect(dotProduct([3, 4])).toBe(25);
  });

  // ── small dim ─────────────────────────────────────────────────────────────

  test("dim=2", () => {
    expect(dotProduct([1, 2], [4, 5])).toBe(14);
  });

  test("dim=3", () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  test("zero vector", () => {
    expect(dotProduct([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  // ── larger dim ────────────────────────────────────────────────────────────

  test("dim=5 — one unrolled + remainder", () => {
    expect(dotProduct([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBe(55);
  });

  test("dim=8 — two full unrolled iterations", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(dotProduct(v, v)).toBe(204);
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  test("explicit dim smaller than vector length", () => {
    // Only [1,2] · [4,5] = 14
    expect(dotProduct([1, 2, 99], [4, 5, 99], 2)).toBe(14);
  });

  test("sub-range with offsets", () => {
    // v1[2..3] · v2[1..2] = 2*4 + 3*5 = 23
    expect(dotProduct([0, 1, 2, 3], [0, 4, 5, 6], 2, 2, 1)).toBe(23);
  });

  test("negative offsets clamped to 0", () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6], 3, -1, -1)).toBe(32);
  });

  test("negative values", () => {
    expect(dotProduct([-1, -2], [3, 4])).toBe(-11);
  });
});