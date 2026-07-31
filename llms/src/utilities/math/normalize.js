"use strict";

const { dotProductUnsafe, dotProduct } = require("./dotProduct");

/**
 * @function normalizeUnsafe
 * @description
 * Computes the **L2-normalised** version of a numeric vector without any
 * input validation. Skips all guard checks for maximum performance.
 *
 * Writes the unit-magnitude vector in the same direction as `x` to the
 * output buffer:
 *
 * `out[outOffset + j] = x[offset + j] / ‖x‖`  for `j ∈ [0, dim)`
 *
 * where `‖x‖ = √(x · x)` over the specified sub-range of `x`.
 *
 * **Zero-magnitude handling:** if the input has zero norm, the output
 * buffer is left untouched (avoids division by zero). For a freshly
 * allocated `out`, the result is a zero vector; for a reused `out`, prior
 * contents remain in place.
 *
 * Internally delegates the squared-norm computation to
 * {@link dotProductUnsafe}, which is manually unrolled by 4.
 *
 * Prefer {@link normalize} unless the call site has already validated that
 * `x` is a non-empty array, `dim > 0`, and offsets are `>= 0`.
 *
 * Exposed as `normalize.normalizeUnsafe` for convenience.
 *
 * @param {number[]|Float32Array} x             - Input vector. Must be a non-empty array.
 * @param {number}                dim           - Number of elements to process. Must be `> 0`.
 * @param {number}                [offset=0]    - Start index into `x`. Must be `>= 0`.
 * @param {number[]|Float32Array} [out]         - Output buffer. If omitted, a new
 *                                                `Float32Array` of length `dim` is allocated.
 * @param {number}                [outOffset=0] - Start index into `out`. Must be `>= 0`.
 *
 * @returns {number[]|Float32Array} The output buffer (`out` if provided, else a
 *                                  freshly allocated `Float32Array`).
 *
 * @example
 * normalize.normalizeUnsafe([3, 4], 2, 0);
 * // => Float32Array [0.6, 0.8]
 *
 * @example
 * // Reuse caller-provided buffer.
 * const buf = new Float32Array(2);
 * normalize.normalizeUnsafe([3, 4], 2, 0, buf, 0);
 * // buf is now Float32Array [0.6, 0.8]
 *
 * @example
 * // Sub-range read with offset.
 * normalize.normalizeUnsafe([0, 0, 3, 4], 2, 2);
 * // processes x[2..3] → Float32Array [0.6, 0.8]
 */
const normalizeUnsafe = (x, dim, offset, out, outOffset) => {
  out || (out = new Float32Array(dim));
  offset > 0 || (offset = 0);
  outOffset > 0 || (outOffset = 0);
  let normSquared = dotProductUnsafe(x, x, dim, offset, offset);
  if (normSquared) {
    normSquared = 1 / Math.sqrt(normSquared);
    for (let j = 0; j !== dim; ++j) out[j + outOffset] = x[j + offset] * normSquared;
  }
  return out;
}

/**
 * @function normalize
 * @description
 * Computes the **L2-normalised** version of a numeric vector:
 *
 * `out = x / ‖x‖`
 *
 * Validates input before computing, returning a unit-magnitude vector in
 * the same direction as `x` (length `1` for non-zero inputs).
 *
 * **Input normalization:** offsets are clamped to `>= 0`. If `out` is
 * omitted, a new `Float32Array` of length `dim` is allocated.
 *
 * **Zero-magnitude handling:** if `x` has zero norm, the output buffer is
 * left untouched (avoids division by zero). For a freshly allocated `out`,
 * the result is a zero vector; for a reused `out`, prior contents remain
 * in place.
 *
 * Internally delegates the squared-norm computation to {@link dotProduct},
 * which is manually unrolled by 4.
 *
 * The unsafe variant is accessible as `normalize.normalizeUnsafe`.
 *
 * @param {number[]|Float32Array} x             - Input vector.
 * @param {number}                dim           - Number of elements to process.
 * @param {number}                [offset=0]    - Start index into `x`. Clamped to `>= 0`.
 * @param {number[]|Float32Array} [out]         - Output buffer. If omitted, a new
 *                                                `Float32Array` of length `dim` is allocated.
 * @param {number}                [outOffset=0] - Start index into `out`. Clamped to `>= 0`.
 *
 * @returns {number[]|Float32Array} The output buffer (`out` if provided, else a
 *                                  freshly allocated `Float32Array`). When `x`
 *                                  has zero magnitude, the buffer is returned
 *                                  unchanged.
 *
 * @example
 * // Basic usage.
 * normalize([3, 4], 2);
 * // => Float32Array [0.6, 0.8]
 *
 * @example
 * // Sub-range with offset.
 * normalize([0, 0, 3, 4], 2, 2);
 * // processes x[2..3] → Float32Array [0.6, 0.8]
 *
 * @example
 * // Reuse output buffer with offset write.
 * const buf = new Float32Array(4);
 * normalize([3, 4], 2, 0, buf, 2);
 * // buf is now Float32Array [0, 0, 0.6, 0.8]
 *
 * @example
 * // Zero-magnitude input — buffer untouched.
 * normalize([0, 0], 2);
 * // => Float32Array [0, 0]  (freshly allocated, already zeros)
 */
const normalize = (x, dim, offset, out, outOffset) => {
  out || (out = new Float32Array(dim));
  offset > 0 || (offset = 0);
  outOffset > 0 || (outOffset = 0);
  let normSquared = dotProduct(x, x, dim, offset, offset);
  if (normSquared) {
    normSquared = 1 / Math.sqrt(normSquared);
    for (let j = 0; j !== dim; ++j) out[j + outOffset] = x[j + offset] * normSquared;
  }
  return out;
}

/**
 * @name normalize.normalizeUnsafe
 * @type {normalizeUnsafe}
 * @description Alias for {@link normalizeUnsafe}. Computes L2 normalisation
 *              without input validation.
 */
normalize.normalizeUnsafe = normalizeUnsafe;

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(normalize, "normalize", {
  value: normalize
}));