"use strict";

/**
 * @module pipeline/analyzers
 * @description Analyzer registry barrel. Requiring this registers every analyzer
 * module (each calls `register(...)` on load). Add an analyzer by dropping a module
 * here and requiring it — no change to the connectors or `/analyze`.
 *
 * Each analyzer declares the canonical entities it needs; the registry runs only the
 * ones the dataset satisfies. That's the data-agnostic seam: the *mechanism* assumes
 * nothing, and an analyzer whose entities aren't present simply doesn't fire.
 */

const registry = require("./registry");

const abnormalResult = require("./abnormalResult");                // requires: lab_result
const careGap = require("./careGap");                              // requires: problem + lab_result + lab_order
const medRecon = require("./medRecon");                            // requires: note + medication_order
const statisticalDataQuality = require("./statisticalDataQuality"); // requires: "*" (any entity)

module.exports = { registry, abnormalResult, careGap, medRecon, statisticalDataQuality };
