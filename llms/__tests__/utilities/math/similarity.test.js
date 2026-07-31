"use strict";

const { similarity, similarityUnsafe } = require("../../../src/utilities/math/similarity");

const EPSILON = 1e-10;
const approx  = (a, b) => Math.abs(a - b) < EPSILON;

// ─────────────────────────────────────────────────────────────────────────────
// similarityUnsafe
// ─────────────────────────────────────────────────────────────────────────────

describe("similarityUnsafe", () => {
  // ── dot product mode ──────────────────────────────────────────────────────

  test("normalize: false — dim=3", () => {
    expect(similarityUnsafe([1, 2, 3], [4, 5, 6], { dim: 3, offset1: 0, offset2: 0, normalize: false })).toBe(32);
  });

  test("normalize: false — dim=5", () => {
    expect(similarityUnsafe([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], { dim: 5, offset1: 0, offset2: 0, normalize: false })).toBe(55);
  });

  // ── cosine mode ───────────────────────────────────────────────────────────

  test("normalize: true — known angle dim=3", () => {
    expect(approx(
      similarityUnsafe([1, 2, 3], [4, 5, 6], { dim: 3, offset1: 0, offset2: 0, normalize: true }),
      32 / Math.sqrt(14 * 77)
    )).toBe(true);
  });

  test("normalize: true — identical direction", () => {
    expect(approx(
      similarityUnsafe([1, 2, 3], [2, 4, 6], { dim: 3, offset1: 0, offset2: 0, normalize: true }),
      1
    )).toBe(true);
  });

  test("normalize: true — orthogonal", () => {
    expect(approx(
      similarityUnsafe([1, 0], [0, 1], { dim: 2, offset1: 0, offset2: 0, normalize: true }),
      0
    )).toBe(true);
  });

  test("normalize: true — opposite direction", () => {
    expect(approx(
      similarityUnsafe([1, 0], [-1, 0], { dim: 2, offset1: 0, offset2: 0, normalize: true }),
      -1
    )).toBe(true);
  });

  // ── sub-range ─────────────────────────────────────────────────────────────

  test("sub-range — dot product", () => {
    // v1[2..3] · v2[1..2] = 2*4 + 3*5 = 23
    expect(similarityUnsafe([0, 1, 2, 3], [0, 4, 5, 6], { dim: 2, offset1: 2, offset2: 1, normalize: false })).toBe(23);
  });

  test("sub-range — cosine", () => {
    // v1[2..4] parallel to v2[1..3]
    const v1 = [0, 0, 1, 2, 3];
    const v2 = [0, 2, 4, 6];
    expect(approx(
      similarityUnsafe(v1, v2, { dim: 3, offset1: 2, offset2: 1, normalize: true }),
      1
    )).toBe(true);
  });

  test("exposed as similarity.similarityUnsafe", () => {
    expect(similarity.similarityUnsafe).toBe(similarityUnsafe);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// similarity (safe)
// ─────────────────────────────────────────────────────────────────────────────

describe("similarity", () => {
  // ── input normalization ───────────────────────────────────────────────────

  test("v1 falsy — falls back to v2", () => {
    expect(similarity(null, [3, 4])).toBe(25);
  });

  test("v2 falsy — falls back to v1", () => {
    expect(similarity([3, 4], null)).toBe(25);
  });

  test("both falsy — returns 0", () => {
    expect(similarity(null, null)).toBe(0);
  });

  test("non-array inputs — returns 0", () => {
    expect(similarity(42, "hello")).toBe(0);
  });

  test("empty arrays — returns 0", () => {
    expect(similarity([], [])).toBe(0);
  });

  // ── dim guard ─────────────────────────────────────────────────────────────

  test("dim=0 explicit — returns 0 without computing", () => {
    expect(similarity([1, 2, 3], [4, 5, 6], { dim: 0 })).toBe(0);
  });

  test("dim omitted — defaults to Math.min(v1.length, v2.length)", () => {
    expect(similarity([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  // ── dot product mode ──────────────────────────────────────────────────────

  test("no options — raw dot product", () => {
    expect(similarity([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  test("normalize: false explicit", () => {
    expect(similarity([1, 2, 3], [4, 5, 6], { normalize: false })).toBe(32);
  });

  test("single vector — squared magnitude", () => {
    expect(similarity([3, 4])).toBe(25);
  });

  // ── cosine mode ───────────────────────────────────────────────────────────

  test("normalize: true — known angle", () => {
    expect(approx(similarity([1, 2, 3], [4, 5, 6], { normalize: true }), 32 / Math.sqrt(14 * 77))).toBe(true);
  });

  test("normalize: true — identical direction", () => {
    expect(approx(similarity([1, 2, 3], [2, 4, 6], { normalize: true }), 1)).toBe(true);
  });

  test("normalize: true — orthogonal", () => {
    expect(approx(similarity([1, 0], [0, 1], { normalize: true }), 0)).toBe(true);
  });

  test("normalize: true — opposite direction", () => {
    expect(approx(similarity([1, 0], [-1, 0], { normalize: true }), -1)).toBe(true);
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  test("zero vector dot product", () => {
    expect(similarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  test("explicit dim smaller than vector length", () => {
    // [1,2] · [4,5] = 14
    expect(similarity([1, 2, 99], [4, 5, 99], { dim: 2 })).toBe(14);
  });

  test("sub-range with offsets — dot product", () => {
    // v1[2..3] · v2[1..2] = 2*4 + 3*5 = 23
    expect(similarity([0, 1, 2, 3], [0, 4, 5, 6], { dim: 2, offset1: 2, offset2: 1 })).toBe(23);
  });

  test("sub-range with offsets — cosine", () => {
    const v1 = [0, 0, 1, 2, 3];
    const v2 = [0, 2, 4, 6];
    expect(approx(similarity(v1, v2, { dim: 3, offset1: 2, offset2: 1, normalize: true }), 1)).toBe(true);
  });

  test("partial options — missing fields get defaults", () => {
    expect(similarity([1, 2, 3], [4, 5, 6], { normalize: false })).toBe(32);
  });

  test("negative values", () => {
    expect(similarity([-1, -2], [3, 4])).toBe(-11);
  });

  test("dim=5 — one unrolled + remainder", () => {
    expect(similarity([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBe(55);
  });

  test("dim=8 — two full unrolled iterations", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(similarity(v, v)).toBe(204);
  });

  test("cosine result stays in [-1, 1]", () => {
    const result = similarity([3, 1, -2, 5], [1, 4, 2, -1], { normalize: true });
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });
});