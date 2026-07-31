"use strict";

/**
 * Compute adaptive support threshold via entropy-based effective count.
 *
 * Compute Shannon entropy H = −∑ p_i log p_i over normalized α, then
 * keep ⌈exp(H)⌉ candidates by α-value. Returns the smallest α that
 * should be IN the support.
 *
 * @param {Float32Array} alpha
 * @returns {number}  α-threshold (use as supportThreshold lower bound).
 */
const entropyThreshold = alpha => {
  const n = alpha.length;
  if (n === 0) return 0;

  // Truncate alpha.
  let s = 0, l = 0;
  let _alpha = new Float32Array(n);
  for (let i = 0, v; i !== n; ++i) {
    (v = alpha[i]) > 0 && (
      s += (_alpha[l++] = v)
    );
  };
  if (l === 0) return 0;

  // Work only on a positive subset.
  _alpha = _alpha.subarray(0, l);

  let H = 0;
  for (let i = 0, p; i !== l; ++i)  H -= (p = _alpha[i]) * Math.log(p);
  H = Math.log(s) + H / s;

  const k = Math.min(l, Math.max(1, Math.ceil(Math.exp(H))));

  _alpha.sort(DESC);  // descending

  // The k-th candidate (1-indexed) should still be in support.
  // Threshold = the (k+1)-th largest α, i.e. just below the cut.
  // If k === l, keep everything → threshold = 0.
  return k < l && _alpha[k] * s || 0;
};

const DESC = (a, b) => b - a;

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(entropyThreshold, "entropyThreshold", {
  value: entropyThreshold
}));