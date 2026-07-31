"use strict";

/**
 * @module pipeline/checks/abnormalResult
 * @description
 * **Abnormal-result triage** — the first checker. Of the lab results we have, which
 * need a human first? Every decision here is deterministic and sourced; the LLM has
 * no part in it. For each canonical `lab_result` with a numeric value:
 *
 * 1. **Plausibility gate (first, always).** If the value is outside the analyte's
 *    physiologically-possible bounds (governed config), it is *impossible*, not
 *    *abnormal* — it is diverted to a **data-quality** finding and kept OUT of the
 *    clinical queue. This is what stops a Sodium of 210 or an SpO2 of 126% from
 *    paging a clinician.
 * 2. **Abnormal detection.** Compare the value to the result's own reference range
 *    (low/high). In-range → not a finding.
 * 3. **Severity.** `critical` if beyond governed panic thresholds; otherwise
 *    `moderate`/`mild` by how far outside the reference range it sits.
 *
 * Output is two lists of findings (clinical + data-quality), each carrying its own
 * facts and provenance — ready for ticket assembly.
 */

const severity = require("./severity");

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/**
 * Data-agnostic plausibility fallback. When no curated per-analyte bound exists, a
 * value is judged implausible purely from the result's OWN reference range (which
 * every result carries): it sits absurdly far outside the range, or violates the
 * sign the range implies. This uses nothing dataset-specific — it runs on any
 * analyte, in any schema, with no config — so the mechanism never silently does
 * nothing on an unknown test. Curated bounds (when present) are strictly more
 * precise; this is the floor, not a replacement.
 *
 * @returns {{implausible:boolean, bounds:object|null}}
 */
function genericPlausibility(value, low, high, k) {
  if (low == null && high == null) return { implausible: false, bounds: null };
  const range = low != null && high != null ? Math.max(high - low, 1e-9) : Math.max(Math.abs(high ?? low), 1);
  const hiCut = high != null ? high + k * range : null;
  const loCut = low != null ? low - k * range : null;
  // A strictly-non-negative reference implies the analyte cannot be negative.
  const signViolation = low != null && low >= 0 && value < 0;
  const implausible = signViolation || (hiCut != null && value > hiCut) || (loCut != null && value < loCut);
  return {
    implausible,
    bounds: implausible ? { low: loCut != null ? +loCut.toFixed(2) : null, high: hiCut != null ? +hiCut.toFixed(2) : null } : null,
  };
}

/**
 * @param {Array<{values:Object, source?:string, recordIndex?:number}>} records - canonical lab_result records
 * @param {object} [opts]
 * @param {Object} [opts.analytes={}] - OPTIONAL governed analyte config keyed by LOINC
 *   (plausibility + critical thresholds). Absent analytes fall back to reference-range
 *   -derived plausibility and distance-based severity — the checker runs on any data.
 * @param {number} [opts.plausibilityRangeMultiple=5] - k for the generic fallback
 *   (implausible if beyond reference ± k × range).
 * @returns {{clinical: object[], dataQuality: object[], skipped: number}}
 */
function triage(records, opts = {}) {
  const analytes = opts.analytes || {};
  const rangeMultiple = opts.plausibilityRangeMultiple || 5;
  const clinical = [];
  const dataQuality = [];
  let skipped = 0;

  for (const rec of records) {
    const v = rec.values;
    const value = num(v["lab_result.value"]);
    if (value === null) { skipped++; continue; } // non-numeric/text result — out of scope here

    const loinc = v["lab_result.loinc"] || null;
    const component = v["lab_result.component"] || null;
    const unit = v["lab_result.unit"] || null;
    const low = num(v["lab_result.reference.low"]);
    const high = num(v["lab_result.reference.high"]);
    const cfg = (loinc && analytes[loinc]) || null;

    const provenance = {
      source: rec.source || "order_results.csv",
      result_id: v["lab_result.id"] || null,
      order_id: v["lab_result.order_id"] || null,
      loinc,
    };
    const patientId = v["lab_result.patient_id"] || null;
    const encounterId = v["lab_result.encounter_id"] || null;
    const baseFacts = { component, loinc, value, unit, reference: { low, high }, resultDate: v["lab_result.date"] || null };

    // 1. Plausibility gate — impossible values never reach the clinical queue.
    //    Curated per-analyte bounds are used when present (precise); otherwise a
    //    generic bound is derived from the result's own reference range so the gate
    //    works on ANY analyte, with or without config.
    const pl = cfg && cfg.plausible;
    let implausible = false, plausibleBounds = null, plausibilityBasis = null;
    if (pl) {
      implausible = (pl.low != null && value < pl.low) || (pl.high != null && value > pl.high);
      plausibleBounds = pl;
      plausibilityBasis = "governed";
    } else {
      const g = genericPlausibility(value, low, high, rangeMultiple);
      implausible = g.implausible;
      plausibleBounds = g.bounds;
      plausibilityBasis = "reference-derived";
    }
    if (implausible) {
      dataQuality.push({
        checker: "abnormal-result-triage",
        kind: "implausible-value",
        patientId, encounterId,
        facts: {
          ...baseFacts, plausibleBounds, plausibilityBasis,
          reason: plausibilityBasis === "governed"
            ? "value outside physiologically-possible range"
            : `value far outside its reference range (> ${rangeMultiple}x the range, no curated bound)`,
        },
        provenance,
      });
      continue;
    }

    // 2. Abnormal detection from the result's own reference range.
    let direction = null;
    if (low != null && value < low) direction = "low";
    else if (high != null && value > high) direction = "high";
    if (!direction) continue; // in range

    // 3. Severity.
    const crit = cfg && cfg.critical;
    const beyondCritical =
      crit && ((crit.low != null && value < crit.low) || (crit.high != null && value > crit.high));

    let sev;
    let relDistance = null;
    if (beyondCritical) {
      sev = "critical";
    } else {
      const width = low != null && high != null ? high - low : Math.abs(value) || 1;
      const dist = direction === "low" ? low - value : value - high;
      relDistance = width > 0 ? dist / width : null;
      sev = relDistance != null && relDistance > 0.5 ? "moderate" : "mild";
    }

    const { queue, slaHours } = severity.route(sev);
    clinical.push({
      checker: "abnormal-result-triage",
      kind: "abnormal-result",
      patientId, encounterId,
      severity: sev,
      queue, slaHours,
      facts: {
        ...baseFacts,
        direction,
        outOfRangeBy: direction === "low" ? (low != null ? +(low - value).toFixed(3) : null)
                                          : (high != null ? +(value - high).toFixed(3) : null),
        relDistance: relDistance != null ? +relDistance.toFixed(3) : null,
        beyondCritical: !!beyondCritical,
        criticalBounds: crit || null,
      },
      provenance,
    });
  }

  // Rank clinical findings: severity first, then how far beyond critical / out of range.
  clinical.sort((a, b) => {
    const r = severity.rank(a.severity) - severity.rank(b.severity);
    if (r !== 0) return r;
    return (b.facts.outOfRangeBy || 0) - (a.facts.outOfRangeBy || 0);
  });

  return { clinical, dataQuality, skipped };
}

module.exports = { triage };
