"use strict";

const { dotProductUnsafe } = require("./dotProduct");
const { normalizeUnsafe } = require("./normalize");

/**
 * @function incrementalPCA
 * @description
 * Computes the dominant principal direction (PC1) of a set of vectors via
 * Oja's normalised update rule, with online mean tracking and early-stop
 * based on directional stability.
 *
 * Adds vectors one at a time. After each step, measures the angular change
 * Δ(k) = 1 − |cos(v_k, v_{k-1})| between the current and previous PC1
 * estimate. When two consecutive Δ values fall below `stoppingThreshold`,
 * the computation halts and returns the current estimate along with the
 * optimal k.
 *
 * Input vectors should already be weighted and filtered (e.g. via
 * {@link buildVectorSet}). To anchor PC1 toward a query direction, pass
 * the query to `buildVectorSet` so it is prepended to the vector set.
 *
 * **Centering:** when `centering` is true (default), each sample is
 * centred against the running mean of previously seen samples before the
 * Oja update. PC1 then estimates the dominant eigenvector of the
 * covariance Σ — the direction of maximum *variance*. When false, the raw
 * sample is used directly. PC1 then estimates the dominant eigenvector of
 * the second moment E[xxᵀ] = Σ + μμᵀ — for tight clusters this is
 * approximately the centroid direction. The running mean is tracked in
 * both cases (for use in downstream reconstruction).
 *
 * **References:**
 * - Balsubramani, Dasgupta & Freund. "The Fast Convergence of Incremental
 *   PCA." NeurIPS, 2013. — convergence E[Ψ_n] = O(1/n) [Theorem 1.1].
 * - Lippi & Ceccarelli. "Incremental PCA: Exact implementation and
 *   continuity corrections." arXiv:1901.07922, 2019. — sign-flip handling
 *   via |cos| (continuity issue, §2.2).
 * - Saad-Falcon, Ancelin & Romberg. "Global Convergence of Adaptive
 *   Sensing for Principal Eigenvector Estimation." arXiv:2505.10882, 2025.
 *
 * **Update rule:**
 *   `v ← normalize( v + (1/k) · cur · (cur · v) )`
 *   where `cur = x − μ_prior` if `centering`, otherwise `cur = x`.
 *
 * @param {Float32Array[]} V                              Array of input vectors,
 *                                                        each of length `dim`.
 *                                                        Already weighted/filtered.
 * @param {number}         dim                            Dimension of each vector.
 * @param {object}         [options]                      Optional configuration.
 * @param {number}         [options.stoppingThreshold=0.01]  Δ(k) threshold for early stop.
 * @param {boolean}        [options.centering=true]       Whether to centre samples
 *                                                        against the running mean
 *                                                        before the Oja update.
 *
 * @returns {{v: Float32Array, k: number, mean: Float32Array, history: number[]} | null}
 *   `v`       — PC1 unit vector.
 *   `k`       — number of vectors consumed (= optimal k).
 *   `mean`    — running mean of consumed samples.
 *   `history` — array of Δ(k) values, length `k`.
 *   Returns `null` if `V` is empty.
 *
 * @example
 * // Standard centered PCA.
 * const V = buildVectorSet(flatVecs, 384, null, weights);
 * const result = incrementalPCA(V, 384);
 *
 * @example
 * // Uncentered (second-moment) PCA — favours centroid direction.
 * const result = incrementalPCA(V, 384, { centering: false });
 *
 * @example
 * // Tighter convergence + uncentered.
 * const result = incrementalPCA(V, 384, {
 *   stoppingThreshold: 0.001,
 *   centering: false,
 * });
 */
const incrementalPCA = (V, dim, options) => {
  const n = V.length;

  options || (options = {});
  let { stoppingThreshold, centering } = options;
  stoppingThreshold === undefined && (stoppingThreshold = 0.01);
  centering        === undefined && (centering        = true);

  if (!n) return null;

  const mean  = new Float32Array(dim);
  const v     = new Float32Array(dim);
  const vPrev = new Float32Array(dim);
  const xc    = new Float32Array(dim);

  const history = [];
  let optimalK = n, prevDelta = 1, x = V[0];

  // Init mean to first sample (only when centering — else stays 0).
  if (centering) for (let j = 0; j !== dim; ++j) mean[j] = x[j];

  // Init v to normalised first sample (bootstraps Oja's multiplicative update).
  normalizeUnsafe(x, dim, 0, v);

  // The iterative loop.
  for (let i = 1; i !== n; ++i) {
    x = V[i];
    const k = i + 1, invK = 1 / k;

    // Working vector: centered (against prior mean) or raw.
    let cur;
    if (centering) {
      for (let j = 0; j !== dim; ++j) xc[j] = x[j] - mean[j];
      for (let j = 0; j !== dim; ++j) mean[j] += (x[j] - mean[j]) * invK;
      cur = xc;
    } else {
      cur = x;
    }

    // Save v_{k-1}.
    vPrev.set(v);

    // Oja step: v += (1/k) · cur · (cur · v).
    const step = dotProductUnsafe(cur, v, dim, 0, 0) * invK;
    for (let j = 0; j !== dim; ++j) v[j] += step * cur[j];

    // Normalise.
    normalizeUnsafe(v, dim, 0, v);

    // Δ(k) = 1 − |cos(v_k, v_{k-1})|.  |·| handles sign flips (Lippi §2.2).
    const delta = 1 - Math.abs(dotProductUnsafe(v, vPrev, dim, 0, 0));
    history.push(delta);

    // Early stop: two consecutive Δ below threshold.
    if (delta < stoppingThreshold && prevDelta < stoppingThreshold) {
      optimalK = k;
      break;
    }
    prevDelta = delta;
  }

  return { v, k: optimalK, mean, history };
}

/**
 * @function buildVectorSet
 * @description
 * Materialises a flat input buffer of concatenated vectors into an array of
 * weighted `Float32Array` rows, ready for consumption by an iterative PCA
 * routine. Each row is **pre-scaled by `√w`** so that downstream quadratic
 * updates of the form `v += γ · x · (x · v)` give standard weighted-PCA
 * semantics: `x' xᵀ = w · x xᵀ`.
 *
 * **Filtering:** rows with non-positive weight (`w ≤ 0`, including `NaN`)
 * are dropped. In a query-conditioned PCA setting, anti-aligned documents
 * (negative cosine similarity to the query) carry no useful signal — they
 * would pull PC1 away from the query direction without contributing
 * semantic content, since the outer product `x xᵀ` is invariant under
 * `x → −x` (PCA is sign-blind).
 *
 * **Optional query anchoring:** if `query` is provided, it is prepended to
 * the output as the first row with effective weight 1 (no scaling). This
 * anchors PC1 toward the query direction before documents refine it —
 * useful for query-conditioned PCA in retrieval.
 *
 * **Defaults:**
 * - If `offsets` is falsy, generates contiguous offsets `[0, dim, 2·dim, …]`
 *   based on `vecs.length / dim`.
 * - If `weights` is falsy, uses uniform weight `1` for every vector.
 * - Individual `undefined` entries in `weights` also default to `1`.
 *
 * The returned array is densely packed: filtered rows leave no gaps, and
 * `V.length` equals the count of retained vectors (plus 1 if `query` is set).
 *
 * @param {number[]|Float32Array}      vecs       Flat array of concatenated input vectors.
 * @param {number}                     dim        Dimension of each vector.
 * @param {number[]|null}              [offsets]  Per-vector start offsets into `vecs`.
 *                                                Defaults to `[0, dim, 2·dim, …]`.
 * @param {number[]|null}              [weights]  Per-vector weights. Non-positive
 *                                                values (incl. `NaN`) are dropped.
 *                                                Defaults to all `1`.
 * @param {number[]|Float32Array|null} [query]    Optional query vector of length `dim`.
 *                                                If provided, prepended to output as
 *                                                the first row with weight 1.
 *
 * @returns {Float32Array[]} Array of weighted vectors, each of length `dim`.
 *                           Length equals the number of retained vectors
 *                           (≤ original count after filtering, +1 if query supplied).
 *
 * @example
 * // Three 2-D vectors, uniform weights.
 * buildVectorSet([1, 2, 3, 4, 5, 6], 2);
 * // => [Float32Array[1, 2], Float32Array[3, 4], Float32Array[5, 6]]
 *
 * @example
 * // Custom weights — middle vector dropped (w ≤ 0).
 * buildVectorSet([1, 2, 3, 4, 5, 6], 2, null, [0.8, -0.1, 0.5]);
 * // => [Float32Array[√0.8 · 1, √0.8 · 2],
 * //     Float32Array[√0.5 · 5, √0.5 · 6]]
 *
 * @example
 * // Custom offsets — pick vectors at positions 0 and 4.
 * buildVectorSet([1, 2, 9, 9, 5, 6], 2, [0, 4], [1, 1]);
 * // => [Float32Array[1, 2], Float32Array[5, 6]]
 *
 * @example
 * // Query-anchored set — query prepended at index 0.
 * buildVectorSet([1, 2, 3, 4], 2, null, [0.5, 0.8], [9, 9]);
 * // => [Float32Array[9, 9],                      // query, weight 1
 * //     Float32Array[√0.5 · 1, √0.5 · 2],
 * //     Float32Array[√0.8 · 3, √0.8 · 4]]
 */
const buildVectorSet = (vecs, dim, offsets, weights, query) => {
  let n = vecs.length / dim;

  // Init offsets if needed.
  if (!offsets) {
    offsets = new Array(n);
    for (let i = 0, j = 0; i !== n; ++i, j += dim) offsets[i] = j;
  }

  // Init weights if needed.
  if (!weights) {
    weights = new Array(n);
    for (let i = 0; i !== n; ++i) weights[i] = 1;
  }

  // Build vector set. Pre-multiply by √w so weighted Oja matches standard
  // weighted PCA: x' = √w · x ⇒ x' x'ᵀ = w · x xᵀ.
  // Non-positive weights (incl. NaN) are dropped — anti-aligned docs would
  // pull PC1 away from the query direction.
  // Optional query is prepended at index 0 with weight 1 (no scaling).
  n = offsets.length;
  const hasQuery = !!query;
  const V = new Array(n + hasQuery);
  let m = 0;

  // Prepend query if provided — weight 1, copied verbatim.
  if (hasQuery) {
    const q = V[m++] = new Float32Array(dim);
    for (let j = 0; j !== dim; ++j) q[j] = query[j];
  }

  for (let i = 0; i !== n; ++i) {
    let w = weights[i];
    w === undefined && (w = 1);
    if (!(w > 0)) continue;
    w = Math.sqrt(w);
    const v = V[m++] = new Float32Array(dim), o = offsets[i] || 0;
    for (let j = 0; j !== dim; ++j) {
      v[j] = w * vecs[o + j];
    }
  }
  V.length = m;

  return V;
}

/**
 * @function reconstruct
 * @description
 * Reconstructs an input vector using a 1-D PCA approximation along the
 * dominant principal direction. The result is a rank-1 projection of `x`
 * back into the original `dim`-dimensional space:
 *
 *   `x_reconstructed = mean + ((x − mean) · v) · v`
 *
 * Filters out off-concept variation, leaving only the component aligned
 * with `v`. The output can then be compared to a query (or anything else)
 * using cosine similarity, dot product, or any other metric — externally
 * to this function.
 *
 * @param {number[]|Float32Array} x      Input vector of length `dim`.
 * @param {Float32Array}          mean   Running mean from `incrementalPCA`.
 * @param {Float32Array}          v      PC1 unit vector from `incrementalPCA`.
 * @param {number}                dim    Vector dimension.
 * @param {Float32Array}          [out]  Optional preallocated output buffer
 *                                       of length `dim`. If omitted, a new
 *                                       `Float32Array` is allocated.
 *
 * @returns {Float32Array} The reconstructed vector, length `dim`.
 *
 * @example
 * const xr = reconstruct(docVec, mean, v, 384);
 * const score = cosine(queryVec, xr, 384);
 */
const reconstruct = (x, mean, v, dim, out) => {
  out || (out = new Float32Array(dim));

  // α = (x − mean) · v
  let alpha = 0;
  for (let j = 0; j !== dim; ++j) alpha += (x[j] - (mean && mean[j] || 0)) * v[j];

  // out = mean + α · v
  for (let j = 0; j !== dim; ++j) out[j] = (mean && mean[j] || 0) + alpha * v[j];

  return out;
}

const normalize = (x, dim, offset, out) => {
  out || (out = new Float32Array(dim));
  offset > 0 || (offest = 0);
  let normSquared = dotProductUnsafe(x, x, dim, offset, offset);
  if (normSquared) {
    normSquared = 1 / Math.sqrt(normSquared);
    for (let j = 0; j !== dim; ++j) out[j] *= normSquared;
  }
  return out;
} 

/**
 * @ignore
 * Default export with freezing.
 */
incrementalPCA.buildVectorSet = buildVectorSet;
incrementalPCA.reconstruct = reconstruct;
module.exports = Object.freeze(Object.defineProperty(incrementalPCA, "incrementalPCA", {
  value: incrementalPCA
}));