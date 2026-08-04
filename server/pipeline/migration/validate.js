"use strict";

/**
 * @module pipeline/migration/validate
 * @description
 * Migration validation: compare a **source** dataset against a **target** (post-migration)
 * dataset, both already mapped to the canonical model, and prove — exhaustively, not by
 * sampling — that nothing was lost or altered.
 *
 *   - **Completeness:** every source record is present in the target (none dropped),
 *     and nothing spurious was added.
 *   - **Fidelity:** for each matched record, every compared canonical field holds the
 *     same value.
 *
 * Every discrepancy carries provenance (record id, field, source vs target value) and is
 * ranked by clinical severity, so the report can be the basis of a sign-off. Deterministic
 * by construction — no model opinion in the verdict.
 */

const DEFAULT_FIELDS = [
  "lab_result.patient_id", "lab_result.component", "lab_result.loinc",
  "lab_result.value", "lab_result.reference.low", "lab_result.reference.high",
  "lab_result.unit", "lab_result.flag", "lab_result.date",
];

function valEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  return String(a) === String(b);
}

/** Higher = more clinically severe (surfaced first). */
function severity(field) {
  if (field === "__dropped__") return 3;                 // data loss
  if (field === "lab_result.value") return 2;            // wrong result value
  if (field.startsWith("lab_result.reference")) return 1; // wrong reference range
  return 0;
}

/**
 * @param {Array<{values:Object}>} source - canonical source records
 * @param {Array<{values:Object}>} target - canonical target (post-migration) records
 * @param {object} [opts]
 * @param {string} [opts.keyField="lab_result.id"] - stable record identifier
 * @param {string[]} [opts.fields] - canonical fields to compare
 * @returns {object} validation report
 */
function validateMigration(source, target, opts = {}) {
  const key = opts.keyField || "lab_result.id";
  const fields = opts.fields || DEFAULT_FIELDS;

  const src = new Map(source.map((r) => [r.values[key], r.values]));
  const tgt = new Map(target.map((r) => [r.values[key], r.values]));

  const dropped = [];
  const added = [];
  for (const id of src.keys()) if (!tgt.has(id)) dropped.push(id);
  for (const id of tgt.keys()) if (!src.has(id)) added.push(id);

  const mismatches = [];
  let compared = 0, fieldChecks = 0;
  for (const [id, sv] of src) {
    const tv = tgt.get(id);
    if (!tv) continue;
    compared++;
    for (const f of fields) {
      fieldChecks++;
      if (!valEqual(sv[f], tv[f])) {
        mismatches.push({ id, field: f, analyte: sv["lab_result.component"] || null, patient: sv["lab_result.patient_id"] || null, source: sv[f], target: tv[f], severity: severity(f) });
      }
    }
  }

  // Dropped records rank above field mismatches (data loss is the worst outcome).
  const findings = [
    ...dropped.map((id) => ({ id, field: "__dropped__", analyte: (src.get(id) || {})["lab_result.component"] || null, patient: (src.get(id) || {})["lab_result.patient_id"] || null, source: "present", target: "MISSING", severity: severity("__dropped__") })),
    ...mismatches,
  ].sort((a, b) => b.severity - a.severity);

  const matched = compared;
  const completenessPct = src.size ? +(100 * matched / src.size).toFixed(3) : 100;
  const fidelityPct = fieldChecks ? +(100 * (fieldChecks - mismatches.length) / fieldChecks).toFixed(3) : 100;

  return {
    pass: dropped.length === 0 && added.length === 0 && mismatches.length === 0,
    completeness: { sourceRecords: src.size, targetRecords: tgt.size, matched, dropped: dropped.length, added: added.length, completenessPct },
    fidelity: { comparedRecords: compared, fieldChecks, fieldMismatches: mismatches.length, fidelityPct },
    findings, // dropped + field mismatches, most-severe first, each with provenance
  };
}

module.exports = { validateMigration, valEqual, DEFAULT_FIELDS };
