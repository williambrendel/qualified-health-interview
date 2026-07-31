"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { triage } = require("./abnormalResult");
const severity = require("./severity");
const ticketsMod = require("../tickets");

const ANALYTES = {
  "2951-2": { name: "Sodium", unit: "mmol/L", critical: { low: 120, high: 160 }, plausible: { low: 90, high: 180 } },
  "13457-7": { name: "LDL Cholesterol", unit: "mg/dL", critical: { high: 190 }, plausible: { low: 0, high: 500 } },
};

function labRecord(over) {
  return {
    source: "order_results.csv",
    values: {
      "lab_result.id": "RES1", "lab_result.order_id": "OP1",
      "lab_result.patient_id": "P1", "lab_result.encounter_id": "E1",
      "lab_result.loinc": "2951-2", "lab_result.component": "Sodium", "lab_result.unit": "mmol/L",
      "lab_result.value": 140, "lab_result.reference.low": 136, "lab_result.reference.high": 145,
      "lab_result.date": "2026-05-09",
      ...over,
    },
  };
}

test("triage: an in-range value produces no finding", () => {
  const r = triage([labRecord({ "lab_result.value": 140 })], { analytes: ANALYTES });
  assert.equal(r.clinical.length, 0);
  assert.equal(r.dataQuality.length, 0);
});

test("triage: a modestly-high value is a non-critical clinical finding", () => {
  const r = triage([labRecord({ "lab_result.value": 148, "lab_result.id": "RESx" })], { analytes: ANALYTES });
  assert.equal(r.clinical.length, 1);
  assert.equal(r.clinical[0].facts.direction, "high");
  assert.notEqual(r.clinical[0].severity, "critical");
  assert.equal(r.clinical[0].queue, "clinical-routine");
});

test("triage: beyond the critical threshold is critical + urgent queue", () => {
  const r = triage([labRecord({ "lab_result.value": 170 })], { analytes: ANALYTES }); // >160 critical, <180 plausible
  assert.equal(r.clinical.length, 1);
  assert.equal(r.clinical[0].severity, "critical");
  assert.equal(r.clinical[0].queue, "clinical-urgent");
  assert.equal(r.clinical[0].slaHours, 4);
  assert.equal(r.clinical[0].facts.beyondCritical, true);
});

test("triage: an IMPOSSIBLE value is diverted to data-quality, NOT the clinical queue", () => {
  const r = triage([labRecord({ "lab_result.value": 208 })], { analytes: ANALYTES }); // >180 plausible
  assert.equal(r.clinical.length, 0, "must not enter the clinical queue");
  assert.equal(r.dataQuality.length, 1);
  assert.equal(r.dataQuality[0].kind, "implausible-value");
});

test("triage: numeric coercion — non-numeric value is skipped", () => {
  const r = triage([labRecord({ "lab_result.value": null })], { analytes: ANALYTES });
  assert.equal(r.skipped, 1);
  assert.equal(r.clinical.length, 0);
});

test("triage: findings are ranked critical-first", () => {
  const recs = [
    labRecord({ "lab_result.value": 148, "lab_result.id": "A" }), // mild/moderate
    labRecord({ "lab_result.value": 175, "lab_result.id": "B" }), // critical
  ];
  const r = triage(recs, { analytes: ANALYTES });
  assert.equal(r.clinical[0].severity, "critical");
});

// ---- data-agnostic: the checker runs with NO analyte config at all ----

test("triage (agnostic): detects abnormal from the result's own reference range with NO config", () => {
  const r = triage([labRecord({ "lab_result.value": 148 })], {}); // no analytes at all
  assert.equal(r.clinical.length, 1);
  assert.equal(r.clinical[0].facts.direction, "high");
  assert.equal(r.clinical[0].severity !== "critical", true); // no critical config → distance-based
});

test("triage (agnostic): generic plausibility gate fires from reference range alone", () => {
  // ref 136-145 (range 9); 208 is >5x the range above high → implausible without any config
  const r = triage([labRecord({ "lab_result.value": 208 })], {});
  assert.equal(r.clinical.length, 0, "impossible value must not reach the clinical queue");
  assert.equal(r.dataQuality.length, 1);
  assert.equal(r.dataQuality[0].facts.plausibilityBasis, "reference-derived");
});

test("triage (agnostic): a novel analyte the config never mentions still triages", () => {
  const novel = labRecord({
    "lab_result.loinc": "99999-9", "lab_result.component": "Novel Marker",
    "lab_result.value": 300, "lab_result.reference.low": 10, "lab_result.reference.high": 20,
  });
  const r = triage([novel], { analytes: {} });
  // 300 vs ref 10-20 (range 10): 300 > 20 + 5*10 = 70 → implausible via generic bound
  assert.equal(r.dataQuality.length, 1);
  const inRange = triage([{ ...novel, values: { ...novel.values, "lab_result.value": 25 } }], {});
  assert.equal(inRange.clinical.length, 1); // 25 vs 10-20 → high, clinical (no config needed)
});

test("triage (agnostic): sign violation caught when reference implies non-negative", () => {
  const r = triage([labRecord({ "lab_result.value": -5, "lab_result.reference.low": 0, "lab_result.reference.high": 100 })], {});
  assert.equal(r.dataQuality.length, 1);
});

test("severity: routing maps tiers to queues and SLAs", () => {
  assert.deepEqual(severity.route("critical"), { queue: "clinical-urgent", slaHours: 4 });
  assert.equal(severity.rank("critical") < severity.rank("mild"), true);
});

test("tickets: assemble builds stable ids, dedups, and enriches patient", () => {
  const findings = triage([labRecord({ "lab_result.value": 170 })], { analytes: ANALYTES });
  const list = ticketsMod.assemble(findings, { patients: { P1: { name: "Jane Doe", age: 60, sex: "Female" } } });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "AR-RES1");
  assert.equal(list[0].patient.name, "Jane Doe");
  assert.equal(list[0].hypothesis, null); // reserved for the advisory layer
  assert.equal(list[0].queue, "clinical-urgent");
});

test("tickets: data-quality tickets route to the data-quality queue", () => {
  const findings = triage([labRecord({ "lab_result.value": 208 })], { analytes: ANALYTES });
  const list = ticketsMod.assemble(findings);
  assert.equal(list[0].queue, "data-quality");
  assert.equal(list[0].id.startsWith("DQ-"), true);
});

test("tickets: summarize counts by queue and severity", () => {
  const findings = triage([
    labRecord({ "lab_result.value": 170, "lab_result.id": "c1" }),
    labRecord({ "lab_result.value": 208, "lab_result.id": "d1" }),
  ], { analytes: ANALYTES });
  const list = ticketsMod.assemble(findings);
  const s = ticketsMod.summarize(list);
  assert.equal(s.total, 2);
  assert.equal(s.byQueue["clinical-urgent"], 1);
  assert.equal(s.byQueue["data-quality"], 1);
});
