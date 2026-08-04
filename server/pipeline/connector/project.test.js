"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { project, unproject, coverage } = require("./project");
const { validateMigration } = require("../migration/validate");

const canonical = {
  "lab_result.id": "RES1",
  "lab_result.patient_id": "P1",
  "lab_result.encounter_id": "ENC1",
  "lab_result.loinc": "2951-2",
  "lab_result.component": "Sodium",
  "lab_result.date": "2026-01-01",
  "lab_result.value": 143.1,
  "lab_result.unit": "mEq/L",
  "lab_result.reference.low": 136,
  "lab_result.reference.high": 145,
  "lab_result.flag": "1",
  // canonical fields with no standard-Observation slot:
  "lab_result.order_id": "OP1",
  "lab_result.value_text": "143.1",
};

test("project builds a well-formed FHIR Observation", () => {
  const obs = project(canonical);
  assert.equal(obs.resourceType, "Observation");
  assert.equal(obs.code.coding[0].system, "http://loinc.org");
  assert.equal(obs.code.coding[0].code, "2951-2");
  assert.equal(obs.subject.reference, "Patient/P1");
  assert.equal(obs.valueQuantity.value, 143.1);
  assert.equal(obs.referenceRange[0].low.value, 136);
});

test("project → unproject round-trips the carried fields exactly", () => {
  const obs = project(canonical);
  const back = unproject(obs);
  const rep = validateMigration(
    [{ values: canonical }],
    [{ values: { ...back, "lab_result.id": canonical["lab_result.id"] } }],
    { keyField: "lab_result.id",
      fields: ["lab_result.patient_id", "lab_result.encounter_id", "lab_result.loinc",
        "lab_result.component", "lab_result.date", "lab_result.value", "lab_result.unit",
        "lab_result.reference.low", "lab_result.reference.high", "lab_result.flag"] }
  );
  assert.equal(rep.pass, true);
  assert.equal(rep.fidelity.fidelityPct, 100);
});

test("coverage names the canonical fields FHIR cannot carry", () => {
  const cov = coverage(canonical);
  assert.ok(cov.carried.includes("lab_result.value"));
  assert.ok(cov.unprojectable.includes("lab_result.order_id"));
  assert.ok(cov.unprojectable.includes("lab_result.value_text"));
});
