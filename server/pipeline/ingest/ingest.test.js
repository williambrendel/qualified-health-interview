"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const csv = require("./csv");
const { sniff } = require("./sniff");
const { repair } = require("./structural");
const { ingestText, ingestFile } = require("./index");

const DATA_DIR = path.resolve(__dirname, "../../../data/interview");

test("csv: simple rows", () => {
  const rows = csv.parse("a,b,c\n1,2,3\n");
  assert.deepEqual(rows, [["a", "b", "c"], ["1", "2", "3"]]);
});

test("csv: quoted field containing the delimiter", () => {
  const rows = csv.parse('name,note\nErickson,"Hypertension, Unspecified"\n');
  assert.deepEqual(rows[1], ["Erickson", "Hypertension, Unspecified"]);
});

test("csv: quoted field spanning multiple physical lines", () => {
  const text = 'id,note\n1,"line one\nline two\nline three"\n2,ok\n';
  const rows = csv.parse(text);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], "line one\nline two\nline three");
  assert.deepEqual(rows[2], ["2", "ok"]);
});

test("csv: escaped quotes inside a quoted field", () => {
  const rows = csv.parse('id,q\n1,"she said ""hi"" today"\n');
  assert.equal(rows[1][1], 'she said "hi" today');
});

test("csv: CRLF line endings", () => {
  const rows = csv.parse("a,b\r\n1,2\r\n");
  assert.deepEqual(rows, [["a", "b"], ["1", "2"]]);
});

test("sniff: detects comma delimiter and header", () => {
  const s = sniff("PAT_ID,PAT_NAME\nP1,Alice\nP2,Bob\n");
  assert.equal(s.delimiter, ",");
  assert.equal(s.hasHeader, true);
});

test("sniff: detects pipe delimiter over commas in free text", () => {
  const s = sniff("a|b|c\nHypertension, Unspec|x|y\nAnxiety, GAD|p|q\n");
  assert.equal(s.delimiter, "|");
});

test("structural: short ragged rows are padded and flagged", () => {
  const { rows, anomalies } = repair(["a", "b", "c"], [["1", "2"], ["3", "4", "5"]]);
  assert.deepEqual(rows[0], ["1", "2", null]);
  assert.equal(anomalies.filter((x) => x.kind === "ragged_short").length, 1);
});

test("structural: spanning/merged cell forward-fill (opt-in) with audit", () => {
  // A value written once, then left blank in the rows it 'spans' below.
  const header = ["patient", "line", "code"];
  const body = [
    ["P1", "1", "I11.9"],
    ["", "2", "E78.5"], // patient spans down from P1
    ["", "3", "F41.1"],
  ];
  const { rows, anomalies } = repair(header, body, { fillSpanning: [0] });
  assert.equal(rows[1][0], "P1");
  assert.equal(rows[2][0], "P1");
  assert.equal(anomalies.filter((x) => x.kind === "spanning_fill").length, 2);
});

test("structural: spanning fill is OFF by default (no silent inference)", () => {
  const { rows } = repair(["patient", "x"], [["P1", "a"], ["", "b"]]);
  assert.equal(rows[1][0], null);
});

test("flatten: canonical path→value with text sentinel → null", () => {
  const { records } = ingestText("PAT_ID,MIDDLE\nP1,N/A\n", { source: "patient.csv" });
  assert.equal(records[0].values["patient.PAT_ID"], "P1");
  assert.equal(records[0].values["patient.MIDDLE"], null);
  assert.deepEqual(records[0].sentinels, ["patient.MIDDLE"]);
});

// --- JSON ingest: nested objects flatten to the same path→value shape ---

test("json: an array of nested objects flattens to dotted path→value records", () => {
  const text = JSON.stringify([
    { obs: { id: "R1", loinc: "2951-2" }, measurement: { value: 170 }, reference: { low: 136, high: 145 } },
    { obs: { id: "R2", loinc: "2823-3" }, measurement: { value: 4.2 }, reference: { low: 3.5, high: 5 } },
  ]);
  const { records, meta } = ingestText(text, { source: "labs.json" });
  assert.equal(meta.format, "json");
  assert.equal(records.length, 2);
  assert.equal(records[0].values["labs.obs.id"], "R1");
  assert.equal(records[0].values["labs.measurement.value"], 170); // number preserved
  assert.equal(records[0].values["labs.reference.high"], 145);
});

test("json: detected from a leading '[' even without a .json name", () => {
  const { meta } = ingestText('[{"a":1}]', { source: "mystery" });
  assert.equal(meta.format, "json");
});

test("json: a wrapping object with a records array is unwrapped", () => {
  const { records } = ingestText(JSON.stringify({ results: [{ x: 1 }, { x: 2 }] }), { source: "w.json" });
  assert.equal(records.length, 2);
  assert.equal(records[1].values["w.x"], 2);
});

// --- Real-data smoke tests: prove it runs on the actual interview dataset ---

test("real data: patient.csv → 100 records with canonical keys", () => {
  const { records, meta } = ingestFile(path.join(DATA_DIR, "patient.csv"));
  assert.equal(meta.rowCount, 100);
  assert.ok(records[0].values["patient.PAT_ID"]);
  assert.ok("patient.PAT_MRN_ID" in records[0].values);
});

test("real data: hno_info.csv notes ingest without breaking on commas/pipes in NOTE_TEXT", () => {
  const { records, meta } = ingestFile(path.join(DATA_DIR, "hno_info.csv"));
  assert.equal(meta.rowCount, 153);
  const note = records[0].values["hno_info.NOTE_TEXT"];
  assert.ok(note && note.length > 50, "NOTE_TEXT should survive intact as one cell");
});

test("real data: every file in data/ ingests to a stable rectangle", () => {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".csv"));
  assert.ok(files.length >= 10);
  for (const f of files) {
    const { records, header, meta } = ingestFile(path.join(DATA_DIR, f));
    assert.ok(header.length > 0, `${f}: header`);
    assert.ok(meta.rowCount > 0, `${f}: rows`);
    // Every record exposes exactly one value per header column.
    assert.equal(Object.keys(records[0].values).length, header.length, `${f}: width`);
  }
});
