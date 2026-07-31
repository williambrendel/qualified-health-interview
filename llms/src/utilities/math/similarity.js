"use strict";

const { cosineUnsafe } = require("./cosine");
const { dotProductUnsafe } = require("./dotProduct");

/**
 * @typedef {Object} SimilarityOptions
 * @description Options object for {@link similarity} and {@link similarityUnsafe}.
 *
 * @property {number}  [dim]             - Number of elements to process. Defaults to
 *                                         `Math.min(v1.length, v2.length)`.
 * @property {number}  [offset1=0]       - Start index into `v1`.
 * @property {number}  [offset2=0]       - Start index into `v2`.
 * @property {boolean} [normalize=false] - When `true`, returns cosine similarity
 *                                         via {@link cosineUnsafe}. When `false`,
 *                                         returns the raw dot product via
 *                                         {@link dotProductUnsafe}.
 */

/**
 * @function similarityUnsafe
 * @description
 * Computes the similarity between two numeric vectors without any input
 * validation. Skips all guard checks for maximum performance.
 *
 * Delegates to {@link cosineUnsafe} when `options.normalize` is `true`,
 * or to {@link dotProductUnsafe} otherwise.
 *
 * Prefer {@link similarity} unless the call site has already validated that
 * both vectors are non-empty arrays, `options.dim > 0`, and offsets are `>= 0`.
 *
 * Exposed as `similarity.similarityUnsafe` for convenience.
 *
 * @param {number[]}          v1      - First input vector. Must be a non-empty array.
 * @param {number[]}          v2      - Second input vector. Must be a non-empty array.
 * @param {SimilarityOptions} options - Options object. All fields must be valid.
 *
 * @returns {number} Cosine similarity in `[-1, 1]` if `options.normalize` is
 *                   `true`, or the raw dot product otherwise.
 *
 * @example
 * // Raw dot product
 * similarity.similarityUnsafe([1, 2, 3], [4, 5, 6], { dim: 3 });
 * // => 32
 *
 * @example
 * // Cosine similarity
 * similarity.similarityUnsafe([1, 2, 3], [4, 5, 6], { dim: 3, normalize: true });
 * // => ~0.974
 */
const similarityUnsafe = (v1, v2, options) => (
  options.normalize
    ? cosineUnsafe(v1, v2, options.dim, options.offset1, options.offset2)
    : dotProductUnsafe(v1, v2, options.dim, options.offset1, options.offset2)
);

/**
 * @function similarity
 * @description
 * Computes the similarity between two numeric vectors, either as a raw dot
 * product or as cosine similarity depending on `options.normalize`.
 *
 * **Input normalization:**
 * - If either `v1` or `v2` is falsy, the other is used as a fallback.
 * - Returns `0` immediately if both inputs are non-arrays or if `dim`
 *   resolves to zero.
 * - `options` is merged over safe defaults if provided, or constructed
 *   from defaults if omitted. `options.dim` defaults to
 *   `Math.min(v1.length, v2.length)` after merge.
 *
 * Delegates to {@link similarityUnsafe} after normalization, which in turn
 * delegates to {@link cosineUnsafe} or {@link dotProductUnsafe}.
 *
 * The unsafe variant is accessible as `similarity.similarityUnsafe`.
 *
 * @param {number[]}          [v1]      - First input vector. Falls back to `v2` if falsy.
 * @param {number[]}          [v2]      - Second input vector. Falls back to `v1` if falsy.
 * @param {SimilarityOptions} [options] - Similarity options. Safe defaults are applied
 *                                        for any omitted fields.
 *
 * @returns {number} Cosine similarity in `[-1, 1]` if `options.normalize` is
 *                   `true`, or the raw dot product otherwise. Returns `0` if
 *                   inputs are invalid or `dim` resolves to zero.
 *
 * @example
 * // Raw dot product (default)
 * similarity([1, 2, 3], [4, 5, 6]);
 * // => 32
 *
 * @example
 * // Cosine similarity
 * similarity([1, 2, 3], [4, 5, 6], { normalize: true });
 * // => ~0.974
 *
 * @example
 * // Single vector — squared magnitude
 * similarity([3, 4]);
 * // => 25  (v2 falls back to v1)
 *
 * @example
 * // Invalid input
 * similarity(null, null);
 * // => 0
 *
 * @example
 * // Sub-range with offsets
 * similarity([0, 1, 2, 3], [0, 4, 5, 6], { dim: 2, offset1: 2, offset2: 1 });
 * // => 2*4 + 3*5 = 23
 */
const similarity = (v1, v2, options) => {
  v1 || (v1 = v2);
  v2 || (v2 = v1);
  if (!(Array.isArray(v1) && Array.isArray(v2))) return 0;

  options = options && Object.assign({
    dim: null,
    offset1: 0,
    offset2: 0,
    normalize: false
  }, options) || {
    dim: null,
    offset1: 0,
    offset2: 0,
    normalize: false
  };

  options.dim >= 0 && options.dim !== null || (options.dim = Math.min(v1.length, v2.length));
  if (!(options.dim > 0)) return 0;

  return similarityUnsafe(v1, v2, options);
}

/**
 * @name similarity.similarityUnsafe
 * @type {similarityUnsafe}
 * @description Alias for {@link similarityUnsafe}. Computes similarity without
 *              input validation.
 */
similarity.similarityUnsafe = similarityUnsafe;

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(similarity, "similarity", {
  value: similarity
}));