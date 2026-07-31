"use strict";

const { cosine, cosineUnsafe } = require("../../../src/utilities/math/cosine");

const EPSILON = 1e-10;
const approx  = (a, b) => Math.abs(a - b) < EPSILON;

// ─────────────────────────────────────────────────────────────────────────────
// cosineUnsafe
// ─────────────────────────────────────────────────────────────────────────────

describe("cosineUnsafe", () => {
  // ── fast path ─────────────────────────────────────────────────────────────

  test("same reference and offset — fast path returns 1", () => {
    const v = [1, 2, 3];
    expect(cosineUnsafe(v, v, 3, 0, 0)).toBe(1);
  });

  test("same reference different offset — no fast path", () => {
    // v[0..1] = [1,0], v[2..3] = [0,1] — orthogonal
    const v = [1, 0, 0, 1];
    expect(approx(cosineUnsafe(v, v, 2, 0, 2), 0)).toBe(true);
  });

  // ── dim guard ─────────────────────────────────────────────────────────────

  test("dim=0 — returns 0", () => {
    expect(cosineUnsafe([1, 2, 3], [4, 5, 6], 0, 0, 0)).toBe(0);
  });

  // ── small dim (remainder-only path) ───────────────────────────────────────

  test("dim=1", () => {
    expect(approx(cosineUnsafe([2], [5], 1, 0, 0), 1)).toBe(true);
  });

  test("dim=2 — identical direction", () => {
    expect(approx(cosineUnsafe([1, 2], [2, 4], 2, 0, 0), 1)).toBe(true);
  });

  test("dim=2 — orthogonal", () => {
    expect(approx(cosineUnsafe([1, 0], [0, 1], 2, 0, 0), 0)).toBe(true);
  });

  test("dim=2 — opposite direction", () => {
    expect(approx(cosineUnsafe([1, 0], [-1, 0], 2, 0, 0), -1)).toBe(true);
  });

  test("dim=3 — known angle", () => {
    // [1,2,3]·[4,5,6]=32; ‖[1,2,3]‖=√14; ‖[4,5,6]‖=√77
    expect(approx(cosineUnsafe([1, 2, 3], [4, 5, 6], 3, 0, 0), 32 / Math.sqrt(14 * 77))).toBe(true);
  });

  test("dim=3 — identical direction", () => {
    expect(approx(cosineUnsafe([1, 2, 3], [2, 4, 6], 3, 0, 0), 1)).toBe(true);
  });

  // ── unrolled + remainder path ─────────────────────────────────────────────

  test("dim=5 — one unrolled iteration + 1 remainder", () => {
    const v1 = [1, 2, 3, 4, 5];
    const v2 = [2, 4, 6, 8, 10];
    expect(approx(cosineUnsafe(v1, v2, 5, 0, 0), 1)).toBe(true);
  });

  test("dim=8 — two unrolled iterations, no remainder", () => {
    const v1 = [1, 2, 3, 4, 5, 6, 7, 8];
    const v2 = [2, 4, 6, 8, 10, 12, 14, 16];
    expect(approx(cosineUnsafe(v1, v2, 8, 0, 0), 1)).toBe(true);
  });

  // ── zero magnitude ────────────────────────────────────────────────────────

  test("zero v1 magnitude — returns raw dot product (0)", () => {
    expect(cosineUnsafe([0, 0, 0], [1, 2, 3], 3, 0, 0)).toBe(0);
  });

  test("both zero magnitude — returns 0", () => {
    expect(cosineUnsafe([0, 0], [0, 0], 2, 0, 0)).toBe(0);
  });

  // ── sub-range ─────────────────────────────────────────────────────────────

  test("sub-range with offsets", () => {
    // v1[2..4] = [2,4,6], v2[1..3] = [4,8,12] — parallel
    const v1 = [0, 0, 2, 4, 6];
    const v2 = [0, 4, 8, 12];
    expect(approx(cosineUnsafe(v1, v2, 3, 2, 1), 1)).toBe(true);
  });

  // ── misc ──────────────────────────────────────────────────────────────────

  test("result stays in [-1, 1]", () => {
    const result = cosineUnsafe([3, 1, -2, 5], [1, 4, 2, -1], 4, 0, 0);
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  test("negative values", () => {
    expect(approx(cosineUnsafe([-1, -2, -3], [1, 2, 3], 3, 0, 0), -1)).toBe(true);
  });

  test("exposed as cosine.cosineUnsafe", () => {
    expect(cosine.cosineUnsafe).toBe(cosineUnsafe);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cosine (safe)
// ─────────────────────────────────────────────────────────────────────────────

describe("cosine", () => {
  // ── input normalization ───────────────────────────────────────────────────

  test("v1 falsy — falls back to v2, same reference → 1", () => {
    const v = [1, 2, 3];
    expect(cosine(null, v)).toBe(1);
  });

  test("v2 falsy — falls back to v1, same reference → 1", () => {
    const v = [1, 2, 3];
    expect(cosine(v, null)).toBe(1);
  });

  test("both falsy — returns 0", () => {
    expect(cosine(null, null)).toBe(0);
  });

  test("non-array inputs — returns 0", () => {
    expect(cosine(42, "hello")).toBe(0);
  });

  test("empty arrays — returns 0", () => {
    expect(cosine([], [])).toBe(0);
  });

  // ── dim guard ─────────────────────────────────────────────────────────────

  test("dim=0 explicit — returns 0 without computing", () => {
    expect(cosine([1, 2, 3], [4, 5, 6], 0)).toBe(0);
  });

  test("dim omitted — defaults to Math.min(v1.length, v2.length)", () => {
    expect(approx(cosine([1, 2, 3], [2, 4, 6]), 1)).toBe(true);
  });

  // ── fast path ─────────────────────────────────────────────────────────────

  test("same reference — fast path returns 1", () => {
    const v = [1, 2, 3];
    expect(cosine(v, v)).toBe(1);
  });

  test("single vector — self-similarity via same-reference fallback", () => {
    expect(cosine([1, 2, 3])).toBe(1);
  });

  // ── small dim ─────────────────────────────────────────────────────────────

  test("dim=2 — identical direction", () => {
    expect(approx(cosine([1, 2], [2, 4]), 1)).toBe(true);
  });

  test("dim=2 — orthogonal", () => {
    expect(approx(cosine([1, 0], [0, 1]), 0)).toBe(true);
  });

  test("dim=2 — opposite direction", () => {
    expect(approx(cosine([1, 0], [-1, 0]), -1)).toBe(true);
  });

  test("dim=3 — known angle", () => {
    expect(approx(cosine([1, 2, 3], [4, 5, 6]), 32 / Math.sqrt(14 * 77))).toBe(true);
  });

  // ── larger dim ────────────────────────────────────────────────────────────

  test("dim=5 — one unrolled + remainder", () => {
    expect(approx(cosine([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1)).toBe(true);
  });

  test("dim=8 — two unrolled iterations", () => {
    const v1 = [1, 2, 3, 4, 5, 6, 7, 8];
    const v2 = [2, 4, 6, 8, 10, 12, 14, 16];
    expect(approx(cosine(v1, v2), 1)).toBe(true);
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  test("zero vector — returns raw dot product (0)", () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  test("explicit dim smaller than vector length", () => {
    // Only [1,2] vs [2,4] — parallel
    expect(approx(cosine([1, 2, 99], [2, 4, 99], 2), 1)).toBe(true);
  });

  test("sub-range with offsets", () => {
    const v1 = [0, 0, 1, 2, 3];
    const v2 = [0, 2, 4, 6];
    expect(approx(cosine(v1, v2, 3, 2, 1), 1)).toBe(true);
  });

  test("negative offsets clamped to 0 — same reference triggers fast path", () => {
    const v = [1, 2, 3];
    expect(cosine(v, v, 3, -5, -5)).toBe(1);
  });

  test("result stays in [-1, 1]", () => {
    const result = cosine([3, 1, -2, 5], [1, 4, 2, -1]);
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  test("negative values", () => {
    expect(approx(cosine([-1, -2, -3], [1, 2, 3]), -1)).toBe(true);
  });
});