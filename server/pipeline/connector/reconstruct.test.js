"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { applyManifest } = require("./apply");
const { reconstruct, reconstructRecord } = require("./reconstruct");
const { validateMigration } = require("../migration/validate");

// A tiny source: one passthrough column (ID), one transformed column (VAL via
// to_number), and one column the manifest never maps (NOTE → remainder).
const records = [
  { recordIndex: 0, source: "t", values: { ID: "A", VAL: "5.0", NOTE: "keep-me" } },
  { recordIndex: 1, source: "t", values: { ID: "B", VAL: "143.1", NOTE: "" } },
];
const manifest = {
  entity: "lab_result", source: "t",
  fields: [
    { from: "ID", to: "lab_result.id" },
    { from: "VAL", to: "lab_result.value", transform: "to_number" },
  ],
};

test("apply captures the remainder and lineage", () => {
  const { records: envs, lineage } = applyManifest(records, manifest);
  assert.deepEqual(envs[0].remainder, { NOTE: "keep-me" }); // NOTE retained, not dropped
  assert.equal(envs[0].raw.VAL, "5.0");
  assert.equal(lineage.length, 2);
  assert.ok(lineage.find((r) => r.from === "VAL" && r.transform === "to_number"));
});

test("master reconstruct reproduces the source exactly (lossless)", () => {
  const { records: envs, lineage } = applyManifest(records, manifest);
  const back = reconstruct(envs, lineage, { interpretedOnly: false });

  // "5.0" → to_number 5 is a formatting loss the interpreted layer can't undo, so
  // the master falls back to the retained raw and still reproduces it exactly.
  const r0 = reconstructRecord(envs[0], lineage);
  assert.equal(r0.values.VAL, "5.0");
  assert.equal(r0.recovery.VAL, "raw_fallback");
  assert.equal(r0.recovery.NOTE, "remainder");
  assert.equal(r0.recovery.ID, "passthrough");

  // Field-by-field, the round trip is 100%.
  const original = records.map((r) => ({ values: r.values }));
  const keyField = "ID";
  const fields = ["VAL", "NOTE"];
  const rep = validateMigration(original, back.records, { keyField, fields });
  assert.equal(rep.pass, true);
  assert.equal(rep.fidelity.fidelityPct, 100);
});

test("interpreted-only reconstruct loses the remainder and the lossy field", () => {
  const { records: envs, lineage } = applyManifest(records, manifest);
  const lossy = reconstruct(envs, lineage, { interpretedOnly: true });

  assert.equal(lossy.recovery[0].NOTE, "lost");  // remainder dropped
  assert.equal(lossy.recovery[0].VAL, "lost");   // "5.0" cannot be regenerated from 5

  // The proof quantifies the loss vs the source.
  const original = records.map((r) => ({ values: r.values }));
  const rep = validateMigration(original, lossy.records, { keyField: "ID", fields: ["VAL", "NOTE"] });
  assert.equal(rep.pass, false);
  assert.ok(rep.fidelity.fieldMismatches >= 2);
});
