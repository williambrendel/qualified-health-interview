"use strict";

/**
 * @file ratioEffectiveCount.test.js
 * @brief Tests for the consecutive-ratio effective-count primitive.
 *
 * The function answers "how many top-K items survive the steepest
 * qualifying cliff?" by scanning consecutive ratios `prev/curr` and
 * locating the largest one that clears `minGap`. Tests cover the
 * meaningful regimes (sharp / smooth / multiple cliffs), tie
 * resolution, noise-floor termination, option handling, and edge
 * cases (empty, single element, all-zero, sorted-precondition).
 *
 * Convention reminder: when the steepest qualifying ratio occurs
 * between `hits[i-1]` and `hits[i]`, the function returns `i`. So
 * `hits[0..i-1]` survive and `hits[i..]` are dropped. The smaller
 * item in the cliff pair sits on the dropped side.
 */

const ratioEffectiveCount = require("../../src/VectorStore/ratioEffectiveCount");

const hits = (...scores) => scores.map(score => ({ score }));

// ─────────────────────────────────────────────────────────────────────────────
// Sharp cliffs (single clean elbow)
// ─────────────────────────────────────────────────────────────────────────────

describe("ratioEffectiveCount — sharp cliffs", () => {
  /**
   * A single clean cliff above the default minGap (3) should be
   * detected and cut exactly. Plateau of 3 items then a 4× drop
   * cuts after the plateau: 3 items survive.
   */
  test("plateau then cliff → cut at the cliff", () => {
    // ratios: 1.037, 1.025, 4.0, 1.333
    // The 4.0 cliff between index 2 and 3 is the only one above minGap=3
    expect(ratioEffectiveCount(hits(
      0.85, 0.82, 0.80, 0.20, 0.15,
    ))).toBe(3);
  });

  test("one dominant score with tiny tail → keep just the dominant", () => {
    // ratio between 0.9 and 0.01 = 90 → far above minGap=3 → cut at index 1
    expect(ratioEffectiveCount(hits(
      0.9, 0.01, 0.01, 0.01,
    ))).toBe(1);
  });

  test("two near-equal leaders, then drop → cut after the leaders", () => {
    // ratios: 1.026 (0.8 / 0.78), 15.6 (0.78 / 0.05), 1.25 (0.05 / 0.04)
    // The 15.6 cliff is between index 1 and 2 → cut at 2
    expect(ratioEffectiveCount(hits(
      0.8, 0.78, 0.05, 0.04,
    ))).toBe(2);
  });

  test("cliff exactly at minGap threshold (>=) → cuts", () => {
    // ratio 0.9/0.3 = 3.0 exactly equals default minGap=3 (uses >=)
    expect(ratioEffectiveCount(hits(
      0.9, 0.3, 0.3, 0.3,
    ))).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Smooth descents (no qualifying elbow)
// ─────────────────────────────────────────────────────────────────────────────

describe("ratioEffectiveCount — smooth descents", () => {
  /**
   * When no consecutive ratio clears minGap, no elbow is recorded.
   * Without a noise-floor stop, the function returns `n`.
   */
  test("gradual cosine decay → no cut, keep everything", () => {
    // ratios all ≈ 1.06 — well below minGap=3
    const input = hits(0.85, 0.80, 0.75, 0.70, 0.65);
    expect(ratioEffectiveCount(input)).toBe(input.length);
  });

  test("plateau-only (no descent at all) → no cut", () => {
    // All ratios = 1.0 → no elbow
    const input = hits(0.5, 0.5, 0.5, 0.5);
    expect(ratioEffectiveCount(input)).toBe(input.length);
  });

  test("realistic cosine distribution (peaky-looking but ratio < minGap) → keeps all", () => {
    // From the smoke test: 'efflux pump' top=0.866, gap=0.326 in absolute
    // terms but ratio 0.866/0.540 = 1.60 — below default minGap.
    const input = hits(0.866, 0.540, 0.537, 0.517, 0.512);
    expect(ratioEffectiveCount(input)).toBe(input.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multiple cliffs — steepest wins, with ties going to earliest
// ─────────────────────────────────────────────────────────────────────────────

describe("ratioEffectiveCount — multiple cliffs", () => {
  /**
   * When two ratios both clear minGap, the LARGER one wins (steepest-
   * wins semantic). This favors retrieval precision: the steepest
   * cliff is the strongest "everything below is different" signal,
   * regardless of where it sits in the distribution.
   */
  test("two qualifying cliffs → steepest wins (even if further down)", () => {
    // ratios: 3.6 (0.9/0.25), 1.25 (0.25/0.2), 10.0 (0.2/0.02)
    // Both 3.6 and 10.0 clear minGap=3. The 10.0 is steeper → cut at 3.
    expect(ratioEffectiveCount(hits(
      0.90, 0.25, 0.20, 0.02,
    ))).toBe(3);
  });

  test("earlier cliff is also the steepest → cuts there", () => {
    // ratios: 6.0 (0.9/0.15), 1.5 (0.15/0.10), 1.25 (0.10/0.08)
    // Only the first ratio clears minGap=3; 6.0 wins → cut at 1
    expect(ratioEffectiveCount(hits(
      0.9, 0.15, 0.10, 0.08,
    ))).toBe(1);
  });

  test("equal cliffs → earliest wins (strict > on maxGap)", () => {
    // ratios: 4.0 (0.8/0.2), 1.0 (0.2/0.2), 4.0 (0.2/0.05)
    // Both first and third are 4.0. Strict `>` means the first found
    // wins and isn't displaced by the equal later one → cut at 1.
    expect(ratioEffectiveCount(hits(
      0.8, 0.2, 0.2, 0.05,
    ))).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Noise floor behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("ratioEffectiveCount — noise floor", () => {
  /**
   * Important nuance about the noise-floor protection:
   *
   * The `ac > eps` check is at the TOP of the for-loop. It governs
   * whether the *next* iteration runs, not whether the current
   * iteration's ratio is computed. So an item just above eps will
   * still be VISITED — its ratio with the previous (larger) item
   * computed — and that ratio can register as an elbow.
   *
   * The noise floor only takes effect when the loop tries to advance
   * PAST a near-noise item. That means:
   *   - A score at or below eps is never used as a denominator.
   *   - A score just above eps CAN be used as a denominator,
   *     producing a large ratio (potentially an elbow).
   *
   * In practice this means `eps` defines a hard cutoff for visited
   * items but doesn't filter out the artificial-elbow case at the
   * boundary. Callers wanting to suppress near-noise elbows should
   * raise eps above the smallest score they want considered.
   *
   * NOTE: the docstring describes this as "ratios involving a near-
   * zero denominator would be artificially huge and would register
   * as false elbows" — but the actual implementation only prevents
   * this for items AT OR BELOW eps. Items just above eps still
   * register. Worth a follow-up if the docstring intent should be
   * enforced more strictly.
   */
  test("smooth descent into true noise (≤ eps) → loop stops, no elbow", () => {
    // ratio between 0.80 and 1e-12 is huge, but 1e-12 ≤ default eps
    // so the loop terminates BEFORE visiting it. Result: i=2 at exit.
    expect(ratioEffectiveCount(hits(
      0.85, 0.80, 1e-12,
    ))).toBe(2);
  });

  test("smooth descent into above-eps small value → ratio IS computed (potential false elbow)", () => {
    // 0.001 > default eps=1e-10, so the loop visits it. The ratio
    // 0.80 / 0.001 = 800 registers as an elbow → cuts at index 2.
    // This documents the actual behavior, not necessarily the ideal.
    expect(ratioEffectiveCount(hits(
      0.85, 0.80, 0.001,
    ))).toBe(2);
  });

  test("elbow earlier in scan is overridden by a steeper later cliff", () => {
    // hits(0.8, 0.2, 1e-12): ratios are 4.0 (elbow at index 1) and
    // 0.2/1e-12 ≈ 2e11 (steeper "elbow" at index 2). The algorithm's
    // steepest-wins semantic means the later, larger ratio wins —
    // even though it's the artificial near-noise cliff. The noise-
    // floor termination check doesn't prevent this because 0.2 > eps
    // (so the iteration runs and computes the huge ratio).
    expect(ratioEffectiveCount(hits(
      0.8, 0.2, 1e-12,
    ))).toBe(2);
  });

  test("custom eps raises the truncation point", () => {
    // With eps=0.005, the 0.001 value is below the floor → loop stops
    // before visiting it. Result: i=2 at exit, no elbow recorded.
    expect(ratioEffectiveCount(hits(0.85, 0.80, 0.001), { eps: 0.005 })).toBe(2);
  });

  test("eps clamped to non-negative", () => {
    // Negative eps would be nonsense; the function clamps to 0.
    // With eps=0, the 0.001 is still above the floor, so the ratio
    // computes (0.80/0.001 = 800) and registers as an elbow at index 2.
    expect(ratioEffectiveCount(hits(0.85, 0.80, 0.001), { eps: -1 })).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Option handling: minGap, minLogGap, defaults
// ─────────────────────────────────────────────────────────────────────────────

describe("ratioEffectiveCount — options", () => {
  test("default minGap is 3 (so ratio 2.5 does NOT cut)", () => {
    // ratio 0.5/0.2 = 2.5 — below default minGap=3 → no cut.
    expect(ratioEffectiveCount(hits(0.5, 0.2, 0.18, 0.16))).toBe(4);
  });

  test("custom minGap below typical cosine ratios fires more readily", () => {
    // Same ratios as above (2.5), with minGap=2 it now cuts.
    expect(ratioEffectiveCount(hits(0.5, 0.2, 0.18, 0.16), { minGap: 2 })).toBe(1);
  });

  test("minLogGap is exponentiated to obtain minGap", () => {
    // minLogGap = log(2) ≈ 0.693 → effective minGap = 2.
    // ratio 0.5/0.2 = 2.5 > 2 → cuts at 1.
    expect(ratioEffectiveCount(hits(0.5, 0.2, 0.18, 0.16), {
      minLogGap: Math.log(2),
    })).toBe(1);
  });

  test("explicit minGap takes precedence over minLogGap", () => {
    // If both options are provided, minGap wins.
    // minLogGap implies effective minGap=2 (would cut); but explicit
    // minGap=10 means ratio 2.5 doesn't cut.
    expect(ratioEffectiveCount(hits(0.5, 0.2, 0.18, 0.16), {
      minGap: 10,
      minLogGap: Math.log(2),
    })).toBe(4);
  });

  test("null/undefined options use defaults", () => {
    // Both forms should behave identically to no options at all.
    const input = hits(0.85, 0.80, 0.20, 0.18);
    const noOpts    = ratioEffectiveCount(input);
    const nullOpts  = ratioEffectiveCount(input, null);
    const undefOpts = ratioEffectiveCount(input, undefined);
    expect(nullOpts).toBe(noOpts);
    expect(undefOpts).toBe(noOpts);
  });

  test("partial options object: minGap only", () => {
    expect(ratioEffectiveCount(hits(0.5, 0.2, 0.18), { minGap: 2 })).toBe(1);
  });

  test("partial options object: eps only", () => {
    expect(ratioEffectiveCount(hits(0.85, 0.80, 0.001), { eps: 0.01 })).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases — empty / single / two-element inputs
// ─────────────────────────────────────────────────────────────────────────────

describe("ratioEffectiveCount — edge cases", () => {
  test("empty array returns 0", () => {
    expect(ratioEffectiveCount([])).toBe(0);
  });

  test("single hit returns 1 (no pair to compare → keep what we have)", () => {
    expect(ratioEffectiveCount(hits(0.9))).toBe(1);
  });

  test("two-element flat distribution → no elbow, keep both", () => {
    expect(ratioEffectiveCount(hits(0.5, 0.5))).toBe(2);
  });

  test("two-element sharp drop → elbow detected", () => {
    // ratio 0.9/0.2 = 4.5 > minGap=3 → cut at 1
    expect(ratioEffectiveCount(hits(0.9, 0.2))).toBe(1);
  });

  test("return value is always an integer", () => {
    const inputs = [
      hits(0.9, 0.5, 0.1),
      hits(0.85, 0.82, 0.80, 0.30, 0.25),
      hits(0.5, 0.5, 0.5, 0.5),
      hits(0.9, 0.01),
    ];
    for (const input of inputs) {
      const k = ratioEffectiveCount(input);
      expect(Number.isInteger(k)).toBe(true);
    }
  });

  test("return value is non-negative and ≤ input length", () => {
    const inputs = [
      hits(0.9, 0.5, 0.3, 0.1),
      hits(0.85, 0.80, 0.30, 0.25),
      hits(),
      hits(0.5),
    ];
    for (const input of inputs) {
      const k = ratioEffectiveCount(input);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(input.length);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sorted-descending precondition
// ─────────────────────────────────────────────────────────────────────────────

describe("ratioEffectiveCount — sorted-descending precondition", () => {
  /**
   * The function assumes input is sorted descending. Violating the
   * precondition (passing an unsorted array) produces a result that
   * is computationally valid but useless as a truncation point. The
   * tests here document the behavior — they don't endorse it as
   * correct, but verify it doesn't crash.
   */
  test("ascending input produces a result (likely wrong but doesn't throw)", () => {
    // Ratios will be < 1 (e.g., 0.1/0.5 = 0.2), so no g > maxGap=0
    // after the first iteration → cutIdx stays at n → returns i which
    // is the loop's final value. Just verify no throw and bounded.
    const input = hits(0.1, 0.5, 0.9);
    const k = ratioEffectiveCount(input);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBeLessThanOrEqual(input.length);
  });

  test("trailing zero with positive prefix → noise-floor stops the scan", () => {
    // Sorted descending: positives, then 0. Loop stops at the zero.
    expect(ratioEffectiveCount(hits(0.5, 0.5, 0))).toBe(2);
  });

  test("first hit at or below eps → loop never enters body", () => {
    // The for-loop's continuation condition is `ac > eps`, where
    // initial ac = hits[0].score. If hits[0].score is at or below
    // eps, the loop body never runs. Result is min(cutIdx=n, i=1) = 1.
    // The function doesn't crash, but the result reflects the broken
    // input (head is supposed to be the largest score).
    const k = ratioEffectiveCount(hits(1e-12, 0.5, 0.5));
    expect(Number.isInteger(k)).toBe(true);
    expect(k).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Realistic cosine distributions (from the smoke test)
// ─────────────────────────────────────────────────────────────────────────────

describe("ratioEffectiveCount — realistic cosine distributions", () => {
  /**
   * The smoke test surfaced specific real-world distributions. With
   * the default minGap=3, none of these produce a cut — typical
   * cosine ratios sit well below 3 even on visually peaky
   * distributions. The tests document this and demonstrate how
   * lowering minGap activates the cut.
   */
  test("peaky cosine ('efflux pump' shape, gap=0.326) → no cut at default minGap", () => {
    // Top 0.866 / second 0.540 = 1.60. Below minGap=3 → no cut.
    expect(ratioEffectiveCount(hits(0.866, 0.540, 0.537, 0.517, 0.512))).toBe(5);
  });

  test("same peaky cosine cuts at index 1 with minGap=1.5", () => {
    expect(ratioEffectiveCount(
      hits(0.866, 0.540, 0.537, 0.517, 0.512),
      { minGap: 1.5 },
    )).toBe(1);
  });

  test("flat cosine ('what causes biofilm' shape) → no cut at any reasonable minGap", () => {
    // ratios all ≈ 1.003 — even minGap=1.1 wouldn't cut.
    const input = hits(0.819, 0.816, 0.812, 0.810, 0.807);
    expect(ratioEffectiveCount(input, { minGap: 1.1 })).toBe(input.length);
  });

  test("off-topic cosine (anchor 0.50) → no cut at default minGap", () => {
    // The 'what should I have for dinner' shape — already off-topic,
    // no meaningful cliff anywhere.
    const input = hits(0.504, 0.461, 0.452, 0.451, 0.450);
    expect(ratioEffectiveCount(input)).toBe(input.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export conventions
// ─────────────────────────────────────────────────────────────────────────────

describe("ratioEffectiveCount — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof ratioEffectiveCount).toBe("function");
  });

  test("exposes a self-referential .ratioEffectiveCount property", () => {
    expect(ratioEffectiveCount.ratioEffectiveCount).toBe(ratioEffectiveCount);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(ratioEffectiveCount)).toBe(true);
  });
});
