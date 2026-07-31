"use strict";

/**
 * Compute adaptive support threshold via the log-ratio gap method.
 *
 * Sort α descending, find the largest gap in `log(α_prev / α_curr)` between
 * consecutive values, and cut there if the gap is "meaningful" (≥ minLogGap).
 * Returns the smallest α-value that should be IN the support — anything
 * strictly below this should be cut.
 *
 * @param {Float32Array} alpha
 * @param {number} [minLogGap=Math.log(3)]  Minimum gap to trust as an elbow.
 * @returns {number}  α-threshold (use as supportThreshold lower bound).
 */
const logRatioGapThreshold = (alpha, options) => {

  const n = alpha.length;
  if (n === 0) return 0;

  // Truncate alpha.
  let l = 0;
  let _alpha = new Float32Array(n);
  for (let i = 0, v; i !== n; ++i) {
    (v = alpha[i]) > 0 && (_alpha[l++] = v);
  };
  if (l === 0) return 0;

  // Work only on a positive subset.
  _alpha = _alpha.subarray(0, l);

  // Sort value in descending order.
  _alpha.sort(DESC);

  // Normalize options.
  let {
    minLogGap,
    minGap,
    eps
  } = options || {};
  (minGap === null || minGap === undefined) && (
    minGap = (minLogGap === null || minLogGap === undefined) && 3 || Math.exp(minLogGap)
  );
  (eps === null || eps === undefined) && (eps = 1e-10);

  let cutIdx = l;        // default: keep all
  let maxGap = 0;
  for (let i = 1, ap, ac = _alpha[0], g; i !== l; ++i) {
    ap = ac;
    ac = _alpha[i];
    // Hitting the noise floor means the rest of the tail is meaningless.
    // Stop, and only fall back to the noise-floor cut if no real elbow
    // was found earlier — never overwrite a valid elbow with this.
    if (ac < eps) { cutIdx === l && (cutIdx = i); break; }
    (g = ap / ac) > maxGap && (
      maxGap = g,
      g >= minGap && (cutIdx = i)
    );
  }
  // Threshold = α-value just BELOW the cut (so > threshold survives).
  // If cutIdx === n we keep everything → threshold = 0.
  return cutIdx < l && _alpha[cutIdx] || 0;
};

const DESC = (a, b) => b - a;

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(logRatioGapThreshold, "logRatioGapThreshold", {
  value: logRatioGapThreshold
}));