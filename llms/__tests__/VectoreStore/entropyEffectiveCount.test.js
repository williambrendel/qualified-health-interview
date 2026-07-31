"use strict";

/**
 * @file entropyEffectiveCount.test.js
 * @brief Tests for the Shannon-entropy effective-count primitive.
 *
 * The function answers "how many top-K items carry the signal in this
 * distribution?" via `k = ⌈exp(H)⌉` clamped to `[1, l]`. Tests cover
 * the meaningful regimes (sharp / plateau / uniform), the math
 * identities (exact-k for uniform-over-k), and edge cases (empty,
 * non-positive, single element).
 */

const entropyEffectiveCount = require("../../src/VectorStore/entropyEffectiveCount");

const hits = (...scores) => scores.map(score => ({ score }));

// ─────────────────────────────────────────────────────────────────────────────
// Math identity: uniform distribution → returns exactly k
// ─────────────────────────────────────────────────────────────────────────────

describe("entropyEffectiveCount — uniform distribution", () => {
  /**
   * For a uniform distribution over k items each with mass `c`:
   *   H = -Σ (1/k) · log(1/k) = log(k)
   *   exp(H) = k
   * So the function should return exactly k.
   */
  test("uniform over 1 item → 1", () => {
    expect(entropyEffectiveCount(hits(0.5))).toBe(1);
  });

  test("uniform over 3 items → 3", () => {
    expect(entropyEffectiveCount(hits(0.4, 0.4, 0.4))).toBe(3);
  });

  test("uniform over 10 items → 10", () => {
    const scores = Array(10).fill(0.5);
    expect(entropyEffectiveCount(hits(...scores))).toBe(10);
  });

  test("scale invariance: uniform values can be any positive constant", () => {
    expect(entropyEffectiveCount(hits(0.001, 0.001, 0.001))).toBe(3);
    expect(entropyEffectiveCount(hits(100, 100, 100))).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sharp distribution (one dominant item)
// ─────────────────────────────────────────────────────────────────────────────

describe("entropyEffectiveCount — sharp distributions", () => {
  test("one dominant score with tiny tail → small k", () => {
    const k = entropyEffectiveCount(hits(0.9, 0.01, 0.01, 0.01));
    expect(k).toBeGreaterThanOrEqual(1);
    expect(k).toBeLessThanOrEqual(2);
  });

  test("two near-equal leaders, then drop → k near 2-3", () => {
    const k = entropyEffectiveCount(hits(0.8, 0.78, 0.05, 0.04));
    expect(k).toBeGreaterThanOrEqual(2);
    expect(k).toBeLessThanOrEqual(3);
  });

  test("single hit returns 1", () => {
    expect(entropyEffectiveCount(hits(0.95))).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plateau distribution (relevant cluster + drop)
// ─────────────────────────────────────────────────────────────────────────────

describe("entropyEffectiveCount — plateau distributions", () => {
  test("4-item plateau with negligible tail → k near 4", () => {
    // The tail is two orders of magnitude smaller than the plateau, so
    // its probability mass is negligible and entropy concentrates on
    // the plateau.
    const k = entropyEffectiveCount(hits(
      0.85, 0.82, 0.80, 0.78,    // plateau
      0.01, 0.01, 0.01,           // negligible tail
    ));
    expect(k).toBeGreaterThanOrEqual(3);
    expect(k).toBeLessThanOrEqual(5);
  });

  test("4-item plateau with non-negligible tail → k larger than plateau size", () => {
    // When the tail items still carry meaningful probability mass,
    // entropy reflects that — the effective count is larger than the
    // plateau alone. This documents the real behavior of the function:
    // entropy measures effective spread, not cluster boundary.
    const k = entropyEffectiveCount(hits(
      0.85, 0.82, 0.80, 0.78,    // plateau
      0.30, 0.25, 0.20,           // tail still 25-35% of plateau magnitude
    ));
    expect(k).toBeGreaterThan(4);
    expect(k).toBeLessThanOrEqual(7);
  });

  test("k never exceeds the number of positive scores", () => {
    const k = entropyEffectiveCount(hits(0.5, 0.5, 0.5));
    expect(k).toBeLessThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-positive scores and sorted-descending precondition
// ─────────────────────────────────────────────────────────────────────────────

describe("entropyEffectiveCount — non-positive handling", () => {
  test("trailing zeros are ignored (sorted precondition)", () => {
    // With trailing zeros, function should behave like the positive prefix.
    const withZeros    = entropyEffectiveCount(hits(0.5, 0.5, 0.5, 0, 0));
    const withoutZeros = entropyEffectiveCount(hits(0.5, 0.5, 0.5));
    expect(withZeros).toBe(withoutZeros);
  });

  test("trailing negatives are ignored", () => {
    const withNegs    = entropyEffectiveCount(hits(0.5, 0.5, -0.1, -0.5));
    const withoutNegs = entropyEffectiveCount(hits(0.5, 0.5));
    expect(withNegs).toBe(withoutNegs);
  });

  test("zero scores at the head terminate counting immediately", () => {
    // If the FIRST score is ≤ 0, no positives are accumulated.
    // Strictly speaking this violates the sorted-descending precondition,
    // but the function should still return 0 rather than throw.
    expect(entropyEffectiveCount(hits(0, 0.5, 0.5))).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("entropyEffectiveCount — edge cases", () => {
  test("empty array returns 0", () => {
    expect(entropyEffectiveCount([])).toBe(0);
  });

  test("all-zero array returns 0", () => {
    expect(entropyEffectiveCount(hits(0, 0, 0))).toBe(0);
  });

  test("all-negative array returns 0", () => {
    expect(entropyEffectiveCount(hits(-0.1, -0.2, -0.3))).toBe(0);
  });

  test("return value is always an integer", () => {
    const inputs = [
      hits(0.9, 0.5, 0.1),
      hits(0.85, 0.82, 0.80, 0.30, 0.25),
      hits(0.5, 0.5, 0.5, 0.5),
    ];
    for (const input of inputs) {
      const k = entropyEffectiveCount(input);
      expect(Number.isInteger(k)).toBe(true);
    }
  });

  test("return value is non-negative and ≤ input length", () => {
    const input = hits(0.9, 0.5, 0.3, 0.1);
    const k = entropyEffectiveCount(input);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBeLessThanOrEqual(input.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export conventions
// ─────────────────────────────────────────────────────────────────────────────

describe("entropyEffectiveCount — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof entropyEffectiveCount).toBe("function");
  });

  test("exposes a self-referential .entropyEffectiveCount property", () => {
    expect(entropyEffectiveCount.entropyEffectiveCount).toBe(entropyEffectiveCount);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(entropyEffectiveCount)).toBe(true);
  });
});