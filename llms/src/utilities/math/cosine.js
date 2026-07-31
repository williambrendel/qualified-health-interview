"use strict";

/**
 * @function cosineUnsafe
 * @description
 * Computes the **cosine similarity** between two numeric vectors without any
 * input validation. Skips all guard checks for maximum performance.
 *
 * The dot product and both squared magnitudes are accumulated in a single
 * pass with a **manually unrolled loop of 4** for performance, with a scalar
 * remainder loop handling trailing elements when `dim` is not a multiple of 4.
 *
 * **Fast path:** when `v1 === v2` and `offset1 === offset2`, returns `1`
 * immediately without any computation.
 *
 * If either vector has zero magnitude, the raw dot product is returned
 * as-is to avoid division by zero.
 *
 * Prefer {@link cosine} unless the call site has already validated that both
 * vectors are non-empty arrays, `dim > 0`, and offsets are `>= 0`.
 *
 * Exposed as `cosine.cosineUnsafe` for convenience.
 *
 * @param {number[]} v1          - First input vector. Must be a non-empty array.
 * @param {number[]} v2          - Second input vector. Must be a non-empty array.
 * @param {number}   dim         - Number of elements to process. Must be `> 0`.
 * @param {number}   [offset1=0] - Start index into `v1`. Must be `>= 0`.
 * @param {number}   [offset2=0] - Start index into `v2`. Must be `>= 0`.
 *
 * @returns {number} Cosine similarity in `[-1, 1]`, or the raw dot product
 *                   if either vector has zero magnitude.
 *
 * @example
 * cosine.cosineUnsafe([1, 2, 3], [4, 5, 6], 3, 0, 0);
 * // => ~0.974
 *
 * @example
 * // Same-reference fast path
 * const v = [1, 2, 3];
 * cosine.cosineUnsafe(v, v, 3, 0, 0);
 * // => 1  (no computation performed)
 */
const cosineUnsafe = (v1, v2, dim, offset1 = 0, offset2 = 0) => {
  // Fast path: identical reference and offset — cosine similarity is always 1.
  if (v1 === v2 && offset1 === offset2) return 1;
  if (!(dim > 0)) return 0;

  // Compute cosine by increment of 4 for faster computation.
  let d = 0, o1 = offset1 || 0, o2 = offset2 || 0, res = 0, n1 = 0, n2 = 0;
  for (const e = dim - 4; d < e; d += 4, o1 += 4, o2 += 4) {
    const v10 = v1[o1], v11 = v1[o1 + 1], v12 = v1[o1 + 2], v13 = v1[o1 + 3];
    const v20 = v2[o2], v21 = v2[o2 + 1], v22 = v2[o2 + 2], v23 = v2[o2 + 3];
    res += v10 * v20 + v11 * v21 + v12 * v22 + v13 * v23;
    n1  += v10 * v10 + v11 * v11 + v12 * v12 + v13 * v13;
    n2  += v20 * v20 + v21 * v21 + v22 * v22 + v23 * v23;
  }

  // Remainder if dim is not a multiple of 4.
  for (; d !== dim; ++d, ++o1, ++o2) {
    const v10 = v1[o1], v20 = v2[o2];
    res += v10 * v20;
    n1  += v10 * v10;
    n2  += v20 * v20;
  }

  return n1 && n2 ? res / Math.sqrt(n1 * n2) : res;
}

/**
 * @function cosine
 * @description
 * Computes the **cosine similarity** between two numeric vectors:
 *
 * `similarity = (v1 · v2) / (‖v1‖ * ‖v2‖)`
 *
 * Validates input before delegating to {@link cosineUnsafe}.
 *
 * Returns a value in the range `[-1, 1]` for non-zero vectors:
 * - `1`  — identical direction
 * - `0`  — orthogonal
 * - `-1` — opposite direction
 *
 * **Input normalization:** if either `v1` or `v2` is falsy, the other is used
 * as a fallback. Returns `0` immediately if both are non-arrays, if `dim`
 * resolves to zero, or if either input is empty.
 *
 * **Fast path:** when `v1 === v2` and `offset1 === offset2`, returns `1`
 * immediately without any computation (via {@link cosineUnsafe}).
 *
 * If either vector has zero magnitude, the raw dot product is returned
 * as-is to avoid division by zero.
 *
 * The unsafe variant is accessible as `cosine.cosineUnsafe`.
 *
 * @param {number[]} [v1]        - First input vector. Falls back to `v2` if falsy.
 * @param {number[]} [v2]        - Second input vector. Falls back to `v1` if falsy.
 * @param {number}   [dim]       - Number of elements to process. Defaults to
 *                                 `Math.min(v1.length, v2.length)`.
 * @param {number}   [offset1=0] - Start index into `v1`. Clamped to `>= 0`.
 * @param {number}   [offset2=0] - Start index into `v2`. Clamped to `>= 0`.
 *
 * @returns {number} Cosine similarity in `[-1, 1]`, or `0` if inputs are
 *                   invalid, or the raw dot product if either vector has
 *                   zero magnitude.
 *
 * @example
 * // Identical direction
 * cosine([1, 2, 3], [2, 4, 6]);
 * // => 1
 *
 * @example
 * // Orthogonal vectors
 * cosine([1, 0], [0, 1]);
 * // => 0
 *
 * @example
 * // Opposite direction
 * cosine([1, 0], [-1, 0]);
 * // => -1
 *
 * @example
 * // Same-reference fast path
 * const v = [1, 2, 3];
 * cosine(v, v);
 * // => 1  (no computation performed)
 *
 * @example
 * // Single vector — self-similarity
 * cosine([1, 2, 3]);
 * // => 1  (v2 falls back to v1)
 *
 * @example
 * // Invalid input
 * cosine(null, null);
 * // => 0
 *
 * @example
 * // Sub-range with offsets
 * cosine([0, 1, 2, 3], [0, 4, 5, 6], 2, 2, 1);
 * // processes v1[2..3] · v2[1..2]
 */
const cosine = (v1, v2, dim, offset1, offset2) => {
  // Normalize entries.
  v1 || (v1 = v2);
  v2 || (v2 = v1);
  if (!(Array.isArray(v1) && Array.isArray(v2))) return 0;

  dim >= 0 && dim !== null || (dim = Math.min(v1.length, v2.length));

  offset1 = Math.max(offset1 || 0, 0);
  offset2 = Math.max(offset2 || 0, 0);

  return cosineUnsafe(v1, v2, dim, offset1, offset2);
}

/**
 * @name cosine.cosineUnsafe
 * @type {cosineUnsafe}
 * @description Alias for {@link cosineUnsafe}. Computes cosine similarity
 *              without input validation.
 */
cosine.cosineUnsafe = cosineUnsafe;

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(cosine, "cosine", {
  value: cosine
}));