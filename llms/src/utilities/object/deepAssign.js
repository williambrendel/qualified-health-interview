/**
 * @file deepAssign.js
 * @brief Variadic deep-merge utility for plain objects.
 */

"use strict";

const isPlainObject = require("./isPlainObject");

/**
 * @function deepAssign
 * @description Performs a left-to-right variadic deep merge of plain objects,
 * mirroring the semantics of `Object.assign` but recursing into nested plain
 * objects instead of replacing them wholesale.
 *
 * Each successive source takes precedence over all prior sources. When both
 * the accumulated result and a source share a plain-object value at the same
 * key, they are merged recursively — preserving sibling keys at every depth.
 * Non-plain values (arrays, primitives, null) in a source always replace the
 * accumulated value for that key entirely; arrays are not merged.
 *
 * No input object is mutated. Falsy sources are skipped silently.
 *
 * @param {Object} base - The initial base object.
 * @param {...Object} overrides - Zero or more objects applied left-to-right.
 * @returns {Object} A new deeply merged object.
 *
 * @example
 * // Variadic — three sources, rightmost wins on conflict
 * deepAssign({ a: 1 }, { a: 2, b: 3 }, { b: 99 });
 * // → { a: 2, b: 99 }
 *
 * @example
 * // Nested plain objects — deep merged, sibling keys preserved
 * deepAssign(
 *   { input: { standard: 3.00, cacheWrite: 3.75, cacheRead: 0.30 } },
 *   { input: { standard: 2.00 } }
 * );
 * // → { input: { standard: 2.00, cacheWrite: 3.75, cacheRead: 0.30 } }
 *
 * @example
 * // Deeply nested — all levels merged across all sources
 * deepAssign(
 *   { a: { b: { c: 1, d: 2 } } },
 *   { a: { b: { c: 99 } } }
 * );
 * // → { a: { b: { c: 99, d: 2 } } }
 *
 * @example
 * // Nested array — source replaces entirely (not merged)
 * deepAssign({ tags: ["a", "b"] }, { tags: ["c"] });
 * // → { tags: ["c"] }
 *
 * @example
 * // Falsy sources are skipped
 * deepAssign({ a: 1 }, null, undefined, { b: 2 });
 * // → { a: 1, b: 2 }
 *
 * @example
 * // Pricing config — partial override preserves sibling rates
 * deepAssign(
 *   { input: { standard: 3.00, cacheWrite: 3.75, cacheRead: 0.30 }, batchDiscount: 0.5 },
 *   { input: { standard: 2.00 }, batchDiscount: 0.4 }
 * );
 * // → { input: { standard: 2.00, cacheWrite: 3.75, cacheRead: 0.30 }, batchDiscount: 0.4 }
 */
const deepAssign = (base, ...overrides) => {
  let result = { ...(base || {}) };
  for (const override of overrides) {
    if (!override) continue;
    for (const k in override) {
      result[k] = isPlainObject(override[k]) && isPlainObject(result[k])
        ? deepAssign(result[k], override[k])
        : override[k];
    }
  }
  return result;
};

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(deepAssign, "deepAssign", {
  value: deepAssign
}));