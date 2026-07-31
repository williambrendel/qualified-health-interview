"use strict";

/**
 * @function l2SquaredUnsafe
 * @description
 * Computes the **squared L2 norm** of a numeric vector without any input
 * validation. Skips all guard checks for maximum performance.
 *
 * The inner loop is **manually unrolled by 4** for performance, with a scalar
 * remainder loop handling trailing elements when `dim` is not a multiple of 4.
 *
 * Prefer {@link l2Squared} unless the call site has already validated that
 * `v` is a non-empty array, `dim > 0`, and `offset >= 0`.
 *
 * Exposed as `l2.l2SquaredUnsafe` for convenience.
 *
 * @param {number[]} v          - Input vector. Must be a non-empty array.
 * @param {number}   dim        - Number of elements to process. Must be `> 0`.
 * @param {number}   [offset=0] - Start index into `v`. Must be `>= 0`.
 *
 * @returns {number} The squared L2 norm of the specified sub-range of `v`.
 *
 * @example
 * l2.l2SquaredUnsafe([3, 4], 2, 0);
 * // => 3*3 + 4*4 = 25
 */
const l2SquaredUnsafe = (v, dim = v.length, offset = 0) => {
  if (!(dim > 0)) return 0;

  let d = 0, o = offset || 0, res = 0, r0 = 0, r1 = 0, r2 = 0, r3 = 0, c;
  for (const e = dim & ~3; d < e; d += 4) {
    r0 += (c = v[o++]) * c;
    r1 += (c = v[o++]) * c;
    r2 += (c = v[o++]) * c;
    r3 += (c = v[o++]) * c;
  }
  res = r0 + r1 + r2 + r3;

  // Remainder if dim is not a multiple of 4.
  switch (dim & 3) {
    case 3:
      res += (c = v[o + 2]) * c;
    case 2:
      res += (c = v[o + 1]) * c;
    case 1:
      res += (c = v[o]) * c;
  }

  return res;
}

/**
 * @function l2Squared
 * @description
 * Computes the **squared L2 norm** (squared Euclidean magnitude) of a numeric
 * vector, optionally restricted to a sub-range via `dim` and `offset`:
 *
 * `‖v‖² = v[0]² + v[1]² + ... + v[dim-1]²`
 *
 * Validates input before delegating to {@link l2SquaredUnsafe}. Returns `0`
 * immediately if `v` is not a non-empty array or if `dim` resolves to
 * non-positive. Negative offsets are clamped to `0`.
 *
 * Exposed as both `l2.squared` and `l2.l2Squared` for convenience.
 *
 * @param {number[]} v          - Input vector.
 * @param {number}   [dim]      - Number of elements to process. Defaults to
 *                                `v.length`. Returns `0` if not strictly positive.
 * @param {number}   [offset=0] - Start index into `v`. Clamped to `>= 0`.
 *
 * @returns {number} The squared L2 norm of the specified sub-range of `v`,
 *                   or `0` if `v` is not a non-empty array or `dim` is not
 *                   strictly positive.
 *
 * @example
 * l2.squared([3, 4]);
 * // => 3*3 + 4*4 = 25
 *
 * @example
 * // Sub-range with offset
 * l2.squared([0, 3, 4, 0], 2, 1);
 * // processes v[1..2] = 3*3 + 4*4 = 25
 *
 * @example
 * // Invalid input — returns 0
 * l2.squared([]);
 * // => 0
 */
const l2Squared = (v, dim, offset) => {
  if (!(
    Array.isArray(v)
      && v.length 
      && (dim >= 0 && dim !== null || (dim = v.length))
  )) return 0;
  offset = Math.max(offset || 0, 0);
  return l2SquaredUnsafe(v, dim, offset);
}

/**
 * @function l2
 * @description
 * Computes the **L2 norm** (Euclidean magnitude) of a numeric vector,
 * optionally restricted to a sub-range via `dim` and `offset`:
 *
 * `‖v‖ = √(v[0]² + v[1]² + ... + v[dim-1]²)`
 *
 * Validates input before delegating to {@link l2Squared}. Returns `0` if the
 * squared norm is zero or if the input is invalid (propagated from
 * {@link l2Squared}).
 *
 * The squared variant is accessible as `l2.squared` or `l2.l2Squared`.
 * The unsafe variants are accessible as `l2.l2Unsafe` and `l2.l2SquaredUnsafe`.
 *
 * @param {number[]} v          - Input vector.
 * @param {number}   [dim]      - Number of elements to process. Defaults to `v.length`.
 * @param {number}   [offset=0] - Start index into `v`. Clamped to `>= 0`.
 *
 * @returns {number} The L2 norm of the specified sub-range of `v`, or `0`
 *                   if the squared norm is zero or the input is invalid.
 *
 * @example
 * // Euclidean magnitude
 * l2([3, 4]);
 * // => 5
 *
 * @example
 * // Zero vector
 * l2([0, 0, 0]);
 * // => 0
 *
 * @example
 * // Sub-range with offset
 * l2([0, 3, 4, 0], 2, 1);
 * // processes v[1..2] = √(3*3 + 4*4) = 5
 *
 * @example
 * // Squared variant
 * l2.squared([3, 4]);
 * // => 25
 */
const l2 = (v, dim, offset) => (
  v = l2Squared(v, dim, offset),
  v && Math.sqrt(v) || 0
);

/**
 * @function l2Unsafe
 * @description
 * Computes the **L2 norm** of a numeric vector without any input validation.
 * Skips all guard checks for maximum performance.
 *
 * Delegates to {@link l2SquaredUnsafe} internally, returning `Math.sqrt` of
 * the result. Returns `0` if the squared norm is zero.
 *
 * Prefer {@link l2} unless the call site has already validated that `v` is a
 * non-empty array, `dim > 0`, and `offset >= 0`.
 *
 * Exposed as `l2.l2Unsafe` for convenience.
 *
 * @param {number[]} v          - Input vector. Must be a non-empty array.
 * @param {number}   dim        - Number of elements to process. Must be `> 0`.
 * @param {number}   [offset=0] - Start index into `v`. Must be `>= 0`.
 *
 * @returns {number} The L2 norm of the specified sub-range of `v`, or `0`
 *                   if the squared norm is zero.
 *
 * @example
 * l2.l2Unsafe([3, 4], 2, 0);
 * // => 5
 */
const l2Unsafe = (v, dim, offset) => (
  v = l2SquaredUnsafe(v, dim, offset),
  v && Math.sqrt(v) || 0
);

/**
 * @name l2.l2Squared
 * @type {l2Squared}
 * @description Alias for {@link l2Squared}. Returns the squared L2 norm.
 */
l2.l2Squared = l2Squared;

/**
 * @name l2.l2SquaredUnsafe
 * @type {l2SquaredUnsafe}
 * @description Alias for {@link l2SquaredUnsafe}. Returns the squared L2 norm
 *              without input validation.
 */
l2.l2SquaredUnsafe = l2SquaredUnsafe;

/**
 * @name l2.l2Unsafe
 * @type {l2Unsafe}
 * @description Alias for {@link l2Unsafe}. Returns the L2 norm without input
 *              validation.
 */
l2.l2Unsafe = l2Unsafe;

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(l2, "l2", {
  value: l2
}));