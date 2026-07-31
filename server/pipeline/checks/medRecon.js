"use strict";

/**
 * @module pipeline/checks/medRecon
 * @description
 * **Medication reconciliation** — the third checker, and the most LLM-forward. It
 * compares the medications *documented in the free-text progress note* against the
 * patient's *active medication orders*, and flags each discrepancy for a human.
 *
 * Division of labor under the safety contract:
 * - **LLM (advisory, verified):** the one genuinely hard, unstructured task — read
 *   the note and extract the medications it mentions. Every extracted name is then
 *   **verified to literally appear in the note** (anti-hallucination); anything the
 *   model invented is dropped before it can affect a finding.
 * - **Deterministic:** normalization and the reconciliation itself (set difference
 *   note-vs-orders) are plain code. The discrepancy facts are authoritative.
 *
 * Data-agnostic: it operates on canonical `note.text` and `medication_order.name`
 * and matches on a normalized drug name — nothing keyed to this dataset.
 */

/** Normalize a medication string to its drug-name core for matching. */
function normalizeMed(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")       // drop parentheticals e.g. "(Spiriva)"
    .replace(/\b\d.*$/, " ")           // drop from the first dose digit onward
    .replace(/\b(xl|xr|er|sr|cr|hcl|sodium|mg|mcg|units?)\b/g, " ") // salts/forms/units
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * All normalized aliases for a medication string: the main drug name AND any
 * parenthetical brand/alternate names. So "Evolocumab 140 mg (Repatha)" yields
 * both "evolocumab" and "repatha" — letting a note that says "Repatha" match an
 * order written as the generic. Two meds are the same drug if their alias sets
 * intersect. This is what stops brand-vs-generic from reading as a discrepancy.
 */
function medAliases(s) {
  if (!s) return [];
  const aliases = new Set();
  for (const p of String(s).match(/\(([^)]*)\)/g) || []) {
    const inner = normalizeMed(p.replace(/[()]/g, ""));
    if (inner) aliases.add(inner);
  }
  const main = normalizeMed(s);
  if (main) aliases.add(main);
  return [...aliases];
}

/** Does a normalized drug name appear in the note text? (anti-hallucination) */
function inNote(noteText, medName) {
  const norm = normalizeMed(medName);
  if (!norm) return false;
  const head = norm.split(" ")[0];
  return head.length >= 3 && String(noteText).toLowerCase().includes(head);
}

const SYSTEM_PROMPT = `You extract medications from a clinical progress note. Output ONLY JSON:
{ "meds": [ { "name": "<medication name as written>" }, ... ] }
Rules:
- Include ONLY medications explicitly named in the note text. Never infer or add drugs that are not written.
- Copy the name roughly as it appears. Do not add drugs, doses, or advice.
- If the note names no medications, return { "meds": [] }.`;

/**
 * Extract note medications via the LLM, then keep only those verified present in
 * the note text.
 * @returns {Promise<{meds:string[], dropped:string[]}>}
 */
async function extractNoteMeds(noteText, opts = {}) {
  const runLLM = opts.runLLM || lazyRun();
  const config = opts.config || lazyCfg();
  const parse = opts.parse || lazyParse();

  const res = await runLLM({ ...config, system: SYSTEM_PROMPT, max_tokens: 600 }, `Note:\n${noteText}\n\nExtract the medications as JSON.`);
  const parsed = parse(res && res.output ? res : (typeof res === "string" ? res : "")) || {};
  const raw = Array.isArray(parsed.meds) ? parsed.meds.map((m) => (typeof m === "string" ? m : m && m.name)).filter(Boolean) : [];

  const meds = [], dropped = [];
  for (const name of raw) (inNote(noteText, name) ? meds : dropped).push(name);
  return { meds, dropped };
}

let _run, _cfg, _parse;
function lazyRun() { return (_run = _run || require("../../../llms/src/claude")); }
function lazyCfg() { return (_cfg = _cfg || require("../../../llms/src/claude/config").HAIKU45_CONFIG); }
function lazyParse() { return (_parse = _parse || require("../../../llms/src/utilities/parseResponseJson")); }

/**
 * Reconcile a patient's note-documented meds against their active orders.
 * @returns {{findings:object[]}}
 */
function reconcile({ patientId, noteText, note, noteMeds, activeOrders }) {
  const noteEntries = noteMeds.map((m) => ({ display: m, aliases: medAliases(m) })).filter((e) => e.aliases.length);
  const orderEntries = activeOrders.map((o) => ({ display: o.name, aliases: medAliases(o.name) })).filter((e) => e.aliases.length);
  const noteAliases = new Set(noteEntries.flatMap((e) => e.aliases));
  const orderAliases = new Set(orderEntries.flatMap((e) => e.aliases));
  const matches = (aliases, pool) => aliases.some((a) => pool.has(a));

  const displays = { noteMeds: [...new Set(noteEntries.map((e) => e.display))], activeOrders: [...new Set(orderEntries.map((e) => e.display))] };
  const findings = [];
  const seen = new Set();
  const mk = (kind, med, detail) => ({
    checker: "med-recon", kind, patientId,
    encounterId: (note && note.encounterId) || null,
    facts: { medication: med, discrepancy: kind, detail, ...displays },
    provenance: { source: "hno_info.csv + order_med.csv", note_id: (note && note.id) || null },
  });
  const push = (kind, display, detail) => {
    const key = kind + "|" + medAliases(display).join(",");
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(mk(kind, display, detail));
  };

  for (const e of orderEntries) {
    if (!matches(e.aliases, noteAliases)) push("order-not-in-note", e.display, "active order not documented in the note's reconciliation");
  }
  for (const e of noteEntries) {
    if (!matches(e.aliases, orderAliases)) push("note-not-in-order", e.display, "medication in the note has no matching active order");
  }
  return { findings };
}

/**
 * Run med reconciliation across patients that have both a note and orders.
 * @param {object} sources
 * @param {Array} sources.notes    - canonical `note` records
 * @param {Array} sources.medOrders- canonical `medication_order` records
 * @param {object} opts - { runLLM, config, parse, maxNotes }
 * @returns {Promise<{findings:object[], stats:object}>}
 */
async function medRecon(sources, opts = {}) {
  const notes = (sources.notes || []).map((r) => ({
    id: r.values["note.id"], patientId: r.values["note.patient_id"],
    encounterId: r.values["note.encounter_id"], text: r.values["note.text"] || "",
  })).filter((n) => n.patientId && /medication/i.test(n.text));

  // active orders per patient
  const byPatient = new Map();
  for (const r of sources.medOrders || []) {
    const pid = r.values["medication_order.patient_id"];
    const status = r.values["medication_order.status"];
    const name = r.values["medication_order.name"];
    if (!pid || !name) continue;
    if (status && !/active/i.test(String(status))) continue;
    if (!byPatient.has(pid)) byPatient.set(pid, []);
    byPatient.get(pid).push({ name });
  }

  const limit = opts.maxNotes || notes.length;
  const findings = [];
  const stats = { notesReconciled: 0, discrepancies: 0, hallucinationsDropped: 0 };

  for (const note of notes.slice(0, limit)) {
    const { meds, dropped } = await extractNoteMeds(note.text, opts);
    stats.hallucinationsDropped += dropped.length;
    const r = reconcile({ patientId: note.patientId, noteText: note.text, note, noteMeds: meds, activeOrders: byPatient.get(note.patientId) || [] });
    findings.push(...r.findings);
    stats.notesReconciled++;
  }
  stats.discrepancies = findings.length;
  return { findings, stats };
}

module.exports = { medRecon, reconcile, extractNoteMeds, normalizeMed, medAliases, inNote };
