"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const registry = require("./registry");
const stat = require("./statisticalDataQuality"); // self-registers; also exported
const abnormal = require("./abnormalResult");
const tickets = require("../tickets");

test("registry: register + analyzersFor filters by entity", () => {
  registry._clear();
  registry.register({ id: "a", title: "A", appliesTo: (e) => e === "x", run: () => [] });
  registry.register({ id: "b", title: "B", appliesTo: () => true, run: () => [] });
  assert.deepEqual(registry.analyzersFor("x").map((a) => a.id).sort(), ["a", "b"]);
  assert.deepEqual(registry.analyzersFor("y").map((a) => a.id), ["b"]);
  assert.equal(registry.list().length, 2);
});

test("registry: rejects an invalid analyzer", () => {
  assert.throws(() => registry.register({ id: "bad" }));
});

test("statistical analyzer (generic): flags an extreme outlier on any numeric field", () => {
  const records = [];
  for (let i = 0; i < 12; i++) records.push({ source: "t.csv", values: { "t.value": 100 + i, "t.patient_id": "P" + i } });
  records.push({ source: "t.csv", values: { "t.value": 99999, "t.patient_id": "POUT" } });
  const findings = stat.run(records);
  assert.ok(findings.some((f) => f.facts.value === 99999 && f.facts.field === "t.value"));
  assert.equal(findings.every((f) => f.queue === "data-quality"), true);
});

test("statistical analyzer: ignores fields with too few samples", () => {
  const records = [{ source: "t", values: { "t.value": 1 } }, { source: "t", values: { "t.value": 9999 } }];
  assert.equal(stat.run(records).length, 0);
});

test("abnormal analyzer: applies only to lab_result and returns flat findings", () => {
  assert.equal(abnormal.appliesTo("lab_result"), true);
  assert.equal(abnormal.appliesTo("patient"), false);
  const rec = (v) => ({ source: "order_results.csv", values: { "lab_result.id": "R" + v, "lab_result.loinc": "2951-2", "lab_result.component": "Sodium", "lab_result.value": v, "lab_result.reference.low": 136, "lab_result.reference.high": 145 } });
  const findings = abnormal.run([rec(170), rec(140)]);
  assert.ok(Array.isArray(findings) && findings.some((f) => f.checker === "abnormal-result-triage"));
});

test("swappable app layer: two analyzers over the same canonical records union into tickets", () => {
  const rec = (id, v) => ({ source: "order_results.csv", values: { "lab_result.id": id, "lab_result.loinc": "2951-2", "lab_result.component": "Sodium", "lab_result.value": v, "lab_result.reference.low": 136, "lab_result.reference.high": 145, "lab_result.patient_id": "P" + id } });
  const records = [];
  for (let i = 0; i < 12; i++) records.push(rec("N" + i, 140 + i));
  records.push(rec("OUT", 99999));
  // What /analyze does: run every applicable analyzer, union findings.
  const findings = [...abnormal.run(records), ...stat.run(records)];
  const list = tickets.assemble(findings, {});
  assert.ok(list.length > 0);
  assert.ok(list.some((t) => t.checker === "abnormal-result-triage"));
  assert.ok(list.some((t) => t.checker === "statistical-data-quality"), "the generic analyzer's tickets are present");
});
