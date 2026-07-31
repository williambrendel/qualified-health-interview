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
 * @param {Array<{values:Object, source?:string, recordIndex?:number}>} records - canonical lab_result records
 * @param {object} opts
 * @param {Object} opts.analytes - governed analyte config keyed by LOINC
 * @returns {{clinical: object[], dataQuality: object[], skipped: number}}
 */
function triage(records, opts = {}) {
  const analytes = opts.analytes || {};
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
    const pl = cfg && cfg.plausible;
    if (pl && ((pl.low != null && value < pl.low) || (pl.high != null && value > pl.high))) {
      dataQuality.push({
        checker: "abnormal-result-triage",
        kind: "implausible-value",
        patientId, encounterId,
        facts: { ...baseFacts, plausibleBounds: pl, reason: "value outside physiologically-possible range" },
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
