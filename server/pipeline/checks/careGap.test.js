"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { careGaps, matchRule } = require("./careGap");
const ticketsMod = require("../tickets");

const CONFIG = {
  E11: { condition: "Type 2 Diabetes", cadenceMonths: 12, expect: [{ loinc: "4548-4", test: "HbA1c" }], url: "https://ex.org/dm" },
  E78: { condition: "Hyperlipidemia", cadenceMonths: 12, expect: [{ loinc: "13457-7", test: "LDL Cholesterol" }], url: "https://ex.org/lipid" },
};

const problem = (o) => ({ values: { "problem.patient_id": "P1", "problem.icd10": "E11.9", "problem.status": "Active", "problem.id": "PL1", ...o } });
const result = (o) => ({ values: { "lab_result.patient_id": "P1", "lab_result.loinc": "4548-4", ...o } });
const order = (o) => ({ values: { "lab_order.patient_id": "P1", "lab_order.code": "4548-4", "lab_order.result_value": null, ...o } });

test("matchRule: longest ICD-10 prefix wins; unknown → null", () => {
  assert.equal(matchRule("E11.51", CONFIG).condition, "Type 2 Diabetes");
  assert.equal(matchRule("E78.00", CONFIG).condition, "Hyperlipidemia");
  assert.equal(matchRule("K21.9", CONFIG), null);
});

test("careGaps: expected test never ordered → never-ordered gap", () => {
  const { findings, stats } = careGaps({ problems: [problem()], labResults: [], labOrders: [] }, { careGaps: CONFIG });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "never-ordered");
  assert.equal(findings[0].facts.expectedTest, "HbA1c");
  assert.equal(stats.neverOrdered, 1);
});

test("careGaps: ordered but no result value → ordered-not-resulted gap (loop open)", () => {
  const { findings } = careGaps({ problems: [problem()], labResults: [], labOrders: [order({ "lab_order.result_value": null })] }, { careGaps: CONFIG });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "ordered-not-resulted");
});

test("careGaps: resulted test → no gap (loop closed)", () => {
  const { findings, stats } = careGaps({ problems: [problem()], labResults: [result()], labOrders: [] }, { careGaps: CONFIG });
  assert.equal(findings.length, 0);
  assert.equal(stats.closed, 1);
});

test("careGaps: inactive problem is skipped", () => {
  const { findings } = careGaps({ problems: [problem({ "problem.status": "Resolved" })], labResults: [], labOrders: [] }, { careGaps: CONFIG });
  assert.equal(findings.length, 0);
});

test("careGaps: condition with no governed rule is skipped", () => {
  const { findings } = careGaps({ problems: [problem({ "problem.icd10": "K21.9" })], labResults: [], labOrders: [] }, { careGaps: CONFIG });
  assert.equal(findings.length, 0);
});

test("careGaps: a resulted order value counts as closed even if an order row exists", () => {
  const { findings } = careGaps(
    { problems: [problem()], labResults: [result()], labOrders: [order({ "lab_order.result_value": 5.5 })] },
    { careGaps: CONFIG }
  );
  assert.equal(findings.length, 0);
});

test("tickets: care-gap findings assemble into care-gap queue tickets", () => {
  const { findings } = careGaps({ problems: [problem()], labResults: [], labOrders: [] }, { careGaps: CONFIG });
  const list = ticketsMod.assemble({ careGaps: findings }, { patients: { P1: { name: "Jane Doe", age: 60, sex: "Female" } } });
  assert.equal(list.length, 1);
  assert.equal(list[0].queue, "care-gap");
  assert.equal(list[0].checker, "care-gap");
  assert.equal(list[0].id.startsWith("CG-"), true);
  assert.equal(list[0].patient.name, "Jane Doe");
});

test("tickets: abnormal + care-gap findings coexist and sort by queue", () => {
  const { findings } = careGaps({ problems: [problem()], labResults: [], labOrders: [] }, { careGaps: CONFIG });
  const abnormal = {
    clinical: [{ checker: "abnormal-result-triage", kind: "abnormal-result", patientId: "P1", severity: "critical", queue: "clinical-urgent", slaHours: 4, facts: { component: "Sodium", outOfRangeBy: 30 }, provenance: { result_id: "R1" } }],
    dataQuality: [],
    careGaps: findings,
  };
  const list = ticketsMod.assemble(abnormal);
  assert.equal(list[0].severity, "critical"); // clinical sorts before care-gap
  assert.ok(list.some((t) => t.queue === "care-gap"));
  const s = ticketsMod.summarize(list);
  assert.equal(s.byQueue["care-gap"], 1);
  assert.equal(s.byQueue["clinical-urgent"], 1);
});
