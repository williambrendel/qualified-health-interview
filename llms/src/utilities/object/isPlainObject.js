/**
 * @file isPlainObject.js
 * @brief Utility predicate for identifying plain objects.
 */

"use strict";

/**
 * @function isPlainObject
 * @description Returns true if a value is a plain object — a non-null, non-array
 * value whose typeof is `"object"`.
 * Excludes arrays, null, and all primitives. Does not check the prototype
 * chain — class instances such as Date, Map, Set, and RegExp are considered
 * plain objects by this predicate. Use a stricter check if that distinction matters.
 *
 * Designed for use as a guard before object spread or recursive merge operations
 * where arrays and null would produce incorrect results if treated as objects.
 *
 * @param {*} v - The value to test.
 * @returns {boolean} True if `v` is a plain object, false otherwise.
 *
 * @example
 * isPlainObject({});                    // → true
 * isPlainObject({ a: 1, b: 2 });        // → true
 * isPlainObject(null);                  // → false
 * isPlainObject([1, 2, 3]);             // → false
 * isPlainObject("string");              // → false
 * isPlainObject(42);                    // → false
 * isPlainObject(true);                  // → false
 * isPlainObject(undefined);             // → false
 * isPlainObject(new Date());            // → false — class instance
 * isPlainObject(() => {});              // → false — function
 */
const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(isPlainObject, "isPlainObject", {
  value: isPlainObject
}));