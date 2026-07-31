"use strict";

const { dotProductUnsafe } = require("./dotProduct");
const { logRatioGapThreshold } = require("./logRatioGapThreshold");
const { entropyThreshold } = require("./entropyThreshold");

/**
 * Default anti-similarity kernel: hinged complement of cosine.
 * Returns max(0, 1 - c).
 *
 * @param {number} c  Cosine similarity in [-1, 1].
 * @returns {number}  Anti-similarity score, ≥ 0.
 */
const antiSimilarityHinge = (c) => {
  const a = 1 - c;
  return a > 0 ? a : 0;
};

/**
 * @function representativeSpans
 * @description
 * Solves the regularized quadratic-plus-linear program on the simplex:
 *
 *   max  α^T A α + α^T vRel − α^T Diag(β) α
 *   s.t. α ∈ Δ  (probability simplex)
 *
 * where:
 *   A[i,j]   = edge(cos(V[i], V[j]))     for i ≠ j   (pairwise cohesion)
 *   A[i,i]   = 0
 *   vRel[i]  = ⟨V[i], v⟩                              (linear relevance to segment)
 *   β[i]     = per-candidate diagonal regularization (length n, ≥ 0)
 *
 * The dominant set extracted at convergence is a group of candidate
 * spans that are individually segment-relevant AND mutually independent
 * under the supplied `edge` kernel.
 *
 * **Regularization (Diag(β)):** higher β[i] suppresses candidate i from
 * concentrating α-mass. Uniform β behaves as the Pavan-Pelillo scalar α:
 *   - large β → fewer surviving spans (top concepts only)
 *   - small β → more surviving spans (finer concept inventory)
 * Per-candidate β allows externally biasing which candidates resist
 * winning α-mass (e.g., length-aware penalties).
 *
 * **Solver:** replicator dynamics with the Pavan-Pelillo shift
 * (κ = max(β); M = A − Diag(β) + κ·ee^T becomes nonnegative; argmax preserved).
 *
 * **Filtering:** candidates with vRel[i] ≤ keepingThreshold are dropped
 * upfront — they point away from the segment and cannot represent it.
 *
 * **Support extraction:** candidates with α > supportThreshold are kept.
 * If `options.adaptive` is set, the threshold is computed dynamically
 * from the α distribution and used as a *lower bound* on the static
 * `supportThreshold` (i.e. effective threshold = max(static, adaptive)).
 *
 * **Storage:** all matrices and vector buffers are contiguous Float32Arrays
 * for cache locality and SIMD-friendly access. M is stored row-major as
 * a single n*n buffer; Vf as a single n*dim buffer.
 *
 * @param {Float32Array}  V               Flat candidate buffer, length nRaw*dim.
 * @param {Float32Array}  [v]             Segment embedding (dim) when
 *                                        `computeRelevance` is true; precomputed
 *                                        relevance vector (length nRaw) when false.
 *                                        Pass a number to use a zero segment of
 *                                        that dim (debug only).
 * @param {object}        [options]
 * @param {number|Float32Array|Array<number>} [options.beta=0]
 *   Diagonal regularization. Either a scalar (uniform) or a per-candidate
 *   vector of length N indexed by original candidate position. Larger β →
 *   fewer surviving spans. Values must be ≥ 0.
 * @param {boolean}       [options.computeRelevance=true]
 *   When true, treat `v` as the segment embedding and compute relevance.
 *   When false, treat `v` as the precomputed relevance vector (length nRaw).
 * @param {number}        [options.maxIter=300]            Max replicator iterations.
 * @param {number}        [options.tol=1e-5]               L∞ convergence tolerance on α.
 * @param {number}        [options.dim]                    Embedding dimension.
 * @param {number}        [options.n]                      Number of candidate vectors in V.
 * @param {Function}      [options.edge=antiSimilarityHinge]  Kernel mapping cosine c → ≥ 0.
 * @param {number}        [options.keepingThreshold=0]     vRel filter threshold.
 * @param {number}        [options.supportThreshold=1e-4]
 *   Static α threshold for support. Acts as a *floor* — candidates with
 *   α below this are always pruned, regardless of `adaptive`.
 * @param {"log-ratio"|"entropy"|null} [options.adaptive=null]
 *   Adaptive threshold mode. When set, compute a data-driven threshold
 *   from the α distribution; effective threshold is max(static, adaptive).
 *   - "log-ratio": cut at the largest gap in log(α_i/α_{i+1}) (≥ log(3)).
 *   - "entropy":   keep ⌈exp(H)⌉ candidates, where H is Shannon entropy.
 * @param {number}        [options.minLogGap=Math.log(3)]
 *   Minimum log-ratio gap to trust as an elbow when adaptive="log-ratio".
 *
 * @returns {{alpha: Float32Array, support: number[], iterations: number, kept: number[], getIndices: function(): number[]}}
 *   alpha       — α on the simplex (length = number of kept candidates).
 *   support     — original V offsets where α > effective threshold.
 *   iterations  — replicator iterations actually run.
 *   kept        — original V offsets that survived vRel[i] > 0 filter (parallel to alpha).
 *   getIndices  — returns `support` mapped to candidate indices (offset / dim).
 */
const representativeSpans = (V, v, options) => {

  options || (options = {});

  // Allow `v` to be a number for "no segment vector" (zeros of that dim).
  typeof v === "number" && (v = new Float32Array(v));

  const beta              = options.beta              || 0;
  const maxIter           = options.maxIter           || 300;
  const tol               = options.tol               || 1e-5;
  const edge              = options.edge              || antiSimilarityHinge;
  let supportThreshold    = options.supportThreshold  || 1e-4;
  const computeRelevance  = options.computeRelevance ?? true;
  const keepingThreshold  = options.keepingThreshold ?? 0;
  const adaptive          = options.adaptive          || null;
  const minLogGap         = options.minLogGap         ?? Math.log(3);

  // Resolve dim and n from any of: options, v, V length.
  const dim = options.dim || (v && v.length) || (options.n && V.length / options.n);
  v || (v = new Float32Array(dim));
  const N = options.n || V.length / dim;
  supportThreshold = Math.max(supportThreshold, 0.5/N);
  //console.log("adaptive mode:", options.adaptive, "supportThreshold:", supportThreshold);

  const bufLen = N * dim;

  // ───────────────────────────────────────────────────────────────────────
  // 1. Per-candidate relevance vRel[i] = ⟨V[i], v⟩.
  //    Filter out vRel ≤ keepingThreshold (anti-aligned candidates).
  //    `kept` holds offsets into V for surviving candidates; `_beta` is
  //    compacted in lockstep so it stays aligned to the filtered set.
  // ───────────────────────────────────────────────────────────────────────
  const kept = [];
  const vTmp = [];
  const rel = new Float32Array(computeRelevance && N || v);
  let _beta = [];
  if (computeRelevance) {
    for (let i = 0, off = 0; off !== bufLen; ++i, off += dim) {
      rel[i] = 2 * dotProductUnsafe(V, v, dim, off, 0);
    }
  }
  for (let i = 0, off = 0, r; off !== bufLen; ++i, off += dim) {
    (r = rel[i]) > keepingThreshold && (
      _beta.push(typeof beta === "number" ? beta : beta[i]),
      kept.push(off),
      vTmp.push(r)
    );
  }

  const n = kept.length;
  if (!n) return { alpha: new Float32Array(0), support: [], iterations: 0, kept };

  const vRel = Float32Array.from(vTmp);

  // Compact filtered candidates into Vf.
  const Vf = new Float32Array(n * dim);
  _beta = new Float32Array(_beta);
  for (let i = 0, srcOff, dstOff = 0; i !== n; ++i, dstOff += dim) {
    srcOff = kept[i];
    for (let d = 0; d !== dim; ++d) Vf[dstOff + d] = V[srcOff + d];
  }

  // ───────────────────────────────────────────────────────────────────────
  // 2. Build M (row-major, contiguous) of size n*n following Pavan-Pelillo.
  //    Objective: α^T A α + α^T vRel − α^T Diag(β) α
  //    With shift κ = max(β):
  //      M[i,i] = κ − β[i]                    (≥ 0)
  //      M[i,j] = edge(cos(Vf[i], Vf[j])) + κ (≥ 0, since edge ≥ 0)
  //    The κ shift is a constant on Δ → argmax preserved.
  // ───────────────────────────────────────────────────────────────────────
  let kappa = _beta[0];
  for (let i = 1; i !== n; ++i) kappa = Math.max(kappa, _beta[i]);

  const M = new Float32Array(n * n);
  const _kept = kept.map(i => i / dim);
  for (let i = 0, iOff = 0, rOff = 0; i !== n; ++i, iOff += dim, rOff += n) {
    M[rOff + i] = kappa - _beta[i]; // diagonal
    // M is symetric.
    for (let j = i + 1, jOff = iOff + dim; j !== n; ++j, jOff += dim) {
      const c = dotProductUnsafe(Vf, Vf, dim, iOff, jOff);
      M[rOff + j] = edge(c, _kept[i], _kept[j], kappa) + kappa;     // off-diagonal
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // 3. Replicator dynamics.
  //      α_i ← α_i · ((Mα)_i + vRel_i) / (α^T M α + α^T vRel)
  // ───────────────────────────────────────────────────────────────────────
  const alpha  = new Float32Array(n);
  const Malpha = new Float32Array(n);

  const init = 1 / n;
  for (let i = 0; i !== n; ++i) alpha[i] = init;

  let iter = 0;
  for (; iter !== maxIter; ++iter) {
    Malpha.fill(0);
    for (let i = 0, rOff = 0, s, alpha_i; i !== n; ++i, rOff += n) {
      alpha_i = alpha[i];
      Malpha[i] += M[rOff + i] * alpha_i; // diag
      for (let j = i + 1, m; j !== n; ++j) {
        m = M[rOff + j];
        Malpha[i] += m * alpha[j]; // contributes to row i
        Malpha[j] += m * alpha_i;       // contributes to row j (uses M[i,j] = M[j,i])
      }
    }

    let denom = 0;
    for (let i = 0; i !== n; ++i) denom += alpha[i] * (Malpha[i] + vRel[i]);
    if (!(denom > 0)) break;

    let maxDelta = 0;
    for (let i = 0; i !== n; ++i) {
      const aNew = alpha[i] * (Malpha[i] + vRel[i]) / denom;
      const d    = Math.abs(aNew - alpha[i]);
      if (d > maxDelta) maxDelta = d;
      alpha[i] = aNew;
    }

    if (maxDelta < tol) { ++iter; break; }
  }

  // ───────────────────────────────────────────────────────────────────────
  // 4. Resolve effective threshold (static floor ∨ adaptive).
  //    Effective threshold is the maximum of:
  //      - the user-supplied static `supportThreshold` (always a floor)
  //      - the adaptive threshold, if `adaptive` is set
  //    so candidates surviving must have α > both.
  // ───────────────────────────────────────────────────────────────────────
  let effectiveThreshold = supportThreshold;
  if (adaptive === "log-ratio") {
    const adaptT = logRatioGapThreshold(alpha, minLogGap);
    if (adaptT > effectiveThreshold) effectiveThreshold = adaptT;
  } else if (adaptive === "entropy") {
    const adaptT = entropyThreshold(alpha);
    if (adaptT > effectiveThreshold) effectiveThreshold = adaptT;
  }

  // ───────────────────────────────────────────────────────────────────────
  // 5. Extract support (mapped back to original V offsets).
  // ───────────────────────────────────────────────────────────────────────
  const support = [];
  for (let i = 0; i !== n; ++i) {
    if (alpha[i] > effectiveThreshold) support.push(kept[i]);
  }

  return Object.defineProperty({ alpha, support, iterations: iter, kept }, "getIndices", {
    value: function() { return this.support.map(offsets => offsets / dim); }
  });
};

representativeSpans.edge = antiSimilarityHinge;
representativeSpans.logRatioGapThreshold = logRatioGapThreshold;
representativeSpans.entropyThreshold = entropyThreshold;

module.exports = Object.freeze(Object.defineProperty(representativeSpans, "representativeSpans", {
  value: representativeSpans,
}));