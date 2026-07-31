"use strict";

/**
 * Compute the cumulative per-section vector offsets from an index buffer.
 *
 * `vecOffsets` is an `(numSections + 1)`-length prefix sum where
 * `vecOffsets[s]` is the index of the first vector belonging to section
 * `s`, and `vecOffsets[s + 1]` is one past its last vector. This lets the
 * score loop fetch a section's vector range in O(1) without re-summing.
 *
 * @param {Uint32Array} indexBuffer
 * @param {number} indexDim
 * @param {number} numSections
 * @returns {Uint32Array}
 */
const computeVecOffsets = (indexBuffer, indexDim, numSections) => {
  const vecOffsets = new Uint32Array(numSections + 1);
  for (let i = 0; i !== numSections; ++i) {
    vecOffsets[i + 1] = vecOffsets[i] + indexBuffer[i * indexDim + 2];
  }
  return vecOffsets;
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(computeVecOffsets, "computeVecOffsets", {
  value: computeVecOffsets,
}));