"use strict";

const deeppAssign = require("./deepAssign");
const formatObject = require("./formatObject");
const isPlainObject = require("./isPlainObject");

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze({
  deeppAssign,
  formatObject,
  isPlainObject
});