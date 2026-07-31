"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { medRecon, reconcile, extractNoteMeds, normalizeMed, medAliases, inNote } = require("./medRecon");
const ticketsMod = require("../tickets");

test("normalizeMed: reduces to the drug-name core", () => {
  assert.equal(normalizeMed("Chlorthalidone 25 mg"), "chlorthalidone");
  assert.equal(normalizeMed("Tiotropium 18 mcg (Spiriva)"), "tiotropium");
  assert.equal(normalizeMed("Bupropion XL 150 mg"), "bupropion");
  assert.equal(normalizeMed("Losartan 50 mg"), "losartan");
});

test("inNote: only names present in the note pass (anti-hallucination)", () => {
  const note = "Medications reconciled: Aspirin | Metformin 500 mg.";
  assert.equal(inNote(note, "Aspirin"), true);
  assert.equal(inNote(note, "Metformin 500 mg"), true);
  assert.equal(inNote(note, "Warfarin"), false);
});

test("extractNoteMeds: drops model-invented meds not present in the note", async () => {
  const note = "Active meds: Aspirin and Metformin.";
  const runLLM = async () => ({ output: { text: JSON.stringify({ meds: [{ name: "Aspirin" }, { name: "Metformin" }, { name: "Warfarin" }] }) } });
  const parse = require("../../../llms/src/utilities/parseResponseJson");
  const { meds, dropped } = await extractNoteMeds(note, { runLLM, parse, config: {} });
  assert.deepEqual(meds.sort(), ["Aspirin", "Metformin"]);
  assert.deepEqual(dropped, ["Warfarin"]); // hallucinated, dropped before it can affect a finding
});

test("reconcile: flags order-only and note-only discrepancies", () => {
  const { findings } = reconcile({
    patientId: "P1", noteText: "Aspirin, Metformin",
    note: { id: "N1", encounterId: "E1" },
    noteMeds: ["Aspirin 81 mg", "Metformin 500 mg"],
    activeOrders: [{ name: "Aspirin 81 mg" }, { name: "Lisinopril 10 mg" }],
  });
  const kinds = findings.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["note-not-in-order", "order-not-in-note"]);
  const orderOnly = findings.find((f) => f.kind === "order-not-in-note");
  assert.equal(normalizeMed(orderOnly.facts.medication), "lisinopril");
  const noteOnly = findings.find((f) => f.kind === "note-not-in-order");
  assert.equal(normalizeMed(noteOnly.facts.medication), "metformin");
});

test("medAliases: parenthetical brand becomes a matchable alias", () => {
  assert.deepEqual(medAliases("Evolocumab 140 mg (Repatha)").sort(), ["evolocumab", "repatha"]);
  assert.deepEqual(medAliases("Tiotropium 18 mcg (Spiriva)").sort(), ["spiriva", "tiotropium"]);
});

test("reconcile: brand vs generic is NOT a discrepancy (alias match)", () => {
  // note lists the brand "Repatha"; order is written as the generic "Evolocumab 140 mg (Repatha)"
  const { findings } = reconcile({
    patientId: "P1", note: {},
    noteMeds: ["Repatha", "Evolocumab 140 mg", "Spiriva", "Tiotropium 18 mcg"],
    activeOrders: [{ name: "Evolocumab 140 mg (Repatha)" }, { name: "Tiotropium 18 mcg (Spiriva)" }],
  });
  assert.equal(findings.length, 0, JSON.stringify(findings.map((f) => f.facts.medication)));
});

test("reconcile: identical lists → no discrepancy", () => {
  const { findings } = reconcile({
    patientId: "P1", note: {}, noteMeds: ["Aspirin 81 mg"], activeOrders: [{ name: "Aspirin 81 mg" }],
  });
  assert.equal(findings.length, 0);
});

test("medRecon: only reconciles notes that mention medications; skips inactive orders", async () => {
  const notes = [
    { values: { "note.id": "N1", "note.patient_id": "P1", "note.encounter_id": "E1", "note.text": "Medications reconciled: Aspirin." } },
    { values: { "note.id": "N2", "note.patient_id": "P2", "note.text": "Patient counseled on diet and exercise; follow up in three months." } },
  ];
  const medOrders = [
    { values: { "medication_order.patient_id": "P1", "medication_order.name": "Aspirin 81 mg", "medication_order.status": "Active" } },
    { values: { "medication_order.patient_id": "P1", "medication_order.name": "Warfarin 5 mg", "medication_order.status": "Discontinued" } },
  ];
  const runLLM = async () => ({ output: { text: JSON.stringify({ meds: [{ name: "Aspirin" }] }) } });
  const parse = require("../../../llms/src/utilities/parseResponseJson");
  const { findings, stats } = await medRecon({ notes, medOrders }, { runLLM, parse, config: {} });
  assert.equal(stats.notesReconciled, 1); // N2 has no med mention → skipped (note text still matches /medication/i? no)
  assert.equal(findings.length, 0); // Aspirin matches; Warfarin is discontinued so not an active-order gap
});

test("tickets: med-recon findings assemble into a med-recon queue", () => {
  const finding = {
    checker: "med-recon", kind: "order-not-in-note", patientId: "P1", encounterId: "E1",
    facts: { medication: "Lisinopril 10 mg", discrepancy: "order-not-in-note", noteMeds: [], activeOrders: [] },
    provenance: { source: "hno_info.csv + order_med.csv", note_id: "N1" },
  };
  const list = ticketsMod.assemble({ medRecon: [finding] }, { patients: { P1: { name: "Jane Doe", age: 60, sex: "F" } } });
  assert.equal(list.length, 1);
  assert.equal(list[0].queue, "med-recon");
  assert.equal(list[0].checker, "med-recon");
  assert.equal(list[0].id.startsWith("MR-"), true);
  assert.equal(list[0].patient.name, "Jane Doe");
});
