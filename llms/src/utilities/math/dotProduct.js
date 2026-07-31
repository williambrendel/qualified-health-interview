"use strict";

const { l2SquaredUnsafe } = require("./l2");

/**
 * @function dotProductUnsafe
 * @description
 * Computes the dot product of two numeric vectors without any input
 * validation. Skips all guard checks for maximum performance.
 *
 * The inner loop is **manually unrolled by 4** for performance, with a scalar
 * remainder loop handling trailing elements when `dim` is not a multiple of 4.
 *
 * **Fast path:** when `v1 === v2` and `offset1 === offset2`, delegates to
 * {@link l2SquaredUnsafe}, returning the squared magnitude directly.
 *
 * Prefer {@link dotProduct} unless the call site has already validated that
 * both vectors are non-empty arrays, `dim > 0`, and offsets are `>= 0`.
 *
 * Exposed as `dotProduct.dotProductUnsafe` for convenience.
 *
 * @param {number[]} v1          - First input vector. Must be a non-empty array.
 * @param {number[]} v2          - Second input vector. Must be a non-empty array.
 * @param {number}   dim         - Number of elements to process. Must be `> 0`.
 * @param {number}   [offset1=0] - Start index into `v1`. Must be `>= 0`.
 * @param {number}   [offset2=0] - Start index into `v2`. Must be `>= 0`.
 *
 * @returns {number} The dot product of the specified sub-ranges of `v1` and
 *                   `v2`, or the squared magnitude via {@link l2SquaredUnsafe}
 *                   when `v1 === v2` and `offset1 === offset2`.
 *
 * @example
 * dotProduct.dotProductUnsafe([1, 2, 3], [4, 5, 6], 3, 0, 0);
 * // => 1*4 + 2*5 + 3*6 = 32
 *
 * @example
 * // Same-reference fast path
 * const v = [3, 4];
 * dotProduct.dotProductUnsafe(v, v, 2, 0, 0);
 * // => 3*3 + 4*4 = 25
 */
const dotProductUnsafe = (v1, v2, dim, offset1 = 0, offset2 = 0) => {
  // Fast path: return squared magnitude via l2SquaredUnsafe when both refs and offsets match.
  if (v1 === v2 && offset1 === offset2) return l2SquaredUnsafe(v1, dim, offset1);
  if (!(dim > 0)) return 0;

  // Compute dot product by increment of 4 for faster computation.
  let d = 0, o1 = offset1 ?? 0, o2 = offset2 ?? 0, res = 0, r0 = 0, r1 = 0, r2 = 0, r3 = 0;
  for (const e = dim & ~3; d < e; d += 4) {
    r0 += v1[o1++] * v2[o2++];
    r1 += v1[o1++] * v2[o2++];
    r2 += v1[o1++] * v2[o2++];
    r3 += v1[o1++] * v2[o2++];
  }
  res = r0 + r1 + r2 + r3;

  // Remainder if dim is not a multiple of 4.
  switch (dim & 3) {
    case 3:
      res += v1[o1 + 2] * v2[o2 + 2];
    case 2:
      res += v1[o1 + 1] * v2[o2 + 1];
    case 1:
      res += v1[o1] * v2[o2];
  }

  return res;
}

/**
 * Compute `n` dot products in a single batched call.
 *
 * Treats `M` as a flat row-major matrix of shape `n × dim` and computes
 * `v · M[i]` for each row `i ∈ [0, n)`. Equivalent to:
 *
 * ```
 * for (let i = 0; i < n; i++) output[i] = dotProduct(v, M.subarray(i*dim, (i+1)*dim));
 * ```
 *
 * but materially faster because the inner loop unrolls 4-wide. Each
 * iteration accumulates four products into four independent accumulators
 * (`r0..r3`), letting the CPU's pipelined multiplier stay busy through the
 * hot path instead of stalling on a single dependency chain. The four
 * partial sums are combined at the end.
 *
 * The function name is suffixed with `Unsafe` to flag that no input
 * validation is performed:
 *   - `v` must be at least `dim` elements long.
 *   - `M` must be at least `n × dim` elements long.
 *   - `output`, when supplied, must be at least `n` elements long.
 *   - All inputs must be numeric typed arrays (Float32Array / Float64Array).
 *
 * Violating any of these produces silently wrong results or undefined
 * behavior, not an exception. Use {@link dotProductBatch} (if defined) for
 * a validating variant.
 *
 * @function dotProductUnsafeBatch
 *
 * @param {Float32Array|Float64Array} v
 *   Query vector of length `dim`. Read but not modified.
 *
 * @param {Float32Array|Float64Array} M
 *   Row-major matrix of shape `n × dim`, flattened. `M[i*dim + j]` is the
 *   `j`-th component of the `i`-th row. Read but not modified.
 *
 * @param {number} n
 *   Number of rows in `M` to process. Must be `> 0` for any work to be
 *   done; non-positive `n` returns `null`.
 *
 * @param {number} dim
 *   Length of each row (and of `v`). When `dim <= 0`, the function returns
 *   a zero-initialized output array of length `n` without doing any work.
 *
 * @param {Float32Array} [output]
 *   Optional preallocated output buffer. Reused when its length is at
 *   least `n` — useful to avoid per-call allocation when the function is
 *   invoked repeatedly with the same `n`. When omitted or too short, a
 *   fresh `Float32Array(n)` is allocated.
 *
 * @returns {Float32Array|null}
 *   The output buffer with `output[i] = v · M[i]` for each row, or `null`
 *   when `n <= 0`.
 *
 * @example <caption>Score a query against many candidate vectors</caption>
 * const scores = dotProductUnsafeBatch(query, candidates, numCandidates, dim);
 * // scores[i] = dot product of query with the i-th candidate.
 *
 * @example <caption>Reuse an output buffer across calls</caption>
 * const buf = new Float32Array(maxN);
 * for (const { vectors, n } of batches) {
 *   const scores = dotProductUnsafeBatch(query, vectors, n, dim, buf);
 *   // ...
 * }
 *
 * @see dotProductUnsafe — single-vector variant.
 */
const dotProductUnsafeBatch = (v, M, n, dim, output) => {
  if (!(n > 0)) return null;

  // Reuse if big enough, else allocate.
  output && output.length >= n || (output = new Float32Array(n));
  if (!(dim > 0)) return output;

  for (let i = 0, o = 0, res, k, d, r0, r1, r2, r3, e = dim & ~3, rdim = dim & 3; i !== n; ++i) {
    k = d = r0 = r1 = r2 = r3 = 0;

    // Compute dot product by increment of 4 for faster computation.
    for (; d < e; d += 4) {
      r0 += v[k++] * M[o++];
      r1 += v[k++] * M[o++];
      r2 += v[k++] * M[o++];
      r3 += v[k++] * M[o++];
    }
    res = r0 + r1 + r2 + r3;

    // Remainder if dim is not a multiple of 4.
    switch (rdim) {
      case 3:
        res += v[k++] * M[o++];
      case 2:
        res += v[k++] * M[o++];
      case 1:
        res += v[k] * M[o++];
    }
    output[i] = res;
  }

  return output;
}

/**
 * @function dotProduct
 * @description
 * Computes the dot product of two numeric arrays (or vectors), optionally
 * restricted to a sub-range via `dim`, `offset1`, and `offset2`.
 *
 * The inner loop is **manually unrolled by 4** for performance — four
 * multiply-accumulate operations are executed per iteration, with a scalar
 * remainder loop handling any trailing elements when `dim` is not a multiple
 * of 4.
 *
 * **Input normalization:** if either `v1` or `v2` is falsy, the other is used
 * as a fallback. Returns `0` immediately if both are non-arrays, if `dim`
 * resolves to zero, or if either input is empty.
 *
 * **Fast path:** when `v1 === v2` and `offset1 === offset2`, computation is
 * delegated to {@link l2SquaredUnsafe} via {@link dotProductUnsafe}, returning
 * the squared magnitude directly without a redundant two-vector pass.
 *
 * The unsafe variant is accessible as `dotProduct.dotProductUnsafe`.
 *
 * @param {number[]} [v1]        - First input vector. Falls back to `v2` if falsy.
 * @param {number[]} [v2]        - Second input vector. Falls back to `v1` if falsy.
 * @param {number}   [dim]       - Number of elements to process. Defaults to
 *                                 `Math.min(v1.length, v2.length)`.
 * @param {number}   [offset1=0] - Start index into `v1`. Clamped to `>= 0`.
 * @param {number}   [offset2=0] - Start index into `v2`. Clamped to `>= 0`.
 *
 * @returns {number} The dot product of the specified sub-ranges of `v1` and
 *                   `v2`, or the squared magnitude via {@link l2SquaredUnsafe}
 *                   when `v1 === v2` and `offset1 === offset2`, or `0` if
 *                   inputs are invalid.
 *
 * @example
 * // Full dot product
 * dotProduct([1, 2, 3], [4, 5, 6]);
 * // => 1*4 + 2*5 + 3*6 = 32
 *
 * @example
 * // Same-reference fast path — squared magnitude via l2SquaredUnsafe
 * const v = [3, 4];
 * dotProduct(v, v);
 * // => 3*3 + 4*4 = 25
 *
 * @example
 * // Single vector — squared magnitude
 * dotProduct([3, 4]);
 * // => 25  (v2 falls back to v1)
 *
 * @example
 * // Invalid input
 * dotProduct(null, null);
 * // => 0
 *
 * @example
 * // Sub-range with offsets
 * dotProduct([0, 1, 2, 3], [0, 4, 5, 6], 2, 2, 1);
 * // processes v1[2..3] · v2[1..2] = 2*4 + 3*5 = 23
 */
const dotProduct = (v1, v2, dim, offset1, offset2) => {
  // Normalize entry.
  v1 || (v1 = v2);
  v2 || (v2 = v1);
  if (!(Array.isArray(v1) && Array.isArray(v2))) return 0;

  dim >= 0 && dim !== null || (dim = Math.min(v1.length, v2.length));

  offset1 = Math.max(offset1 || 0, 0);
  offset2 = Math.max(offset2 || 0, 0);

  return dotProductUnsafe(v1, v2, dim, offset1, offset2);
}

/**
 * @name dotProduct.dotProductUnsafe
 * @type {dotProductUnsafe}
 * @description Alias for {@link dotProductUnsafe}. Computes the dot product
 *              without input validation.
 */
dotProduct.dotProductUnsafe = dotProductUnsafe;

/**
 * @name dotProduct.dotProductUnsafeBatch
 * @type {dotProductUnsafeBatch}
 * @description Alias for {@link dotProductUnsafeBatch}. Computes the dot product
 *              without input validation and in batch.
 */
dotProduct.dotProductUnsafe.batch = dotProduct.dotProductUnsafeBatch = dotProductUnsafeBatch;

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(dotProduct, "dotProduct", {
  value: dotProduct
}));