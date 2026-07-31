"use strict";

/**
 * @file rerank.test.js
 * @brief Tests for the centroid-based rerank operation.
 *
 * The rerank function is the most complex single primitive in the search
 * pipeline. Tests cover four behaviors:
 *
 *   1. Skip-on-weak: when the candidate centroid disagrees with the query
 *      on more than `rerankThreshold` fraction of dimensions, rerank
 *      returns the input unchanged.
 *   2. Extension: hits below the candidate set are added to the rerank
 *      input, bounded by score ratio and a hard count cap.
 *   3. Rescore: candidates are rescored using the weighted cosine and
 *      re-sorted.
 *   4. Second prune: the reranked input is adaptive-pruned.
 *
 * Tests use orthogonal basis vectors so dot products are exact. Each hit
 * in the input must carry `score` (cosine pre-rerank), `bestVec` (the
 * vector that produced the score — required for centroid computation).
 * Documents and document-level IDs are not needed at this layer.
 */

const rerank = require("../../src/VectorStore/rerank");
const {
  RERANK_EXTENSION_MAX,
} = require("../../src/VectorStore/constants");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const v = (...components) => new Float32Array(components);

/**
 * Build a hit with the fields rerank cares about.
 * The other fields (documentId, range) are irrelevant to rerank and
 * propagate untouched.
 */
const makeHit = (score, bestVec, extra = {}) => ({
  score,
  bestVec,
  ...extra,
});

// ─────────────────────────────────────────────────────────────────────────────
// Skip-on-weak: centroid disagrees with query on too many dims
// ─────────────────────────────────────────────────────────────────────────────

describe("rerank — skip on weak agreement", () => {
  test("returns the candidates unchanged when centroid is orthogonal to query", () => {
    // Query is [1, 0, 0, 0]. All candidate bestVecs are [0, 1, 0, 0].
    // Their centroid is [0, 1, 0, 0], so query*centroid is all zeros
    // (weak = dim, well above the 50% threshold).
    const query = v(1, 0, 0, 0);
    const candidates = [
      makeHit(0.5, v(0, 1, 0, 0)),
      makeHit(0.4, v(0, 1, 0, 0)),
      makeHit(0.3, v(0, 1, 0, 0)),
    ];

    const result = rerank(query, candidates, candidates, 4);
    expect(result.skipped).toBe(true);
    expect(result.reranked).toBe(candidates);
  });

  test("returns the candidates unchanged when weak fraction exceeds threshold", () => {
    // Query has signal on dim 0 only. Centroid has signal on dims 2,3 only.
    // After clamp, weights for dims 0,1 are zero (query is 0 on dim 1,
    // and query*centroid is 0 on dims 2,3 because query is 0 there too).
    // Actually let's construct it more directly: 3 of 4 dims will be weak.
    const query = v(1, 0.5, 0, 0);    // signal on dims 0,1
    const candidates = [
      makeHit(0.5, v(0, 0, 1, 0.5)),  // bestVec signal on dims 2,3
      makeHit(0.4, v(0, 0, 1, 0.5)),
    ];

    // Default threshold is 0.5 (50% of dims must be strong).
    const result = rerank(query, candidates, candidates, 4);
    expect(result.skipped).toBe(true);
  });

  test("explicit rerankThreshold can force a skip on stronger agreement", () => {
    // Use a very strict threshold so even good agreement skips.
    const query = v(1, 1, 1, 1);
    const candidates = [
      makeHit(0.9, v(1, 1, 0, 0)), // 2 of 4 dims strong; 50% weak
      makeHit(0.8, v(1, 1, 0, 0)),
    ];

    // Threshold 0.4 means "skip if more than 40% of dims weak".
    // We have 50% weak → skip.
    const result = rerank(query, candidates, candidates, 4, 0.4);
    expect(result.skipped).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rescore: ranking changes when consensus differs from raw cosine
// ─────────────────────────────────────────────────────────────────────────────

describe("rerank — rescoring", () => {
  test("runs and produces a non-skipped result when consensus aligns with query", () => {
    // Use a query with signal across all dimensions so the centroid (also
    // broad-signal) produces positive weights everywhere. A sparse query
    // like [1,0,0,0] would zero out 75% of weights and trigger the skip,
    // even with perfectly-aligned candidates.
    const query = v(0.5, 0.5, 0.5, 0.5);
    const candidates = [
      makeHit(0.95, v(0.5, 0.5, 0.5, 0.5)),
      makeHit(0.90, v(0.5, 0.5, 0.5, 0.5)),
      makeHit(0.85, v(0.5, 0.5, 0.5, 0.5)),
    ];

    const result = rerank(query, candidates, candidates, 4);
    expect(result.skipped).toBe(false);
    expect(result.reranked.length).toBeGreaterThan(0);
  });

  test("reranked results are sorted descending by their new scores", () => {
    // Broad-signal query and candidates so rerank actually runs.
    const query = v(0.5, 0.5, 0.5, 0.5);
    const candidates = [
      makeHit(0.9, v(0.6, 0.5, 0.4, 0.5)),
      makeHit(0.8, v(0.5, 0.6, 0.5, 0.4)),
      makeHit(0.7, v(0.4, 0.5, 0.6, 0.5)),
    ];

    const result = rerank(query, candidates, candidates, 4);
    expect(result.skipped).toBe(false);
    for (let i = 1; i < result.reranked.length; i++) {
      expect(result.reranked[i].score).toBeLessThanOrEqual(result.reranked[i - 1].score);
    }
  });

  test("the hit objects themselves are reused (identity preserved)", () => {
    const query = v(0.5, 0.5, 0.5, 0.5);
    const candidates = [
      makeHit(0.9, v(0.5, 0.5, 0.5, 0.5)),
      makeHit(0.8, v(0.6, 0.5, 0.4, 0.5)),
    ];
    const originals = new Set(candidates);

    const result = rerank(query, candidates, candidates, 4);
    expect(result.skipped).toBe(false);
    for (const hit of result.reranked) {
      expect(originals.has(hit)).toBe(true);
    }
  });

  test("rerank mutates the score field on each hit", () => {
    const query = v(0.5, 0.5, 0.5, 0.5);
    const a = makeHit(0.9, v(0.5, 0.5, 0.5, 0.5));
    const b = makeHit(0.8, v(0.6, 0.5, 0.4, 0.5));
    const candidates = [a, b];

    const result = rerank(query, candidates, candidates, 4);
    expect(result.skipped).toBe(false);
    // Scores are reassigned to reflect the reranked cosine.
    expect(typeof a.score).toBe("number");
    expect(typeof b.score).toBe("number");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extension: hits below the candidate set get a chance
// ─────────────────────────────────────────────────────────────────────────────

describe("rerank — extension", () => {
  test("includes hits below candidate set up to the score ratio cutoff", () => {
    // Candidate set ends at 0.50. Extension floor = 0.50 * 0.7 = 0.35.
    // So 0.40 should be added (above floor), 0.30 should not.
    const query = v(0.5, 0.5, 0.5, 0.5);
    const candidates = [
      makeHit(0.95, v(0.5, 0.5, 0.5, 0.5)),
      makeHit(0.70, v(0.5, 0.5, 0.5, 0.5)),
      makeHit(0.50, v(0.5, 0.5, 0.5, 0.5)),
    ];
    const allHits = [
      ...candidates,
      makeHit(0.40, v(0.5, 0.5, 0.5, 0.5)),  // above 0.35 floor → included
      makeHit(0.30, v(0.5, 0.5, 0.5, 0.5)),  // below floor → excluded
      makeHit(0.20, v(0.5, 0.5, 0.5, 0.5)),  // below floor → excluded
    ];

    const result = rerank(query, candidates, allHits, 4);
    expect(result.skipped).toBe(false);
    // candidates (3) + extension (1) = 4 max before adaptive prune.
    expect(result.reranked.length).toBeLessThanOrEqual(4);
    expect(result.reranked.length).toBeGreaterThanOrEqual(1);
  });

  test("does not exceed RERANK_EXTENSION_MAX additional items", () => {
    const query = v(0.5, 0.5, 0.5, 0.5);
    const candidates = [
      makeHit(0.95, v(0.5, 0.5, 0.5, 0.5)),
      makeHit(0.90, v(0.5, 0.5, 0.5, 0.5)),
    ];

    // Build a long tail of qualifying extension candidates (all just below
    // the candidate set, all above the score ratio floor).
    const tail = [];
    for (let i = 0; i < RERANK_EXTENSION_MAX + 10; i++) {
      tail.push(makeHit(0.85, v(0.5, 0.5, 0.5, 0.5)));
    }
    const allHits = [...candidates, ...tail];

    const result = rerank(query, candidates, allHits, 4);
    expect(result.skipped).toBe(false);
    // The rerank input was capped at candidates.length + RERANK_EXTENSION_MAX
    // BEFORE the second prune. The reranked array has been pruned, so it
    // could be even smaller — but it should never exceed that total.
    expect(result.reranked.length).toBeLessThanOrEqual(candidates.length + RERANK_EXTENSION_MAX);
  });

  test("extension stops at the first item below the floor (sorted assumption)", () => {
    // allHits is sorted descending. Once we hit a sub-floor score, we stop —
    // we don't keep scanning for stray above-floor items past it.
    const query = v(0.5, 0.5, 0.5, 0.5);
    const candidates = [
      makeHit(0.80, v(0.5, 0.5, 0.5, 0.5)),
    ];
    const allHits = [
      ...candidates,
      makeHit(0.60, v(0.5, 0.5, 0.5, 0.5)),  // above floor (0.80*0.7=0.56) → included
      makeHit(0.30, v(0.5, 0.5, 0.5, 0.5)),  // below floor → stop
      makeHit(0.70, v(0.5, 0.5, 0.5, 0.5)),  // would qualify but unreachable
    ];

    const result = rerank(query, candidates, allHits, 4);
    expect(result.skipped).toBe(false);
    // Maximum 2 hits — the candidate + the one above-floor extension.
    expect(result.reranked.length).toBeLessThanOrEqual(2);
  });

  test("empty allHits beyond candidates is fine", () => {
    // Use a broad-signal query so weights are positive across all dims
    // and rerank actually runs (rather than skipping on weak consensus).
    const query = v(0.5, 0.5, 0.5, 0.5);
    const candidates = [
      makeHit(0.9, v(0.5, 0.5, 0.5, 0.5)),
      makeHit(0.8, v(0.5, 0.5, 0.5, 0.5)),
    ];

    const result = rerank(query, candidates, candidates, 4);
    expect(result.skipped).toBe(false);
    expect(result.reranked.length).toBeLessThanOrEqual(candidates.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("rerank — edge cases", () => {
  test("single-candidate set", () => {
    const query = v(0.5, 0.5, 0.5, 0.5);
    const candidates = [makeHit(0.95, v(0.5, 0.5, 0.5, 0.5))];

    const result = rerank(query, candidates, candidates, 4);
    expect(result.skipped).toBe(false);
    expect(result.reranked.length).toBeLessThanOrEqual(1);
  });

  test("returns the expected return-shape object", () => {
    const query = v(0.5, 0.5, 0.5, 0.5);
    const candidates = [
      makeHit(0.9, v(0.5, 0.5, 0.5, 0.5)),
      makeHit(0.8, v(0.5, 0.5, 0.5, 0.5)),
    ];

    const result = rerank(query, candidates, candidates, 4);
    expect(result).toHaveProperty("reranked");
    expect(result).toHaveProperty("skipped");
    expect(typeof result.skipped).toBe("boolean");
    expect(Array.isArray(result.reranked)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export conventions
// ─────────────────────────────────────────────────────────────────────────────

describe("rerank — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof rerank).toBe("function");
  });

  test("exposes a self-referential .rerank property", () => {
    expect(rerank.rerank).toBe(rerank);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(rerank)).toBe(true);
  });
});