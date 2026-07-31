"use strict";

const { dotProductUnsafe } = require("../utilities/math/dotProduct");
const adaptivePrune = require("./adaptivePrune");
const {
  RERANK_THRESHOLD,
  RERANK_EXTENSION_RATIO,
  RERANK_EXTENSION_MAX,
} = require("./constants");

/**
 * @file rerank.js
 * @module VectorStore/rerank
 * @description Centroid-based rerank with a score-anchored extension.
 *
 * The rerank operation reshapes a cosine-ranked hit list using a consensus
 * direction derived from the candidate set itself. Dimensions where the
 * query and the average-relevant-document agree are amplified; dimensions
 * where they disagree are suppressed. Hits that scored well for the "right
 * reasons" (alignment with the consensus) rise; hits that scored well by
 * accident (alignment with noisy query dimensions) fall.
 *
 * Pipeline:
 *   1. Centroid:    mean of the candidate set's best-matching vectors.
 *   2. Weights:     clamp(query × centroid, 0) elementwise.
 *   3. Skip check:  count weak (zeroed) dimensions. If too many, skip.
 *   4. Extension:   add hits below the candidate set, bounded by score
 *                   ratio and a hard count cap.
 *   5. Rescore:     for each candidate, compute (vec ⊙ w) · query / |vec ⊙ w|.
 *   6. Second prune: adaptive prune on the new score distribution.
 *
 * The rescore step factors out work that doesn't depend on the candidate
 * vector. Specifically, `query[i] · weights[i]` is precomputed once into
 * `qw` and reused for every candidate's dot product. Per candidate, only
 * the weighted magnitude must be recomputed individually.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the centroid of the candidate set's best-matching vectors.
 *
 * Each candidate carries a `bestVec` view pointing at the single vector
 * that produced its score (across breadcrumb, body, question, anchors,
 * variants). Using the per-candidate best vector keeps the centroid
 * focused on the phrasings that actually matched the query.
 *
 * Intentionally NOT normalized — magnitude carries information that the
 * weight builder consumes.
 *
 * @param {Array<{ bestVec: Float32Array }>} candidates
 * @param {number} dim
 * @returns {Float32Array} Unnormalized centroid of length `dim`.
 */
const candidateCentroid = (candidates, dim) => {
  const mean = new Float32Array(dim);
  const n = candidates.length;
  if (n === 0) return mean;
  for (let c = 0; c !== n; ++c) {
    const v = candidates[c].bestVec;
    for (let i = 0; i !== dim; ++i) mean[i] += v[i];
  }
  const invN = 1 / n;
  for (let i = 0; i !== dim; ++i) mean[i] *= invN;
  return mean;
};

/**
 * Build clamped elementwise weights and count weak (zeroed) dimensions.
 *
 * Negative products are zeroed: dimensions where query and centroid
 * disagree on sign shouldn't be anti-amplified, just ignored.
 *
 * @param {Float32Array} query
 * @param {Float32Array} centroid
 * @param {number} dim
 * @returns {{ weights: Float32Array, weak: number }}
 */
const buildRerankWeights = (query, centroid, dim) => {
  const weights = new Float32Array(dim);
  let weak = 0;
  for (let i = 0; i !== dim; ++i) {
    const w = query[i] * centroid[i];
    if (w > 0) {
      weights[i] = w;
    } else {
      weights[i] = 0;
      ++weak;
    }
  }
  return { weights, weak };
};

/**
 * Rescore one candidate vector against the query under the weight scheme.
 *
 * The rerank score for a candidate vector `vec` is:
 *
 * ```
 * score = (vec ⊙ w) · query / |vec ⊙ w|
 *       = Σ(vec[i] · w[i] · query[i]) / sqrt(Σ((vec[i] · w[i])²))
 * ```
 *
 * Factor the numerator: `Σ(vec[i] · qw[i])` where `qw = query ⊙ w`. Since
 * `qw` is independent of `vec`, the caller precomputes it once outside
 * the per-candidate loop, and this function computes the numerator with
 * the unrolled {@link dotProductUnsafe}.
 *
 * The denominator (the weighted vector's magnitude) IS candidate-specific
 * and must be recomputed per call.
 *
 * @param {Float32Array} vec     - Candidate vector.
 * @param {Float32Array} weights - Elementwise weights.
 * @param {Float32Array} qw      - Precomputed query × weights.
 * @param {number} dim
 * @returns {number} Reranked cosine similarity.
 */
const rescoreOne = (vec, weights, qw, dim) => {
  // Squared magnitude of the weighted vector. Cheaper than building the
  // full weighted vector first — we only need its norm, not its components.
  let magSq = 0;
  for (let i = 0; i !== dim; ++i) {
    const vw = vec[i] * weights[i];
    magSq += vw * vw;
  }
  if (magSq === 0) return 0;

  // Numerator via the unrolled dot product. invMag (a scalar) is pulled
  // out of the sum: Σ(vec[i] · qw[i] · invMag) = invMag · dot(vec, qw).
  return dotProductUnsafe(vec, qw, dim) / Math.sqrt(magSq);
};

// ─────────────────────────────────────────────────────────────────────────────
// Public function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply centroid-based rerank to a candidate set and return the resulting
 * pruned, re-sorted hit list.
 *
 * When rerank is skipped (weak-dim fraction exceeds `rerankThreshold`),
 * returns `{ reranked: candidates, skipped: true }` and the caller falls
 * back to the candidate set unchanged.
 *
 * @function rerank
 * @param {Float32Array} query
 * @param {Array<{ score: number, bestVec: Float32Array }>} candidates
 *   First-pass candidate set (post-adaptive-prune, descending by score).
 *   Used both to compute the centroid AND as the base for the rerank input.
 * @param {Array<{ score: number, bestVec: Float32Array }>} allHits
 *   Full sorted hit list. Used to source extension items below the
 *   candidate set.
 * @param {number} dim
 * @param {number} [rerankThreshold=RERANK_THRESHOLD]
 *
 * @returns {{ reranked: Array, skipped: boolean }}
 */
const rerank = (query, candidates, allHits, dim, rerankThreshold = RERANK_THRESHOLD) => {
  const centroid = candidateCentroid(candidates, dim);
  const { weights, weak } = buildRerankWeights(query, centroid, dim);

  // Skip rerank if too many dimensions are weak. Integer math avoids the
  // division-by-dim and any NaN risk if dim were ever 0.
  const weakBudget = (dim * rerankThreshold) | 0;
  if (weak >= weakBudget) {
    return { reranked: candidates, skipped: true };
  }

  // Build the rerank input: candidate set + extension. Extension is
  // bounded by both a score ratio (anchored to the last candidate's
  // score) and a hard count cap.
  //
  // Dedup against the candidate set. Two regimes are handled:
  //
  //   - Real pipeline (post-pivot): candidates can include items not
  //     present in `allHits` (drawn from a different sweep using the
  //     anchor's bestVec) that share `documentId|range` with allHits
  //     entries. Key-based dedup catches these.
  //
  //   - Pre-pivot / synthetic fixtures: candidates may be reference-
  //     equal to entries in allHits (the historical case — candidates
  //     was the top-N prefix of allHits). Identity-based dedup catches
  //     these without requiring documentId/range to be present.
  //
  // We check both: a hit is skipped if its (documentId, range) key OR
  // its object identity is already in the candidate set.
  const keyOf = h =>
    (typeof h.documentId === "string" && Array.isArray(h.range))
      ? `${h.documentId}|${h.range[0]}|${h.range[1]}`
      : null;

  const lastCandidateScore = candidates[candidates.length - 1].score;
  const extensionFloor     = lastCandidateScore * RERANK_EXTENSION_RATIO;

  const candidateKeys     = new Set();
  const candidateIdentity = new Set();
  for (let i = 0; i !== candidates.length; ++i) {
    candidateIdentity.add(candidates[i]);
    const k = keyOf(candidates[i]);
    if (k !== null) candidateKeys.add(k);
  }

  const rerankInput = candidates.slice();
  for (
    let i = 0, extAdded = 0;
    i < allHits.length && extAdded < RERANK_EXTENSION_MAX;
    ++i
  ) {
    if (allHits[i].score < extensionFloor) break;
    if (candidateIdentity.has(allHits[i])) continue;
    const k = keyOf(allHits[i]);
    if (k !== null && candidateKeys.has(k)) continue;
    rerankInput.push(allHits[i]);
    if (k !== null) candidateKeys.add(k);
    candidateIdentity.add(allHits[i]);
    ++extAdded;
  }

  // ── Precompute query × weights, used by every candidate's rescore ──────
  // The rerank score's numerator is Σ(vec[i] · query[i] · weights[i]).
  // Two of those three factors don't depend on the candidate, so we
  // fold them into `qw` once and reuse across the rescore loop.
  const qw = new Float32Array(dim);
  for (let i = 0; i !== dim; ++i) qw[i] = query[i] * weights[i];

  // Rescore everyone in the rerank input.
  for (let i = 0, l = rerankInput.length; i !== l; ++i) {
    rerankInput[i].score = rescoreOne(rerankInput[i].bestVec, weights, qw, dim);
  }

  rerankInput.sort((a, b) => b.score - a.score);

  // Second-pass adaptive prune on the new score distribution. Safety
  // rails (MIN/MAX) are the caller's responsibility — they need the
  // pre-prune snapshot only the caller maintains.
  adaptivePrune(rerankInput);

  return { reranked: rerankInput, skipped: false };
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(rerank, "rerank", {
  value: rerank,
}));