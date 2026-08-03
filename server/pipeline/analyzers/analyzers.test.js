"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const registry = require("./registry");
const stat = require("./statisticalDataQuality");
const abnormal = require("./abnormalResult");
const careGap = require("./careGap");
const tickets = require("../tickets");

const labRec = (id, v) => ({ source: "order_results.csv", values: {
  "lab_result.id": id, "lab_result.loinc": "2951-2", "lab_result.component": "Sodium",
  "lab_result.value": v, "lab_result.reference.low": 136, "lab_result.reference.high": 145, "lab_result.patient_id": "P" + id,
} });

test("registry: applicable/runAll dispatch by declared entity requirements", async () => {
  registry._clear();
  registry.register({ id: "a", requires: ["lab_result"], run: () => [{ checker: "a", kind: "k", queue: "data-quality", severity: "data-quality", facts: {}, provenance: {} }] });
  registry.register({ id: "b", requires: ["problem", "lab_result"], run: () => [] });
  registry.register({ id: "w", requires: "*", run: () => [] });

  assert.deepEqual(registry.applicable({ lab_result: [{}] }).map((a) => a.id).sort(), ["a", "w"]); // b needs problem too
  assert.deepEqual(registry.applicable({ problem: [{}], lab_result: [{}] }).map((a) => a.id).sort(), ["a", "b", "w"]);
  const f = await registry.runAll({ lab_result: [{}] });
  assert.equal(f.length, 1); // only 'a' produced a finding
});

test("registry: rejects an invalid analyzer", () => {
  assert.throws(() => registry.register({ id: "bad" }));
});

test("data-agnostic: unknown entities → clinical analyzers sit out, only the generic one runs", async () => {
  registry._clear();
  registry.register(abnormal);  // requires lab_result
  registry.register(careGap);   // requires problem + lab_result + lab_order
  registry.register(stat);      // requires "*"
  // a totally foreign dataset — no clinical canonical entities at all
  const foreign = [];
  for (let i = 0; i < 10; i++) foreign.push({ source: "ledger.csv", values: { "ledger.amount": 100 + i, "ledger.account_id": "A" + i } });
  foreign.push({ source: "ledger.csv", values: { "ledger.amount": 999999, "ledger.account_id": "AX" } });

  assert.deepEqual(registry.applicable({ ledger: foreign }).map((a) => a.id), ["statistical-data-quality"]);
  const findings = await registry.runAll({ ledger: foreign });
  assert.ok(findings.length > 0, "the generic analyzer still provides value on unknown data");
  assert.ok(findings.every((f) => f.checker === "statistical-data-quality"), "no clinical analyzer fired");
});

test("statistical analyzer (wildcard): flags an extreme outlier over the dataset", () => {
  const recs = [];
  for (let i = 0; i < 12; i++) recs.push({ source: "t", values: { "t.value": 100 + i, "t.patient_id": "P" + i } });
  recs.push({ source: "t", values: { "t.value": 99999, "t.patient_id": "POUT" } });
  const findings = stat.run({ t: recs });
  assert.ok(findings.some((f) => f.facts.value === 99999 && f.queue === "data-quality"));
});

test("abnormal analyzer: requires lab_result and triages the dataset's records", () => {
  assert.deepEqual(abnormal.requires, ["lab_result"]);
  const findings = abnormal.run({ lab_result: [labRec("1", 170), labRec("2", 140)] });
  assert.ok(findings.some((f) => f.checker === "abnormal-result-triage"));
});

test("care-gap analyzer: multi-entity — runs only when all three entities are present", () => {
  assert.deepEqual(careGap.requires, ["problem", "lab_result", "lab_order"]);
  registry._clear();
  registry.register(careGap);
  assert.equal(registry.applicable({ lab_result: [{}] }).length, 0);
  assert.equal(registry.applicable({ problem: [{}], lab_result: [{}], lab_order: [{}] }).length, 1);
});

test("swappable app layer: union of analyzers over lab_result → tickets", async () => {
  registry._clear();
  registry.register(abnormal);
  registry.register(stat);
  const records = [];
  for (let i = 0; i < 12; i++) records.push(labRec("N" + i, 140 + i));
  records.push(labRec("OUT", 99999));
  const findings = await registry.runAll({ lab_result: records });
  const list = tickets.assemble(findings, {});
  assert.ok(list.some((t) => t.checker === "abnormal-result-triage"));
  assert.ok(list.some((t) => t.checker === "statistical-data-quality"), "generic analyzer's tickets present");
});
