/**
 * @file formatObject.js
 * @brief Utility to format object into string for logging.
 */

"use strict";

/**
 * @function formatObject
 * @description
 * Recursively formats an object's key-value pairs into a hierarchically indented
 * string. Supports nested objects and arrays.
 *
 * @param {Object} obj - The target object to format.
 * @param {number} [indent=0] - The initial number of leading spaces for the current depth.
 * @param {number} [indentStep=2] - The number of spaces to add for each nested level.
 *
 * @returns {string} The formatted string representation of the object.
 *
 * @example
 * const config = {
 *   port: 8080,
 *   db: { host: "localhost", user: "admin" },
 *   flags: ["quiet", "debug"]
 * };
 * formatObject(config);
 * // → "port: 8080\ndb:\n  host: localhost\n  user: admin\nflags: [quiet, debug]"
 */
const formatObject = (obj, indent = 0, indentStep = 2) => {
  const spaces = " ".repeat(indent);

  return Object.entries(obj).map(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return `${spaces}${key}:\n${formatObject(value, indent + indentStep, indentStep)}`;
    } else if (Array.isArray(value)) {
      return `${spaces}${key}: [${value.join(", ")}]`;
    } else {
      return `${spaces}${key}: ${value}`;
    }
  }).join("\n");
};

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(formatObject, "formatObject", {
  value: formatObject
}));