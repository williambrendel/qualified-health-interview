"use strict";

/**
 * @module pipeline/analyzers/abnormalResult
 * @description Abnormal-result triage, packaged as a registry analyzer. Applies only
 * to the `lab_result` entity. This is the *clinical* app layer — the swappable opinion.
 */

const path = require("path");
const { register } = require("./registry");
const { triage } = require("../checks/abnormalResult");

const ANALYTES = require(path.resolve(__dirname, "../../../config/clinical/analytes.json"));

module.exports = register({
  id: "abnormal-result-triage",
  title: "Abnormal-result triage",
  appliesTo: (entity) => entity === "lab_result",
  run: (records, opts = {}) => {
    const t = triage(records, { analytes: opts.analytes || ANALYTES });
    return [...t.clinical, ...t.dataQuality]; // flat findings
  },
});
