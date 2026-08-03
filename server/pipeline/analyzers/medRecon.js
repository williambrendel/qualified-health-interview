"use strict";

/**
 * @module pipeline/analyzers/medRecon
 * @description Medication reconciliation as a **multi-entity** analyzer joining
 * `note` × `medication_order`. Registers with `requires: ["note", "medication_order"]`;
 * the registry runs it only when both are present. Async (the LLM extracts meds from
 * the notes) — the registry awaits it.
 */

const { register } = require("./registry");
const { medRecon } = require("../checks/medRecon");

module.exports = register({
  id: "med-recon",
  title: "Medication reconciliation",
  requires: ["note", "medication_order"],
  run: async (dataset, opts = {}) => {
    const r = await medRecon({ notes: dataset.note, medOrders: dataset.medication_order }, opts);
    return r.findings;
  },
});
