"use strict";

/**
 * @module pipeline/analyzers
 * @description Analyzer registry barrel. Requiring this registers every analyzer
 * module (each calls `register(...)` on load). Add an analyzer by dropping a module
 * here and requiring it — no change to the connectors or `/analyze`.
 */

const registry = require("./registry");

const abnormalResult = require("./abnormalResult");        // entity: lab_result (clinical)
const statisticalDataQuality = require("./statisticalDataQuality"); // any entity (generic)

module.exports = { registry, abnormalResult, statisticalDataQuality };
