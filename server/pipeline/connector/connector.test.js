"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const t = require("./transforms");
const { validateManifest } = require("./validate");
const { applyManifest } = require("./apply");
const { induceManifest } = require("./induce");
const { connectRecords, loadWithRepair } = require("./index");
const ingestMod = require("../ingest");
const { verifyMapping, collectFailures } = require("./verify");
const canonical = require("./canonical");

// ---------------------------------------------------------------- transforms

test("transforms: split_bp parses systolic/diastolic and rejects junk", () => {
  assert.deepEqual(t.split_bp("150/99"), [150, 99]);
  assert.deepEqual(t.split_bp(" 120 / 80 "), [120, 80]);
  assert.deepEqual(t.split_bp("abc"), [null, null]);
  assert.deepEqual(t.split_bp(""), [null, null]);
});

test("transforms: parse_reference_range handles ranges and one-sided bounds", () => {
  assert.deepEqual(t.parse_reference_range("136-145"), [136, 145]);
  assert.deepEqual(t.parse_reference_range("0.6-1.2"), [0.6, 1.2]);
  assert.deepEqual(t.parse_reference_range("<=100"), [null, 100]);
  assert.deepEqual(t.parse_reference_range(">40"), [40, null]);
});

test("transforms: to_number / to_date are null-safe and non-destructive", () => {
  assert.equal(t.to_number("42.46"), 42.46);
  assert.equal(t.to_number("N/A"), null); // already sentinel-nulled upstream, but safe
  assert.equal(t.to_date("2026-05-09 14:31:00"), "2026-05-09");
  assert.equal(t.to_date("2017"), "2017"); // bare year kept, not invented
});

// ---------------------------------------------------------------- validation

test("validate: accepts a well-formed manifest", () => {
  const m = {
    source: "patient.csv",
    entity: "patient",
    fields: [
      { from: "patient.PAT_ID", to: "patient.id" },
      { from: "patient.PAT_AGE", to: "patient.age", transform: "to_number" },
    ],
  };
  const v = validateManifest(m);
  assert.equal(v.valid, true, v.errors.join("; "));
  assert.deepEqual(v.mapped.sort(), ["patient.age", "patient.id"]);
});

test("validate: rejects an invented canonical path", () => {
  const v = validateManifest({
    source: "x.csv",
    fields: [{ from: "x.A", to: "patient.favorite_color" }],
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("favorite_color")));
});

test("validate: rejects an invented transform", () => {
  const v = validateManifest({
    source: "x.csv",
    fields: [{ from: "x.A", to: "patient.age", transform: "sudo_make_number" }],
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("sudo_make_number")));
});

test("validate: multi-emit arity and shape are enforced", () => {
  const bad = validateManifest({
    source: "v.csv",
    fields: [{ from: "v.BP", emits: ["vital.bp.systolic"], transform: "split_bp" }],
  });
  assert.equal(bad.valid, false); // split_bp emits 2, only 1 path given

  const good = validateManifest({
    source: "v.csv",
    fields: [{ from: "v.BP", emits: ["vital.bp.systolic", "vital.bp.diastolic"], transform: "split_bp" }],
  });
  assert.equal(good.valid, true, good.errors.join("; "));

  const misuse = validateManifest({
    source: "v.csv",
    fields: [{ from: "v.BP", to: "vital.value", transform: "split_bp" }],
  });
  assert.equal(misuse.valid, false); // multi transform used with "to"
});

// ---------------------------------------------------------------- apply

test("apply: runs transforms and splits BP into two canonical paths", () => {
  const manifest = {
    source: "vitals.csv",
    entity: "vital",
    fields: [
      { from: "vitals.FLO_MEAS_NAME", to: "vital.name", transform: "trim" },
      { from: "vitals.MEAS_VALUE", to: "vital.value_text" },
      { from: "vitals.MEAS_VALUE", emits: ["vital.bp.systolic", "vital.bp.diastolic"], transform: "split_bp" },
    ],
  };
  const records = [
    { recordIndex: 0, source: "vitals.csv", values: { "vitals.FLO_MEAS_NAME": "BLOOD PRESSURE", "vitals.MEAS_VALUE": "150/99" } },
  ];
  const { records: out } = applyManifest(records, manifest);
  assert.equal(out[0].values["vital.bp.systolic"], 150);
  assert.equal(out[0].values["vital.bp.diastolic"], 99);
  assert.equal(out[0].values["vital.value_text"], "150/99");
});

test("apply: resolves bare column names against namespaced ingest keys", () => {
  // Model emitted bare "PAT_ID"; ingest key is "patient.PAT_ID".
  const manifest = {
    source: "patient.csv", entity: "patient",
    fields: [{ from: "PAT_ID", to: "patient.id" }],
  };
  const records = [{ recordIndex: 0, source: "patient.csv", values: { "patient.PAT_ID": "P200001" } }];
  const { records: out, anomalies } = applyManifest(records, manifest);
  assert.equal(out[0].values["patient.id"], "P200001");
  assert.equal(anomalies.length, 0);
});

test("apply: resolves a nested JSON path via dotted-suffix match", () => {
  // JSON ingest produces "labs.obs.id"; the model cites the nested "obs.id".
  const manifest = { source: "labs.json", entity: "lab_result", fields: [{ from: "obs.id", to: "lab_result.id" }] };
  const records = [{ recordIndex: 0, source: "labs.json", values: { "labs.obs.id": "R1", "labs.order.id": "O1" } }];
  const { records: out, anomalies } = applyManifest(records, manifest);
  assert.equal(out[0].values["lab_result.id"], "R1"); // matched obs.id, not order.id
  assert.equal(anomalies.length, 0);
});

test("apply: a truly missing source column is flagged, not silently nulled", () => {
  const manifest = {
    source: "patient.csv", entity: "patient",
    fields: [{ from: "DOES_NOT_EXIST", to: "patient.id" }],
  };
  const records = [{ recordIndex: 0, source: "patient.csv", values: { "patient.PAT_ID": "P1" } }];
  const { anomalies } = applyManifest(records, manifest);
  assert.ok(anomalies.some((a) => a.kind === "unresolved_source"));
});

test("apply: unparseable transform input is nulled and recorded as an anomaly", () => {
  const manifest = {
    source: "labs.csv", entity: "lab_result",
    fields: [{ from: "labs.VAL", to: "lab_result.value", transform: "to_number" }],
  };
  const records = [{ recordIndex: 0, source: "labs.csv", values: { "labs.VAL": "pending" } }];
  const { records: out, anomalies } = applyManifest(records, manifest);
  assert.equal(out[0].values["lab_result.value"], null);
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].kind, "transform_unparsed");
});

// ---------------------------------------------------------------- induce (stubbed LLM, offline)

test("induce: uses injected runLLM and returns the parsed manifest", async () => {
  const fakeManifest = {
    source: "patient.csv", entity: "patient",
    fields: [{ from: "patient.PAT_ID", to: "patient.id" }],
  };
  // Stub returns a Response-like envelope with fenced JSON, like a real model might.
  const runLLM = async (config, prompt) => {
    assert.ok(config.system.includes("canonical"), "system prompt present");
    assert.ok(prompt.includes("patient.PAT_ID"), "sample columns present in prompt");
    return { output: { text: "```json\n" + JSON.stringify(fakeManifest) + "\n```" } };
  };
  const parse = require("../../../llms/src/utilities/parseResponseJson");
  const { manifest } = await induceManifest(
    { source: "patient.csv", header: ["PAT_ID"], records: [{ values: { "patient.PAT_ID": "P1" } }] },
    { runLLM, parse, config: {} }
  );
  assert.equal(manifest.entity, "patient");
  assert.equal(manifest.fields[0].to, "patient.id");
});

test("connectRecords: end-to-end with stubbed induction, no cache write", async () => {
  const ingested = {
    source: "patient.csv",
    header: ["PAT_ID", "PAT_AGE"],
    records: [{ recordIndex: 0, source: "patient.csv", values: { "patient.PAT_ID": "P200001", "patient.PAT_AGE": "44" } }],
    anomalies: [],
    meta: {},
  };
  const runLLM = async () => ({
    output: {
      text: JSON.stringify({
        source: "patient.csv", entity: "patient",
        fields: [
          { from: "patient.PAT_ID", to: "patient.id" },
          { from: "patient.PAT_AGE", to: "patient.age", transform: "to_number" },
        ],
      }),
    },
  });
  const parse = require("../../../llms/src/utilities/parseResponseJson");
  const result = await connectRecords(ingested, { runLLM, parse, config: {}, write: false, forceInduce: true });
  assert.equal(result.validation.valid, true, result.validation.errors.join("; "));
  assert.equal(result.canonical.records[0].values["patient.id"], "P200001");
  assert.equal(result.canonical.records[0].values["patient.age"], 44); // number, not "44"
});

// ------------------------------------------------ reversibility contracts (property tests)

test("transforms: every contract's check holds for its example inputs (property)", () => {
  for (const [name, c] of Object.entries(t.CONTRACTS)) {
    const fn = t.REGISTRY[name];
    for (const ex of c.examples) {
      const out = fn(ex);
      assert.ok(
        c.check(ex, out),
        `${name}(${JSON.stringify(ex)}) → ${JSON.stringify(out)} failed its own contract check`
      );
    }
  }
});

test("transforms: reversible transforms round-trip via inverse (property)", () => {
  for (const [name, c] of Object.entries(t.CONTRACTS)) {
    if (c.rev !== "reversible") continue;
    const fn = t.REGISTRY[name];
    for (const ex of c.examples) {
      const out = fn(ex);
      const allNull = Array.isArray(out) ? out.every((x) => x == null) : out == null;
      if (allNull) continue;
      const recon = c.inverse(out);
      assert.ok(t.eqNorm(recon, ex), `${name}: inverse(${JSON.stringify(out)})=${JSON.stringify(recon)} != ${JSON.stringify(ex)}`);
    }
  }
});

// ------------------------------------------------ verifier

test("verify: a clean mapping passes coverage, round-trip and types", () => {
  const ingested = { header: ["A", "AGE"], records: [{ values: { "t.A": "P1", "t.AGE": "44" } }] };
  const manifest = { source: "t.csv", entity: "patient", fields: [
    { from: "t.A", to: "patient.id" },
    { from: "t.AGE", to: "patient.age", transform: "to_number" },
  ] };
  const applied = [{ values: { "patient.id": "P1", "patient.age": 44 } }];
  const r = verifyMapping(ingested, manifest, applied);
  assert.equal(r.pass, true);
  assert.equal(r.summary.coverageComplete, true);
  assert.equal(r.summary.roundTripClean, true);
});

test("verify: detects a corrupted (non-lossless) value", () => {
  const ingested = { header: ["AGE"], records: [{ values: { "t.AGE": "44" } }] };
  const manifest = { source: "t.csv", fields: [{ from: "t.AGE", to: "patient.age", transform: "to_number" }] };
  const applied = [{ values: { "patient.age": 999 } }]; // not what to_number("44") yields
  const r = verifyMapping(ingested, manifest, applied);
  assert.equal(r.pass, false);
  assert.ok(r.summary.lossFields.includes("t.AGE"));
});

test("verify: flags a type-implausible value", () => {
  const ingested = { header: ["DOB"], records: [{ values: { "t.DOB": "1981-08-04" } }] };
  const manifest = { source: "t.csv", fields: [{ from: "t.DOB", to: "patient.birth_date", transform: "to_date" }] };
  const applied = [{ values: { "patient.birth_date": "not-a-date" } }];
  const r = verifyMapping(ingested, manifest, applied);
  assert.equal(r.summary.typesPlausible, false);
});

test("verify: coverage flags a silently unaccounted column", () => {
  const ingested = { header: ["A", "EXTRA"], records: [{ values: { "t.A": "1", "t.EXTRA": "z" } }] };
  const manifest = { source: "t.csv", fields: [{ from: "t.A", to: "patient.id" }] };
  const applied = [{ values: { "patient.id": "1" } }];
  const r = verifyMapping(ingested, manifest, applied);
  assert.equal(r.summary.coverageComplete, false);
  assert.ok(r.coverage.unaccounted.includes("t.EXTRA"));
});

test("verify: BP split round-trips losslessly", () => {
  const ingested = { header: ["BP"], records: [{ values: { "v.BP": "150/99" } }] };
  const manifest = { source: "v.csv", fields: [
    { from: "v.BP", emits: ["vital.bp.systolic", "vital.bp.diastolic"], transform: "split_bp" },
  ] };
  const applied = [{ values: { "vital.bp.systolic": 150, "vital.bp.diastolic": 99 } }];
  const r = verifyMapping(ingested, manifest, applied);
  assert.equal(r.summary.roundTripClean, true);
});

// ------------------------------------------------ loadWithRepair (targeted repair loop)

test("collectFailures: extracts failing fields with reasons from a verification report", () => {
  const verification = { fields: [
    { from: "x.A", to: "lab_result.value", transform: null, roundTripOk: true, typeOk: false, typeViolations: [{ path: "lab_result.value", value: "Sodium", expected: "number" }] },
    { from: "x.B", to: "lab_result.component", roundTripOk: true, typeOk: true },
  ] };
  const failures = collectFailures(verification, [{ kind: "unresolved_source", from: "x.C" }]);
  assert.deepEqual(failures.map((f) => f.from).sort(), ["x.A", "x.C"]);
});

test("loadWithRepair: a bad induced manifest is repaired by feeding failures back (not re-rolled)", async () => {
  const csv = "RESULT_ID,COMPONENT,VALUE,LOW,HIGH\nR1,Sodium,170,136,145\nR2,Sodium,142,136,145\n";
  const ingested = ingestMod.ingestText(csv, { source: "repairme.csv" });

  const BAD = { source: "repairme.csv", entity: "lab_result", fields: [
    { from: "RESULT_ID", to: "lab_result.id" },
    { from: "COMPONENT", to: "lab_result.value" }, // WRONG: a string mapped into a numeric field → type violation
    { from: "VALUE", to: "lab_result.component" },
  ] };
  const GOOD = { source: "repairme.csv", entity: "lab_result", fields: [
    { from: "RESULT_ID", to: "lab_result.id" },
    { from: "COMPONENT", to: "lab_result.component" },
    { from: "VALUE", to: "lab_result.value", transform: "to_number" },
    { from: "LOW", to: "lab_result.reference.low", transform: "to_number" },
    { from: "HIGH", to: "lab_result.reference.high", transform: "to_number" },
  ] };

  let calls = 0;
  const runLLM = async (config, prompt) => {
    calls++;
    const repairMode = /REPAIR MODE/.test(prompt);
    // On repair, the prompt must name the specific failing field.
    if (repairMode) assert.ok(prompt.includes("COMPONENT"), "repair prompt cites the failing field");
    return { output: { text: JSON.stringify(repairMode ? GOOD : BAD) } };
  };
  const parse = require("../../../llms/src/utilities/parseResponseJson");

  const r = await loadWithRepair(ingested, { forceInduce: true, write: false, runLLM, parse, config: {} });
  assert.equal(calls, 2, "one initial induction + one targeted repair");
  assert.equal(r.repair.attempts, 1);
  assert.equal(r.repair.repaired, true);
  assert.equal(r.verification.pass, true);
  assert.ok(r.repair.log[0].fields.includes("COMPONENT"));
  assert.equal(r.canonical.records[0].values["lab_result.value"], 170); // corrected mapping applied
});

test("loadWithRepair: a SUPPLIED manifest is applied verbatim and never repaired", async () => {
  const csv = "RESULT_ID,VALUE\nR1,170\n";
  const ingested = ingestMod.ingestText(csv, { source: "supplied.csv" });
  const manifest = { source: "supplied.csv", entity: "lab_result", fields: [{ from: "RESULT_ID", to: "lab_result.id" }, { from: "VALUE", to: "lab_result.value", transform: "to_number" }] };
  const runLLM = async () => { throw new Error("must not induce when a manifest is supplied"); };
  const r = await loadWithRepair(ingested, { manifest, write: false, runLLM, config: {} });
  assert.equal(r.repair.attempts, 0);
  assert.equal(r.llmUsed, false);
  assert.equal(r.canonical.records[0].values["lab_result.value"], 170);
});

test("canonical: every declared path has a type", () => {
  for (const [p, spec] of Object.entries(canonical.PATHS)) {
    assert.ok(["string", "number", "date", "boolean"].includes(spec.type), `${p} type`);
  }
});
