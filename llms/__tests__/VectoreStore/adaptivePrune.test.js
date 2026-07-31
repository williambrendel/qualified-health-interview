"use strict";

/**
 * @file adaptivePrune.test.js
 * @brief Tests for the composite adaptive-prune function.
 *
 * `adaptivePrune` composes two measure primitives —
 * `entropyEffectiveCount` and `ratioEffectiveCount` — and truncates
 * the hit list in place to the tighter of the two cuts. The
 * primitives are tested separately; these tests focus on the
 * composition behavior and the mutation semantics.
 *
 * Coverage:
 *   - Returns `min(entropy, ratio)` length on realistic distributions
 *   - In-place truncation (same array reference, modified length)
 *   - Default `minGap` from `RATIO_MIN_GAP` (cosine-tuned at 1.5)
 *   - Option pass-through: caller's `minGap` overrides the default
 *   - `maxCutIndex` propagation to both primitives
 *   - Edge cases: empty, single, two-element inputs
 *   - Realistic cosine distributions from the smoke test
 *   - Module export conventions
 */

const adaptivePrune         = require("../../src/VectorStore/adaptivePrune");
const entropyEffectiveCount = require("../../src/VectorStore/entropyEffectiveCount");
const ratioEffectiveCount   = require("../../src/VectorStore/ratioEffectiveCount");
const { RATIO_MIN_GAP, MAX_CUT_INDEX } = require("../../src/VectorStore/constants");

const hits = (...scores) => scores.map(score => ({ score }));

// ─────────────────────────────────────────────────────────────────────────────
// Composition behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("adaptivePrune — composition", () => {
  /**
   * The defining property: adaptive's result equals
   * `min(entropy(hits), ratio(hits, {minGap: RATIO_MIN_GAP}))`. The
   * tests below verify this on a variety of distribution shapes,
   * exercising the regimes where each measure individually fires.
   */
  test("agrees with min(entropy, ratio) on a sharp cliff", () => {
    // [0.85, 0.82, 0.80, 0.20, 0.15]:
    //   entropy → 5 (no probability-mass concentration)
    //   ratio   → 3 (cliff 0.80/0.20 = 4.0 ≥ 1.5)
    //   min     → 3
    const input = hits(0.85, 0.82, 0.80, 0.20, 0.15);
    const e = entropyEffectiveCount(input);
    const r = ratioEffectiveCount(input, { minGap: RATIO_MIN_GAP });
    const pruned = adaptivePrune(input.slice().map(h => ({ ...h })));
    expect(pruned.length).toBe(Math.min(e, r));
  });

  test("agrees with min(entropy, ratio) on one dominant score", () => {
    // [0.9, 0.01, 0.01, 0.01]:
    //   entropy → 2 (small effective count from concentrated mass)
    //   ratio   → 1 (cliff 0.9/0.01 = 90 ≥ 1.5)
    //   min     → 1
    const input = hits(0.9, 0.01, 0.01, 0.01);
    const e = entropyEffectiveCount(input);
    const r = ratioEffectiveCount(input, { minGap: RATIO_MIN_GAP });
    const pruned = adaptivePrune(input.slice().map(h => ({ ...h })));
    expect(pruned.length).toBe(Math.min(e, r));
    expect(pruned.length).toBe(1);
  });

  test("agrees with min(entropy, ratio) on a smooth descent", () => {
    // [0.85, 0.80, 0.75, 0.70]: ratios ≈ 1.06, all below minGap=1.5
    //   entropy → 4 (no concentration)
    //   ratio   → 4 (no qualifying cliff)
    //   min     → 4
    const input = hits(0.85, 0.80, 0.75, 0.70);
    const e = entropyEffectiveCount(input);
    const r = ratioEffectiveCount(input, { minGap: RATIO_MIN_GAP });
    const pruned = adaptivePrune(input.slice().map(h => ({ ...h })));
    expect(pruned.length).toBe(Math.min(e, r));
    expect(pruned.length).toBe(4);
  });

  test("ratio fires where entropy doesn't (real cosine 'efflux pump')", () => {
    // [0.866, 0.540, 0.537, 0.517, 0.512]:
    //   entropy → 5 (cosine mass is too spread for entropy to react)
    //   ratio   → 1 with minGap=1.5 (0.866/0.540 = 1.60)
    //   adaptive → 1
    const input = hits(0.866, 0.540, 0.537, 0.517, 0.512);
    const pruned = adaptivePrune(input.slice().map(h => ({ ...h })));
    expect(pruned.length).toBe(1);
  });

  test("neither measure fires on a truly flat distribution", () => {
    // [0.819, 0.816, ...]: ratios ≈ 1.003 — well below minGap=1.5
    // entropy ≈ length; ratio = length → adaptive = length
    const input = hits(0.819, 0.816, 0.812, 0.810, 0.807);
    const pruned = adaptivePrune(input.slice().map(h => ({ ...h })));
    expect(pruned.length).toBe(5);
  });

  test("typical 15-section flat distribution → no cut", () => {
    // The 'all queries got 12-15 hits' regime from the smoke test.
    // Neither measure fires; everything survives.
    const scores = [0.95, 0.65, 0.62, 0.60, 0.58, 0.56, 0.55, 0.54, 0.53, 0.52, 0.51, 0.50, 0.49, 0.48, 0.47];
    const input = hits(...scores);
    const pruned = adaptivePrune(input.slice().map(h => ({ ...h })));
    expect(pruned.length).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// In-place mutation semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("adaptivePrune — mutation semantics", () => {
  test("truncates the input array in place", () => {
    const input = hits(0.9, 0.01, 0.01, 0.01);
    const before = input;
    adaptivePrune(input);
    // Same array reference, shortened.
    expect(input).toBe(before);
    expect(input.length).toBe(1);
  });

  test("returns the same array reference", () => {
    const input = hits(0.9, 0.5);
    const returned = adaptivePrune(input);
    expect(returned).toBe(input);
  });

  test("preserves the surviving items (no reorder, no mutation of hit objects)", () => {
    const input = hits(0.85, 0.82, 0.80, 0.20, 0.15);
    const beforeFirst = input[0];
    const beforeSecond = input[1];
    const pruned = adaptivePrune(input);
    // Survivors are still the same object references.
    expect(pruned[0]).toBe(beforeFirst);
    expect(pruned[1]).toBe(beforeSecond);
  });

  test("does not throw on empty array", () => {
    const input = [];
    expect(() => adaptivePrune(input)).not.toThrow();
    expect(input.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Default minGap from RATIO_MIN_GAP
// ─────────────────────────────────────────────────────────────────────────────

describe("adaptivePrune — default minGap", () => {
  /**
   * Adaptive overrides ratio's own default (3) with RATIO_MIN_GAP
   * (1.5), tuned for cosine. Verify both that the constant is what
   * we expect AND that adaptive applies it as the default.
   */
  test("RATIO_MIN_GAP is 1.5", () => {
    expect(RATIO_MIN_GAP).toBe(1.5);
  });

  test("default minGap fires on cosine ratios in [1.5, 3) range", () => {
    // Ratio 0.866/0.540 = 1.60 — wouldn't fire at ratio's own
    // default minGap=3, but DOES fire at RATIO_MIN_GAP=1.5.
    const input = hits(0.866, 0.540, 0.537, 0.517, 0.512);
    const pruned = adaptivePrune(input);
    expect(pruned.length).toBe(1);
  });

  test("caller's minGap overrides RATIO_MIN_GAP", () => {
    // Same input, but with caller's stricter minGap=3 — the cliff
    // 1.60 doesn't qualify, no cut from ratio. Entropy doesn't
    // fire either on this cosine distribution, so adaptive returns
    // the full length.
    const input = hits(0.866, 0.540, 0.537, 0.517, 0.512);
    const pruned = adaptivePrune(input, { minGap: 3 });
    expect(pruned.length).toBe(5);
  });

  test("caller's lower minGap fires more aggressively than the default", () => {
    // Ratio 0.85/0.75 = 1.13 — below RATIO_MIN_GAP=1.5, no cut.
    // With caller's minGap=1.1, this ratio qualifies → cut at 1.
    const input1 = hits(0.85, 0.75, 0.70, 0.65);
    const pruned1 = adaptivePrune(input1);
    expect(pruned1.length).toBeGreaterThan(1);

    const input2 = hits(0.85, 0.75, 0.70, 0.65);
    const pruned2 = adaptivePrune(input2, { minGap: 1.1 });
    expect(pruned2.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Option pass-through
// ─────────────────────────────────────────────────────────────────────────────

describe("adaptivePrune — option pass-through", () => {
  test("eps option propagates to ratio's noise floor", () => {
    // Default eps=1e-10 → 0.001 is above noise, scanned as data.
    // Custom eps=0.005 → 0.001 is below floor, loop stops at i=2.
    const input1 = hits(0.85, 0.80, 0.001);
    const pruned1 = adaptivePrune(input1.slice().map(h => ({ ...h })));
    // Loop visits 0.001, computes ratio 800, registers as elbow at 2.
    expect(pruned1.length).toBe(2);

    const input2 = hits(0.85, 0.80, 0.001);
    const pruned2 = adaptivePrune(input2.slice().map(h => ({ ...h })), { eps: 0.005 });
    // Loop stops at i=2 before visiting 0.001. No elbow. Result = i = 2.
    expect(pruned2.length).toBe(2);
  });

  test("minLogGap option propagates to ratio", () => {
    // minLogGap = log(1.1) ≈ 0.0953 → effective minGap = 1.1
    // Ratio 0.85/0.75 = 1.13 ≥ 1.1 → cut at 1.
    const input = hits(0.85, 0.75, 0.70, 0.65);
    const pruned = adaptivePrune(input, { minLogGap: Math.log(1.1) });
    expect(pruned.length).toBe(1);
  });

  test("no options uses internal defaults", () => {
    const input = hits(0.866, 0.540, 0.537, 0.517, 0.512);
    const pruned = adaptivePrune(input);
    // RATIO_MIN_GAP=1.5 → fires.
    expect(pruned.length).toBe(1);
  });

  test("null options is equivalent to no options", () => {
    const input1 = hits(0.866, 0.540, 0.537, 0.517, 0.512);
    const pruned1 = adaptivePrune(input1);

    const input2 = hits(0.866, 0.540, 0.537, 0.517, 0.512);
    const pruned2 = adaptivePrune(input2, null);

    expect(pruned1.length).toBe(pruned2.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// maxCutIndex
// ─────────────────────────────────────────────────────────────────────────────

describe("adaptivePrune — maxCutIndex", () => {
  /**
   * `maxCutIndex` is the caller's optional upper bound on the final
   * cut. It propagates to both entropy (capping its scan) and ratio
   * (further bounded by entropy's result).
   *
   * Default is {@link MAX_CUT_INDEX} (30), a defensive bound on
   * downstream pipeline work and LLM context. The `> 0` check on
   * `options.maxCutIndex` means non-positive explicit values fall
   * back to the default rather than dropping everything — passing
   * 0 or -1 to mean "drop everything" is rarely the intent and
   * would silently break callers.
   */
  test("caps the result at the supplied maxCutIndex", () => {
    // [0.85, 0.80, 0.75, 0.70, 0.65]: smooth descent, no cliff,
    // entropy would say 5. With maxCutIndex=2, cap kicks in.
    const input = hits(0.85, 0.80, 0.75, 0.70, 0.65);
    const pruned = adaptivePrune(input, { maxCutIndex: 2 });
    expect(pruned.length).toBeLessThanOrEqual(2);
  });

  test("non-positive maxCutIndex falls back to MAX_CUT_INDEX default", () => {
    // Passing 0 or negative should NOT silently drop everything.
    // The function falls back to the default MAX_CUT_INDEX. With a
    // small input (5 items) that's well under 30, the result is
    // whatever the measures would produce without any cap.
    const input1 = hits(0.85, 0.82, 0.80, 0.20, 0.15);
    const pruned1 = adaptivePrune(input1.slice().map(h => ({ ...h })), { maxCutIndex: 0 });
    expect(pruned1.length).toBe(3);

    const input2 = hits(0.85, 0.82, 0.80, 0.20, 0.15);
    const pruned2 = adaptivePrune(input2.slice().map(h => ({ ...h })), { maxCutIndex: -1 });
    expect(pruned2.length).toBe(3);
  });

  test("maxCutIndex larger than input length is harmless", () => {
    const input = hits(0.9, 0.5);
    const pruned = adaptivePrune(input, { maxCutIndex: 100 });
    expect(pruned.length).toBeLessThanOrEqual(input.length);
  });

  test("maxCutIndex tighter than measure result wins", () => {
    // [0.85, 0.82, 0.80, 0.20, 0.15] — ratio would cut at 3.
    // With maxCutIndex=1, the cap is tighter than ratio's result.
    const input = hits(0.85, 0.82, 0.80, 0.20, 0.15);
    const pruned = adaptivePrune(input, { maxCutIndex: 1 });
    expect(pruned.length).toBeLessThanOrEqual(1);
  });

  test("default cap (MAX_CUT_INDEX=30) bounds oversized flat inputs", () => {
    // 50 flat scores — no cliff for ratio, entropy would say ~50.
    // Without any cap, adaptive prune would return all 50. With the
    // MAX_CUT_INDEX=30 default, output is bounded.
    const input = hits(...Array(50).fill(0.5));
    const pruned = adaptivePrune(input);
    expect(pruned.length).toBeLessThanOrEqual(MAX_CUT_INDEX);
    expect(pruned.length).toBe(30);
  });

  test("caller can override default cap with a larger value", () => {
    // Same oversized flat input, but caller explicitly asks for
    // a wider window. Result respects the explicit override.
    const input = hits(...Array(50).fill(0.5));
    const pruned = adaptivePrune(input, { maxCutIndex: 50 });
    expect(pruned.length).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("adaptivePrune — edge cases", () => {
  test("empty array stays empty", () => {
    const input = [];
    const pruned = adaptivePrune(input);
    expect(pruned.length).toBe(0);
    expect(pruned).toBe(input);
  });

  test("single hit is preserved", () => {
    const input = hits(0.9);
    const pruned = adaptivePrune(input);
    expect(pruned.length).toBe(1);
  });

  test("two-element flat distribution → both kept", () => {
    const input = hits(0.5, 0.5);
    const pruned = adaptivePrune(input);
    expect(pruned.length).toBe(2);
  });

  test("two-element sharp drop → top kept", () => {
    // Ratio 0.9/0.05 = 18 ≥ 1.5 → cut at 1.
    // Entropy on two such items: log(sum=0.95) + (-0.9·log0.9 - 0.05·log0.05)/0.95
    // = log(0.95) + (0.0948 + 0.1498)/0.95 ≈ -0.051 + 0.2575 = 0.2065
    // exp(0.2065) ≈ 1.23 → ceil → 2. So entropy says 2.
    // min(1, 2) = 1.
    const input = hits(0.9, 0.05);
    const pruned = adaptivePrune(input);
    expect(pruned.length).toBe(1);
  });

  test("all-zero array returns empty", () => {
    const input = hits(0, 0, 0);
    const pruned = adaptivePrune(input);
    expect(pruned.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export conventions
// ─────────────────────────────────────────────────────────────────────────────

describe("adaptivePrune — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof adaptivePrune).toBe("function");
  });

  test("exposes a self-referential .adaptivePrune property", () => {
    expect(adaptivePrune.adaptivePrune).toBe(adaptivePrune);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(adaptivePrune)).toBe(true);
  });
});