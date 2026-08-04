"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateMigration } = require("./validate");

const rec = (id, over) => ({ values: {
  "lab_result.id": id, "lab_result.patient_id": "P1", "lab_result.component": "Sodium",
  "lab_result.loinc": "2951-2", "lab_result.value": 140, "lab_result.reference.low": 136,
  "lab_result.reference.high": 145, "lab_result.unit": "mmol/L", "lab_result.flag": "1", "lab_result.date": "2026-01-01",
  ...over,
} });

test("validateMigration: identical source and target → PASS", () => {
  const src = [rec("A"), rec("B")];
  const tgt = [rec("A"), rec("B")];
  const r = validateMigration(src, tgt);
  assert.equal(r.pass, true);
  assert.equal(r.completeness.completenessPct, 100);
  assert.equal(r.fidelity.fieldMismatches, 0);
});

test("validateMigration: catches dropped, added, and value-corrupted records with provenance", () => {
  const src = [rec("A"), rec("B"), rec("C")];
  const tgt = [rec("A"), rec("B", { "lab_result.value": 999 }), rec("D")]; // C dropped, D added, B corrupted
  const r = validateMigration(src, tgt);
  assert.equal(r.pass, false);
  assert.equal(r.completeness.dropped, 1); // C
  assert.equal(r.completeness.added, 1);   // D
  assert.equal(r.fidelity.fieldMismatches, 1); // B.value
  // dropped record ranks above a field mismatch (data loss is worst)
  assert.equal(r.findings[0].field, "__dropped__");
  assert.equal(r.findings[0].id, "C");
  const valueMismatch = r.findings.find((x) => x.field === "lab_result.value");
  assert.equal(valueMismatch.id, "B");
  assert.equal(valueMismatch.source, 140);
  assert.equal(valueMismatch.target, 999);
});

test("validateMigration: numeric equality is tolerant of float noise, strings exact", () => {
  const src = [rec("A", { "lab_result.value": 44.367 })];
  const tgt = [rec("A", { "lab_result.value": 44.367 })];
  assert.equal(validateMigration(src, tgt).pass, true);
});
