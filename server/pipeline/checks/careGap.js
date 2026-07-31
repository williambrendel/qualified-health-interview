"use strict";

/**
 * @module pipeline/checks/careGap
 * @description
 * **Care-gap / preventive-lab verification** — the second checker. For each of a
 * patient's active conditions, were the expected monitoring tests done? It closes
 * the loop in two ways a single table can't:
 *
 * - **never-ordered** — the condition calls for the test and no order exists.
 * - **ordered-but-unresulted** — an order exists but no result ever came back
 *   (the loop was opened and never closed — the failure mode that silently harms).
 *
 * Everything is deterministic: conditions come from the problem list, expected
 * tests from the governed care-gap config (matched by longest ICD-10 prefix), and
 * "was it resulted?" from the lab results. The LLM has no role here.
 */

/** Match an ICD-10 code to its governed rule by longest prefix. */
function matchRule(icd10, config) {
  if (!icd10) return null;
  const code = String(icd10).toUpperCase().replace(/\s/g, "");
  let best = null;
  for (const key of Object.keys(config)) {
    if (key.startsWith("_")) continue;
    if (code.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? { key: best, ...config[best] } : null;
}

const truthyActive = (status) => status == null || /active/i.test(String(status)) || String(status) === "1";
const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";

/**
 * @param {object} sources
 * @param {Array} sources.problems     - canonical `problem` records
 * @param {Array} sources.labResults   - canonical `lab_result` records (resulted tests)
 * @param {Array} sources.labOrders    - canonical `lab_order` records (orders, may be unresulted)
 * @param {object} opts
 * @param {object} opts.careGaps       - governed condition→expected-test config
 * @returns {{findings: object[], stats: object}}
 */
function careGaps(sources, opts = {}) {
  const config = opts.careGaps || {};
  const problems = sources.problems || [];
  const labResults = sources.labResults || [];
  const labOrders = sources.labOrders || [];

  // patientId → Set(loinc) that has a real result
  const resulted = new Map();
  for (const r of labResults) {
    const pid = r.values["lab_result.patient_id"];
    const loinc = r.values["lab_result.loinc"];
    if (!pid || !loinc) continue;
    if (!resulted.has(pid)) resulted.set(pid, new Set());
    resulted.get(pid).add(loinc);
  }

  // patientId → Set(loinc) ordered but with no result value (loop left open)
  const orderedOpen = new Map();
  for (const o of labOrders) {
    const pid = o.values["lab_order.patient_id"];
    const loinc = o.values["lab_order.code"];
    if (!pid || !loinc) continue;
    if (isBlank(o.values["lab_order.result_value"])) {
      if (!orderedOpen.has(pid)) orderedOpen.set(pid, new Set());
      orderedOpen.get(pid).add(loinc);
    }
  }

  const findings = [];
  const seen = new Set(); // patient|condition|loinc — one gap per expected test per condition
  const stats = { activeConditionsChecked: 0, neverOrdered: 0, orderedNotResulted: 0, closed: 0 };

  for (const p of problems) {
    const v = p.values;
    if (!truthyActive(v["problem.status"])) continue;
    const rule = matchRule(v["problem.icd10"], config);
    if (!rule) continue;
    const pid = v["problem.patient_id"];
    if (!pid) continue;
    stats.activeConditionsChecked++;

    for (const exp of rule.expect) {
      const dedup = `${pid}|${rule.condition}|${exp.loinc}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      if (resulted.get(pid) && resulted.get(pid).has(exp.loinc)) { stats.closed++; continue; }

      const openOrder = orderedOpen.get(pid) && orderedOpen.get(pid).has(exp.loinc);
      const kind = openOrder ? "ordered-not-resulted" : "never-ordered";
      openOrder ? stats.orderedNotResulted++ : stats.neverOrdered++;

      findings.push({
        checker: "care-gap",
        kind,
        patientId: pid,
        facts: {
          condition: rule.condition,
          icd10: v["problem.icd10"],
          expectedTest: exp.test,
          loinc: exp.loinc,
          gapType: kind,
          cadenceMonths: rule.cadenceMonths,
        },
        provenance: {
          source: "problem_list.csv",
          problem_id: v["problem.id"] || null,
          rule: rule.key,
          ruleUrl: rule.url,
        },
      });
    }
  }

  return { findings, stats };
}

module.exports = { careGaps, matchRule };
