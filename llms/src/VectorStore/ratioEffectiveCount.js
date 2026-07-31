"use strict";

/**
 * @file ratioEffectiveCount.js
 * @module VectorStore/ratioEffectiveCount
 * @description Compute how many items at the head of a sorted hit list
 * carry meaningful signal, using consecutive score ratios as the measure.
 *
 * The function answers the same practical question as
 * {@link entropyEffectiveCount}: given a ranked score distribution,
 * how many top-K items should I keep? But it uses a different shape
 * heuristic better suited to cosine-similarity score distributions.
 *
 * Why ratios rather than entropy. Entropy works on normalized
 * probability mass. Real-world cosine scores typically sit in a
 * narrow range like [0.4, 0.9]; after normalizing by their sum, the
 * mass is spread broadly, and entropy underestimates how peaky the
 * raw scores look. The ratio approach reads the *shape* of the
 * descending curve directly: scan consecutive pairs `(prev, curr)`,
 * compute `prev / curr`, and locate the steepest descent. A
 * distribution like `[0.85, 0.82, 0.80, 0.30, 0.25]` has gap ratios
 * `[1.04, 1.03, 2.67, 1.20]` — the cliff between indices 2 and 3 is
 * obvious to a ratio measure even though entropy on normalized mass
 * would underweight it.
 *
 * Algorithm. Walk the sorted list once. At each step compute
 * `g = prev_score / curr_score`. Track the largest `g` seen so far.
 * When a new maximum `g` is found AND `g` clears the `minGap`
 * threshold, mark this as the current cut location. The final cut
 * is the index of the smaller item in the pair forming the
 * steepest qualifying ratio.
 *
 * The cliff convention. When the steepest qualifying ratio occurs
 * between `hits[i-1]` and `hits[i]`, the function returns `i`. That
 * means:
 *
 *   - `hits[0..i-1]` (the items at and above the cliff) are kept.
 *   - `hits[i..]`    (the items at and below the cliff) are dropped.
 *
 * The cliff sits at the boundary between kept and dropped: the
 * larger of the two items forming the cliff is the last kept; the
 * smaller is the first dropped. The cliff index itself (the smaller
 * item) is on the dropped side.
 *
 * Tie resolution. When two ratios in the distribution are equal,
 * the EARLIER occurrence wins (the loop uses strict `g > maxGap`,
 * not `>=`). This is conservative: it cuts higher up the
 * distribution rather than further down, dropping more material
 * when ambiguity exists.
 *
 * Highest cliff vs first cliff. This function locates the steepest
 * qualifying cliff, NOT the first one above the threshold. If the
 * top of the distribution has two cliffs both clearing `minGap`, the
 * one with the larger ratio wins — even if it's further down. This
 * favors retrieval precision: the steepest cliff in the distribution
 * is the strongest signal that "everything past this point is
 * noticeably different," regardless of where it sits.
 *
 * Noise floor and early termination. As soon as the loop encounters
 * a score at or below `eps`, iteration stops. Ratios involving a
 * near-zero denominator would be artificially huge and would
 * register as false elbows. The noise-floor stop point also acts as
 * a fallback: when no qualifying elbow is found earlier in the
 * scan, the function falls back to truncating at the noise floor.
 *
 * Sorted-descending precondition. Hits are sorted descending by
 * `.score` (the search pipeline guarantees this before calling
 * adaptive pruning). The function exploits this in two ways:
 *
 *   - Trailing scores at or below `eps` are not visited. The loop
 *     terminates as soon as one is seen, since everything after
 *     must be at most `eps` too.
 *   - No internal sort or copy is needed. The function reads `.score`
 *     directly from each hit and computes everything in a single
 *     pass.
 *
 * Violating the precondition (passing an unsorted array) produces a
 * result that is computationally valid but useless as a truncation
 * point — the cliff detection assumes monotonically non-increasing
 * input.
 *
 * Composition with entropyEffectiveCount. The {@link adaptivePrune}
 * caller runs entropy first, then passes its result as `maxCutIndex`
 * to this function. This bounds the ratio scan to entropy's window,
 * so the final cut is at most as large as entropy's — ratio can
 * tighten the cut further but never relax it. The combined measure
 * is computed in O(n) total instead of two independent O(n) passes
 * followed by a `min` post-hoc.
 *
 * Returns the input length for `n` of 0 or 1 — when there's no pair
 * to compare, "keep what we have" is the correct fallback. Returns
 * the input length for any distribution where no consecutive ratio
 * clears `minGap` (the noise floor may still cut).
 */

/**
 * Find the ratio-derived effective count of a sorted hit list.
 *
 * @function ratioEffectiveCount
 *
 * @param {Array<{ score: number }>} hits
 *   Hit list sorted descending by `.score`. The function reads
 *   `.score` directly off each element; it does not extract or copy
 *   the scores into a temporary buffer.
 *
 * @param {object} [options]
 *
 * @param {number} [options.minGap]
 *   Minimum ratio `prev_score / curr_score` for a pair to qualify
 *   as an elbow. Default `3` (equivalent to a `log` gap of
 *   `log(3) ≈ 1.099`). Lower values cut more aggressively; higher
 *   values require a sharper cliff before any cut is made. If both
 *   `minGap` and `minLogGap` are provided, `minGap` wins.
 *
 *   Note: this is the function's own conservative default. The
 *   `adaptivePrune` caller overrides it to `RATIO_MIN_GAP = 1.5`,
 *   tuned for cosine distributions where real cliffs typically have
 *   ratios in the 1.5-2.0 range.
 *
 * @param {number} [options.minLogGap]
 *   Equivalent of `minGap` in log space — `minGap = exp(minLogGap)`.
 *   Useful when callers think in log units. Ignored if `minGap` is
 *   provided.
 *
 * @param {number} [options.eps]
 *   Noise floor. Scores at or below this value terminate the scan
 *   (preventing artificial elbows from near-zero denominators).
 *   Defaults to `1e-10`. Negative values are clamped to `0`.
 *
 * @param {number} [options.maxCutIndex]
 *   Maximum index the scan may visit. The loop never reads past
 *   this position, and the final cut index is bounded by it. Used
 *   by `adaptivePrune` to tighten ratio's scan to entropy's result
 *   (so combined measure runs in O(n) total).
 *
 *   Defaults to `hits.length` (no extra cap). Clamped to
 *   `[1, hits.length]` on input.
 *
 * @returns {number}
 *   Integer in `[1, hits.length]` (for non-empty input) representing
 *   how many items at the head of the list survive the cut. Use as
 *   the target length for an in-place truncation:
 *
 *   ```
 *   hits.length = ratioEffectiveCount(hits);
 *   ```
 *
 *   Returns `hits.length` (no cut) when no qualifying elbow is
 *   found and no noise floor is hit. Returns `0` when the array is
 *   empty; returns the input length for any single-element array.
 *
 * @example <caption>Sharp cliff (one dominant cluster)</caption>
 *   ratioEffectiveCount([
 *     {score: 0.85}, {score: 0.82}, {score: 0.80},
 *     {score: 0.20}, {score: 0.15},
 *   ])
 *   // → 3 (cliff between 0.80 and 0.20: ratio = 4.0 ≥ minGap=3)
 *
 * @example <caption>No qualifying cliff (smooth descent)</caption>
 *   ratioEffectiveCount([
 *     {score: 0.85}, {score: 0.80}, {score: 0.75}, {score: 0.70},
 *   ])
 *   // → 4 (all ratios ≈ 1.06, below minGap)
 *
 * @example <caption>Multiple cliffs — steepest wins</caption>
 *   ratioEffectiveCount([
 *     {score: 0.90}, {score: 0.25}, {score: 0.20}, {score: 0.02},
 *   ])
 *   // → 3 (ratios: 3.6, 1.25, 10.0; the 10.0 cliff is steepest)
 *
 * @example <caption>Noise-floor fallback (no elbow but tail trails to zero)</caption>
 *   ratioEffectiveCount([
 *     {score: 0.85}, {score: 0.80}, {score: 1e-12},
 *   ])
 *   // → 2 (loop stopped at the noise floor — only the two real
 *   //      hits survive)
 *
 * @example <caption>Bounded scan via maxCutIndex</caption>
 *   ratioEffectiveCount([
 *     {score: 0.9}, {score: 0.5}, {score: 0.1}, {score: 0.05},
 *   ], { maxCutIndex: 2 })
 *   // → at most 2 (scan and cut both capped at index 2)
 *
 * @example <caption>Single-hit and empty inputs</caption>
 *   ratioEffectiveCount([])               // → 0
 *   ratioEffectiveCount([{score: 0.9}])   // → 1 (no pair to compare)
 */
const ratioEffectiveCount = (hits, options) => {
  const n = hits.length;
  if (n < 2) return n;

  // Normalize options. `minGap` wins if both are provided; otherwise
  // `minLogGap` is exponentiated; otherwise the default of 3 is used.
  // `eps` defaults to 1e-10 and clamps to non-negative.
  // `maxCutIndex` defaults to n and clamps to [1, n].
  let {
    minLogGap,
    minGap,
    eps,
    maxCutIndex = n
  } = options || {};
  (minGap === null || minGap === undefined) && (
    minGap = (minLogGap === null || minLogGap === undefined) && 3 || Math.exp(minLogGap)
  );
  eps = (eps === null || eps === undefined) && 1e-10 || Math.max(eps, 0);
  maxCutIndex = Math.max(Math.min(maxCutIndex, n), 1);

  // Walk consecutive pairs once. Track the steepest qualifying cliff
  // and the corresponding cut index. Default `cutIdx = maxCutIndex`
  // means "no cut found yet"; the final `min(cutIdx, i)` picks the
  // elbow when one exists and falls back to the noise-floor stop
  // when one does not.
  let cutIdx = maxCutIndex, maxGap = 0, i = 1;
  for (let ap, ac = hits[0].score, g; i !== maxCutIndex && ac > eps; ++i) {
    ap = ac;
    ac = hits[i].score;

    // Strict `>` on maxGap means ties resolve in favor of the earlier
    // cliff — a conservative choice that cuts higher in the
    // distribution when two ratios are equal.
    (g = ap / ac) > maxGap && (
      maxGap = g,
      g >= minGap && (cutIdx = i)
    );
  }

  // Final cut: the smaller of (elbow-derived cut, noise-floor stop).
  // When no elbow was found, `cutIdx === maxCutIndex` and `i` (the
  // index after the noise floor or end) wins. When an elbow was
  // found, `cutIdx` is typically ≤ i and wins. Lower-bounded at 1
  // so callers always get a sane truncation length.
  return Math.max(Math.min(cutIdx, i), 1);
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(ratioEffectiveCount, "ratioEffectiveCount", {
  value: ratioEffectiveCount,
}));