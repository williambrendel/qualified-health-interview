"use strict";

const { cosine, cosineUnsafe } = require("./cosine");
const { dotProduct, dotProductUnsafe } = require("./dotProduct");
const { l2, l2Unsafe, l2Squared, l2SquaredUnsafe } = require("./l2");
const { similarity, similarityUnsafe } = require("./similarity");

/**
 * @file index.js
 * @description
 * Aggregated export of all vector math utilities.
 *
 * All functions follow a consistent pattern:
 * - A **safe** variant that validates input and returns `0` for invalid arguments.
 * - An **unsafe** variant that skips validation for maximum performance when
 *   inputs are pre-verified.
 *
 * Available utilities:
 * - {@link cosine} / {@link cosineUnsafe} — cosine similarity in `[-1, 1]`
 * - {@link dotProduct} / {@link dotProductUnsafe} — raw dot product
 * - {@link l2} / {@link l2Unsafe} — Euclidean magnitude (L2 norm)
 * - {@link l2Squared} / {@link l2SquaredUnsafe} — squared L2 norm
 * - {@link similarity} / {@link similarityUnsafe} — dot product or cosine
 *   similarity depending on `options.normalize`
 *
 * @example
 * const {
 *   cosine, cosineUnsafe,
 *   dotProduct, dotProductUnsafe,
 *   l2, l2Unsafe,
 *   l2Squared, l2SquaredUnsafe,
 *   similarity, similarityUnsafe
 * } = require("./math");
 *
 * cosine([1, 2, 3], [4, 5, 6]);                          // => ~0.974
 * cosineUnsafe([1, 2, 3], [4, 5, 6], 3, 0, 0);           // => ~0.974
 * dotProduct([1, 2, 3], [4, 5, 6]);                      // => 32
 * dotProductUnsafe([1, 2, 3], [4, 5, 6], 3, 0, 0);       // => 32
 * l2([3, 4]);                                            // => 5
 * l2Unsafe([3, 4], 2, 0);                                // => 5
 * l2Squared([3, 4]);                                     // => 25
 * l2SquaredUnsafe([3, 4], 2, 0);                         // => 25
 * similarity([1, 2, 3], [4, 5, 6]);                      // => 32
 * similarity([1, 2, 3], [4, 5, 6], { normalize: true }); // => ~0.974
 */
module.exports = Object.freeze({
  // Safe variants.
  cosine,
  dotProduct,
  l2,
  l2Squared,
  similarity,

  // Unsafe variants.
  cosineUnsafe,
  dotProductUnsafe,
  l2Unsafe,
  l2SquaredUnsafe,
  similarityUnsafe
});