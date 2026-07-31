"use strict";

const math = require("./math");
const object = require("./object");
const getMediaType = require("./getMediaType");
const parseResponseJson = require("./parseResponseJson");
const spinner = require("./spinner");

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze({
  // Math utilities.
  ...math,

  // Object utilities.
  ...object,

  // Other.
  getMediaType,
  parseResponseJson,
  spinner,
});