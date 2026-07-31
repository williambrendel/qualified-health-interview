"use strict";

const { MIN_OUTPUT_ROWS, MAX_OUTPUT_ROWS } = require("./constants");

/**
 * @file applySafetyRails.js
 * @module VectorStore/applySafetyRails
 * @description Enforce {@link MIN_OUTPUT_ROWS} and {@link MAX_OUTPUT_ROWS}
 * bounds on a hit list in place.
 *
 * Pruning can leave a hit list outside the desired output bounds. If too
 * many hits survive, the tail is truncated. If too few, the pre-prune
 * snapshot is consulted and the missing top hits are restored.
 *
 * Restoration is element-wise (`push`), not via `hits.length` extension —
 * the latter would produce `undefined` slots rather than restore the
 * original elements.
 */

/**
 * Apply MIN/MAX safety rails in place.
 *
 * @function applySafetyRails
 * @param {Array} hits  - Post-prune hit list. Mutated.
 * @param {Array} saved - Pre-prune snapshot of the same hits, in the same
 *   scoring scale, sorted descending. Used to restore missing entries when
 *   `hits.length < MIN_OUTPUT_ROWS`.
 * @returns {Array} the input hits.
 */
const applySafetyRails = (hits, saved) => {
  if (hits.length < MIN_OUTPUT_ROWS) {
    const target = Math.min(MIN_OUTPUT_ROWS, saved.length);
    hits.length = 0;
    for (let i = 0; i !== target; ++i) hits.push(saved[i]);
  }
  hits.length > MAX_OUTPUT_ROWS && (hits.length = MAX_OUTPUT_ROWS);
  return hits;
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(applySafetyRails, "applySafetyRails", {
  value: applySafetyRails,
}));
