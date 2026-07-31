"use strict";

const { l2, l2Unsafe, l2Squared, l2SquaredUnsafe } = require("../../../src/utilities/math/l2");

// ─────────────────────────────────────────────────────────────────────────────
// l2SquaredUnsafe
// ─────────────────────────────────────────────────────────────────────────────

describe("l2SquaredUnsafe", () => {
  // ── dim guard ─────────────────────────────────────────────────────────────

  test("dim=0 — returns 0", () => {
    expect(l2SquaredUnsafe([3, 4], 0, 0)).toBe(0);
  });

  // ── small dim (remainder-only path) ───────────────────────────────────────

  test("dim=1", () => {
    expect(l2SquaredUnsafe([5], 1, 0)).toBe(25);
  });

  test("dim=2", () => {
    expect(l2SquaredUnsafe([3, 4], 2, 0)).toBe(25);
  });

  test("dim=3", () => {
    // 1+4+9 = 14
    expect(l2SquaredUnsafe([1, 2, 3], 3, 0)).toBe(14);
  });

  test("dim=3 — unit vector", () => {
    expect(l2SquaredUnsafe([1, 0, 0], 3, 0)).toBe(1);
  });

  test("dim=3 — zero vector", () => {
    expect(l2SquaredUnsafe([0, 0, 0], 3, 0)).toBe(0);
  });

  // ── unrolled + remainder path ─────────────────────────────────────────────

  test("dim=5 — one unrolled iteration + 1 remainder", () => {
    // 1+4+9+16+25 = 55
    expect(l2SquaredUnsafe([1, 2, 3, 4, 5], 5, 0)).toBe(55);
  });

  test("dim=8 — two unrolled iterations", () => {
    // 1+4+9+16+25+36+49+64 = 204
    expect(l2SquaredUnsafe([1, 2, 3, 4, 5, 6, 7, 8], 8, 0)).toBe(204);
  });

  // ── sub-range ─────────────────────────────────────────────────────────────

  test("sub-range with offset", () => {
    // v[1..2] = 3²+4² = 25
    expect(l2SquaredUnsafe([0, 3, 4], 2, 1)).toBe(25);
  });

  // ── misc ──────────────────────────────────────────────────────────────────

  test("negative values — squares are positive", () => {
    expect(l2SquaredUnsafe([-3, -4], 2, 0)).toBe(25);
  });

  test("exposed as l2.l2SquaredUnsafe", () => {
    expect(l2.l2SquaredUnsafe).toBe(l2SquaredUnsafe);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// l2Squared (safe)
// ─────────────────────────────────────────────────────────────────────────────

describe("l2Squared", () => {
  // ── input validation ──────────────────────────────────────────────────────

  test("empty array — returns 0", () => {
    expect(l2Squared([])).toBe(0);
  });

  test("null input — returns 0", () => {
    expect(l2Squared(null)).toBe(0);
  });

  test("non-array — returns 0", () => {
    expect(l2Squared("hello")).toBe(0);
  });

  // ── dim guard ─────────────────────────────────────────────────────────────

  test("dim=0 explicit — returns 0", () => {
    expect(l2Squared([3, 4], 0)).toBe(0);
  });

  test("dim omitted — defaults to v.length", () => {
    expect(l2Squared([3, 4])).toBe(25);
  });

  // ── small dim ─────────────────────────────────────────────────────────────

  test("dim=2", () => {
    expect(l2Squared([3, 4])).toBe(25);
  });

  test("dim=3", () => {
    expect(l2Squared([1, 2, 3])).toBe(14);
  });

  test("zero vector", () => {
    expect(l2Squared([0, 0, 0])).toBe(0);
  });

  // ── larger dim ────────────────────────────────────────────────────────────

  test("dim=5", () => {
    expect(l2Squared([1, 2, 3, 4, 5])).toBe(55);
  });

  test("dim=8", () => {
    expect(l2Squared([1, 2, 3, 4, 5, 6, 7, 8])).toBe(204);
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  test("explicit dim smaller than vector length", () => {
    // Only [3,4]: 9+16=25
    expect(l2Squared([3, 4, 99], 2)).toBe(25);
  });

  test("sub-range with offset", () => {
    expect(l2Squared([0, 3, 4], 2, 1)).toBe(25);
  });

  test("negative values — squares are positive", () => {
    expect(l2Squared([-3, -4])).toBe(25);
  });

  test("negative offset clamped to 0", () => {
    expect(l2Squared([3, 4], 2, -5)).toBe(25);
  });

  test("exposed as l2.l2Squared", () => {
    expect(l2.l2Squared).toBe(l2Squared);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// l2Unsafe
// ─────────────────────────────────────────────────────────────────────────────

describe("l2Unsafe", () => {
  test("dim=0 — returns 0", () => {
    expect(l2Unsafe([3, 4], 0, 0)).toBe(0);
  });

  test("dim=2", () => {
    expect(l2Unsafe([3, 4], 2, 0)).toBe(5);
  });

  test("dim=3", () => {
    // √14
    expect(l2Unsafe([1, 2, 3], 3, 0)).toBeCloseTo(Math.sqrt(14));
  });

  test("unit vector", () => {
    expect(l2Unsafe([1, 0, 0], 3, 0)).toBe(1);
  });

  test("zero vector — returns 0", () => {
    expect(l2Unsafe([0, 0, 0], 3, 0)).toBe(0);
  });

  test("sub-range with offset", () => {
    expect(l2Unsafe([0, 3, 4], 2, 1)).toBe(5);
  });

  test("negative values — magnitude is positive", () => {
    expect(l2Unsafe([-3, -4], 2, 0)).toBe(5);
  });

  test("dim=8", () => {
    expect(l2Unsafe([1, 2, 3, 4, 5, 6, 7, 8], 8, 0)).toBeCloseTo(Math.sqrt(204));
  });

  test("exposed as l2.l2Unsafe", () => {
    expect(l2.l2Unsafe).toBe(l2Unsafe);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// l2 (safe)
// ─────────────────────────────────────────────────────────────────────────────

describe("l2", () => {
  // ── input validation ──────────────────────────────────────────────────────

  test("empty array — returns 0", () => {
    expect(l2([])).toBe(0);
  });

  test("null input — returns 0", () => {
    expect(l2(null)).toBe(0);
  });

  test("non-array — returns 0", () => {
    expect(l2(42)).toBe(0);
  });

  // ── dim guard ─────────────────────────────────────────────────────────────

  test("dim=0 explicit — returns 0", () => {
    expect(l2([3, 4], 0)).toBe(0);
  });

  test("dim omitted — defaults to v.length", () => {
    expect(l2([3, 4])).toBe(5);
  });

  // ── small dim ─────────────────────────────────────────────────────────────

  test("dim=2", () => {
    expect(l2([3, 4])).toBe(5);
  });

  test("dim=3", () => {
    expect(l2([1, 2, 3])).toBeCloseTo(Math.sqrt(14));
  });

  test("unit vector", () => {
    expect(l2([1, 0, 0])).toBe(1);
  });

  test("zero vector — returns 0", () => {
    expect(l2([0, 0, 0])).toBe(0);
  });

  // ── larger dim ────────────────────────────────────────────────────────────

  test("dim=5", () => {
    expect(l2([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(55));
  });

  test("dim=8", () => {
    expect(l2([1, 2, 3, 4, 5, 6, 7, 8])).toBeCloseTo(Math.sqrt(204));
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  test("explicit dim smaller than vector length", () => {
    expect(l2([3, 4, 99], 2)).toBe(5);
  });

  test("sub-range with offset", () => {
    expect(l2([0, 3, 4], 2, 1)).toBe(5);
  });

  test("negative values — magnitude is positive", () => {
    expect(l2([-3, -4])).toBe(5);
  });

  test("negative offset clamped to 0", () => {
    expect(l2([3, 4], 2, -5)).toBe(5);
  });

  test("l2.l2Squared alias", () => {
    expect(l2.l2Squared([3, 4])).toBe(25);
  });
});