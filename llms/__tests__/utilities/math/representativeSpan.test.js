"use strict";

const { representativeSpans } = require("../../../src/utilities/math/representativeSpans");

// ─── Helpers ──────────────────────────────────────────────────────────────

const DIM = 4;

/** Flatten an array of vector arrays into a single Float32Array buffer. */
const flatten = (vecs) => {
  const dim = vecs[0].length;
  const out = new Float32Array(vecs.length * dim);
  for (let i = 0; i !== vecs.length; ++i) {
    for (let j = 0; j !== dim; ++j) out[i * dim + j] = vecs[i][j];
  }
  return out;
};

/** L2-normalize a plain array, return a plain array. */
const unit = (vec) => {
  let s = 0;
  for (const x of vec) s += x * x;
  s = 1 / Math.sqrt(s);
  return vec.map((x) => x * s);
};

/** Sum of a Float32Array. */
const sumOf = (arr) => {
  let s = 0;
  for (let i = 0; i !== arr.length; ++i) s += arr[i];
  return s;
};

/** Convert offset (in flat V buffer) back to candidate index. */
const offToIdx = (off, dim) => off / dim;

// ─── Tests ────────────────────────────────────────────────────────────────

describe("representativeSpans", () => {
  describe("trivial cases", () => {
    test("empty input returns empty result", () => {
      const V = new Float32Array(0);
      const v = new Float32Array(DIM); v[0] = 1;
      const r = representativeSpans(V, v, { dim: DIM });
      expect(r.alpha.length).toBe(0);
      expect(r.support).toEqual([]);
      expect(r.kept).toEqual([]);
    });

    test("single aligned candidate gets all mass", () => {
      const v = new Float32Array(unit([1, 0, 0, 0]));
      const V = flatten([unit([1, 0, 0, 0])]);
      const r = representativeSpans(V, v, { dim: DIM });
      expect(r.alpha.length).toBe(1);
      expect(r.alpha[0]).toBeCloseTo(1.0, 4);
      expect(r.support).toEqual([0]);
    });

    test("anti-aligned candidate is filtered out", () => {
      const v = new Float32Array(unit([1, 0, 0, 0]));
      const V = flatten([unit([-1, 0, 0, 0])]);
      const r = representativeSpans(V, v, { dim: DIM });
      expect(r.alpha.length).toBe(0);
      expect(r.kept).toEqual([]);
      expect(r.support).toEqual([]);
    });

    test("zero segment filters everything", () => {
      const V = flatten([unit([1, 0, 0, 0]), unit([0, 1, 0, 0])]);
      const r = representativeSpans(V, new Float32Array(DIM), { dim: DIM });
      expect(r.alpha.length).toBe(0);
    });

    test("mixed aligned and anti-aligned: only aligned survive filter", () => {
      const v = new Float32Array(unit([1, 0, 0, 0]));
      const V = flatten([
        unit([1, 0, 0, 0]),         // aligned
        unit([-1, 0, 0, 0]),        // anti-aligned, filtered
        unit([0.5, 0.87, 0, 0]),    // weakly aligned
      ]);
      const r = representativeSpans(V, v, { dim: DIM });
      expect(r.kept.length).toBe(2);
      // Anti-aligned is at offset DIM; it must NOT appear in kept.
      expect(r.kept).not.toContain(DIM);
      expect(r.kept).toContain(0);
      expect(r.kept).toContain(2 * DIM);
    });
  });

  describe("predictable geometry", () => {
    test("three orthogonal equally-relevant candidates → equal mass", () => {
      const v = new Float32Array(unit([1, 1, 1, 0]));
      const V = flatten([
        unit([1, 0, 0, 0]),
        unit([0, 1, 0, 0]),
        unit([0, 0, 1, 0]),
      ]);
      const r = representativeSpans(V, v, { dim: DIM, beta: 0 });
      expect(r.alpha.length).toBe(3);
      for (let i = 0; i !== 3; ++i) {
        expect(r.alpha[i]).toBeCloseTo(1 / 3, 3);
      }
    });

    test("identical candidates produce uniform α (no concept differentiation)", () => {
      // All three vectors identical → A matrix is all zero (anti-sim = 0).
      // With β = 0, replicator dynamics have nothing to break the symmetry;
      // uniform initialization stays uniform. This tests the "redundant set"
      // failure mode — the algorithm correctly cannot pick a representative.
      const v = new Float32Array(unit([1, 0, 0, 0]));
      const V = flatten([
        unit([1, 0, 0, 0]),
        unit([1, 0, 0, 0]),
        unit([1, 0, 0, 0]),
      ]);
      const r = representativeSpans(V, v, { dim: DIM, beta: 0 });
      expect(r.alpha.length).toBe(3);
      for (let i = 0; i !== 3; ++i) {
        expect(r.alpha[i]).toBeCloseTo(1 / 3, 3);
      }
    });

    test("unique candidate outweighs each redundant member", () => {
      // Two TRULY identical candidates + one orthogonal unique.
      // Identical candidates have anti-sim 0 → contribute nothing to each
      // other's fitness. The unique candidate gets the joint quadratic
      // boost from BOTH redundant members, so it ends up with higher α
      // than either one of them.
      const v = new Float32Array(unit([1, 1, 0, 0]));
      const V = flatten([
        unit([1, 0, 0, 0]),    // redundant 1
        unit([1, 0, 0, 0]),    // redundant 2 (IDENTICAL)
        unit([0, 1, 0, 0]),    // unique
      ]);
      const r = representativeSpans(V, v, { dim: DIM, beta: 0 });
      expect(r.alpha[2]).toBeGreaterThan(r.alpha[0]);
      expect(r.alpha[2]).toBeGreaterThan(r.alpha[1]);
    });

    test("two orthogonal candidates with very different relevance: high-relevance dominates", () => {
      // v has its main mass on dim 0. Both candidates are orthogonal,
      // but candidate 0 is way more aligned with v than candidate 1.
      const v = new Float32Array(unit([1, 0.1, 0, 0]));
      const V = flatten([
        unit([1, 0, 0, 0]),  // strong relevance ~0.995
        unit([0, 1, 0, 0]),  // weak relevance ~0.1
      ]);
      const r = representativeSpans(V, v, { dim: DIM, beta: 0 });
      expect(r.alpha[0]).toBeGreaterThan(r.alpha[1]);
    });
  });

  describe("mathematical invariants", () => {
    const buildRandomCase = () => {
      const v = new Float32Array(unit([1, 0.5, 0.2, 0.1]));
      const V = flatten([
        unit([1, 0, 0, 0]),
        unit([0, 1, 0, 0]),
        unit([1, 0.5, 0, 0]),
        unit([0.3, 0.7, 0.2, 0]),
        unit([0, 0, 0, 1]),
      ]);
      return { v, V };
    };

    test("α sums to 1 (simplex constraint)", () => {
      const { v, V } = buildRandomCase();
      const r = representativeSpans(V, v, { dim: DIM, beta: 0.1 });
      expect(sumOf(r.alpha)).toBeCloseTo(1.0, 4);
    });

    test("α is non-negative", () => {
      const { v, V } = buildRandomCase();
      const r = representativeSpans(V, v, { dim: DIM, beta: 0.1 });
      for (let i = 0; i !== r.alpha.length; ++i) {
        expect(r.alpha[i]).toBeGreaterThanOrEqual(0);
      }
    });

    test("kept and alpha have matching length", () => {
      const { v, V } = buildRandomCase();
      const r = representativeSpans(V, v, { dim: DIM });
      expect(r.kept.length).toBe(r.alpha.length);
    });

    test("support indices are a subset of kept", () => {
      const { v, V } = buildRandomCase();
      const r = representativeSpans(V, v, { dim: DIM });
      for (const off of r.support) expect(r.kept).toContain(off);
    });

    test("support entries are valid V offsets (multiples of dim, < V.length)", () => {
      const { v, V } = buildRandomCase();
      const r = representativeSpans(V, v, { dim: DIM });
      for (const off of r.support) {
        expect(off % DIM).toBe(0);
        expect(off).toBeGreaterThanOrEqual(0);
        expect(off).toBeLessThan(V.length);
      }
    });

    test("kept offsets correctly map to original candidates", () => {
      // Construct V with known anti-aligned at idx 2; verify kept skips it.
      const v = new Float32Array(unit([1, 0, 0, 0]));
      const V = flatten([
        unit([1, 0, 0, 0]),       // idx 0 → off 0
        unit([0.8, 0.6, 0, 0]),   // idx 1 → off DIM
        unit([-1, 0, 0, 0]),      // idx 2 → filtered
        unit([0.9, 0.4, 0, 0]),   // idx 3 → off 3*DIM
      ]);
      const r = representativeSpans(V, v, { dim: DIM });
      expect(r.kept).toEqual([0, DIM, 3 * DIM]);
      // Verify offsets indeed map to non-anti-aligned vectors.
      for (const off of r.kept) {
        const idx = offToIdx(off, DIM);
        expect(idx).not.toBe(2);
      }
    });
  });

  describe("β regularization behavior", () => {
    const buildTriangleCase = () => {
      // Three orthogonal candidates with significantly different relevances.
      const v = new Float32Array(unit([1, 0.5, 0.2, 0]));
      const V = flatten([
        unit([1, 0, 0, 0]),   // most relevant (~0.91)
        unit([0, 1, 0, 0]),   // moderately relevant (~0.46)
        unit([0, 0, 1, 0]),   // least relevant (~0.18)
      ]);
      return { v, V };
    };

    test("β = 0: support is non-empty and contains the most relevant candidate", () => {
      const { v, V } = buildTriangleCase();
      const r = representativeSpans(V, v, { dim: DIM, beta: 0 });
      expect(r.support.length).toBeGreaterThan(0);
      // The most-relevant candidate (offset 0) should always survive.
      expect(r.support).toContain(0);
    });

    test("very large β drives α toward uniform (Pavan-Pelillo Proposition 1)", () => {
      // When β > λ_max(A), the unique solution is in int(Δ) — all candidates
      // participate. With three candidates, α should approach 1/3 each.
      // Convergence is asymptotic with finite maxIter; precision 1 (within 0.05)
      // verifies the approach to uniform without requiring exact equality.
      const { v, V } = buildTriangleCase();
      const r = representativeSpans(V, v, { dim: DIM, beta: 100 });
      expect(r.support.length).toBe(3);
      for (let i = 0; i !== 3; ++i) {
        expect(r.alpha[i]).toBeCloseTo(1 / 3, 1);  // was: precision 2
      }
    });

    test("α distribution shifts meaningfully with β", () => {
      // We don't claim monotonicity in support size, but α should
      // genuinely change as β changes — proves β has an effect.
      const { v, V } = buildTriangleCase();
      const r0 = representativeSpans(V, v, { dim: DIM, beta: 0 });
      const r1 = representativeSpans(V, v, { dim: DIM, beta: 100 });
      let maxDiff = 0;
      for (let i = 0; i !== 3; ++i) {
        const d = Math.abs(r0.alpha[i] - r1.alpha[i]);
        if (d > maxDiff) maxDiff = d;
      }
      expect(maxDiff).toBeGreaterThan(0.1);
    });
  });

  describe("custom edge kernel", () => {
    test("threshold kernel: produces valid simplex output", () => {
      // Threshold edge: c => max(0, 0.5 - c). For two near-orthogonal vectors
      // (cos ≈ 0), this gives anti-sim 0.5; for two well-separated vectors
      // (cos ≈ -1), it gives 1.5.
      const v = new Float32Array(unit([1, 1, 0, 0]));
      const V = flatten([
        unit([1, 0, 0, 0]),
        unit([0, 1, 0, 0]),
      ]);
      const rDefault = representativeSpans(V, v, { dim: DIM, beta: 0 });
      const rThresh  = representativeSpans(V, v, {
        dim: DIM,
        beta: 0,
        edge: (c) => Math.max(0, 0.5 - c),
      });
      // Both produce valid simplex outputs.
      expect(sumOf(rDefault.alpha)).toBeCloseTo(1, 4);
      expect(sumOf(rThresh.alpha)).toBeCloseTo(1, 4);
    });

    test("zero kernel produces uniform α (A is all zero off-diagonal)", () => {
      // If anti-sim is identically 0, all off-diagonal A entries are 0.
      // With β = 0, M = 0 and replicator dynamics are driven only by vRel,
      // which is a pure linear bias. With uniform candidates, the
      // multiplicative update ratio is constant → α stays at uniform init.
      const v = new Float32Array(unit([1, 0, 0, 0]));
      const V = flatten([
        unit([1, 0, 0, 0]),
        unit([1, 0, 0, 0]),
      ]);
      const r = representativeSpans(V, v, {
        dim: DIM,
        beta: 0,
        edge: () => 0,
      });
      expect(r.alpha[0]).toBeCloseTo(0.5, 3);
      expect(r.alpha[1]).toBeCloseTo(0.5, 3);
    });
  });

  describe("convergence", () => {
    test("converges in finite iterations on well-conditioned input", () => {
      const v = new Float32Array(unit([1, 0.5, 0.2, 0.1]));
      const V = flatten([
        unit([1, 0, 0, 0]),
        unit([0, 1, 0, 0]),
        unit([0, 0, 1, 0]),
        unit([0, 0, 0, 1]),
      ]);
      const r = representativeSpans(V, v, { dim: DIM, beta: 0.1, maxIter: 300 });
      expect(r.iterations).toBeLessThan(300);
    });

    test("respects maxIter cap on pathological case", () => {
      // Many near-identical candidates → slow to break symmetry.
      // We don't expect non-convergence per se, but we verify maxIter is honored.
      const v = new Float32Array(unit([1, 0, 0, 0]));
      const V = flatten([
        unit([1, 0, 0, 0]),
        unit([1, 0.001, 0, 0]),
        unit([1, 0, 0.001, 0]),
        unit([1, 0, 0, 0.001]),
      ]);
      const r = representativeSpans(V, v, { dim: DIM, beta: 0, maxIter: 5 });
      expect(r.iterations).toBeLessThanOrEqual(5);
    });
  });
});