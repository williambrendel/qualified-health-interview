"use strict";

/**
 * @module pipeline/analyzers/careGap
 * @description Care-gap / preventive-lab verification as a **multi-entity** analyzer.
 * It joins three canonical entities — active `problem`s × resulted `lab_result`s ×
 * `lab_order`s — so it registers with `requires: ["problem", "lab_result", "lab_order"]`.
 * The registry only runs it when all three are present in the dataset.
 */

const path = require("path");
const { register } = require("./registry");
const { careGaps } = require("../checks/careGap");

const CARE_GAPS = require(path.resolve(__dirname, "../../../config/clinical/care_gaps.json"));

module.exports = register({
  id: "care-gap",
  title: "Care-gap / preventive-lab",
  requires: ["problem", "lab_result", "lab_order"],
  run: (dataset, opts = {}) =>
    careGaps(
      { problems: dataset.problem, labResults: dataset.lab_result, labOrders: dataset.lab_order },
      { careGaps: opts.careGaps || CARE_GAPS }
    ).findings,
});
