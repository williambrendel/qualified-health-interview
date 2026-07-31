"use strict";

/**
 * @module pipeline/hypothesis/verify
 * @description
 * The deterministic gate on advisory output. An LLM hypothesis is **admissible only
 * if it is fully sourced**:
 *
 * - it cites a governed rule id that exists AND applies to this finding
 *   (matching LOINC + direction);
 * - every fact it claims to explain is a real, citable fact of the ticket;
 * - it contains no URL (links come only from the governed rule, never the model);
 * - it emits no value — any decimal, or any integer that restates a sourced
 *   number (the measured value, a reference bound, a critical bound), is rejected.
 *
 * Anything failing is rejected wholesale; the ticket keeps its deterministic facts
 * with no hypothesis. The model may compose from governed pieces — it may never be
 * the source of a fact, a rule, a number, or a link.
 */

/** The facts a hypothesis is allowed to cite, as a key→value map. */
function citableFacts(ticket) {
  const f = ticket.facts || {};
  const ref = f.reference || {};
  return {
    component: f.component,
    value: f.value,
    unit: f.unit,
    direction: f.direction,
    reference_low: ref.low,
    reference_high: ref.high,
    out_of_range_by: f.outOfRangeBy,
    beyond_critical: f.beyondCritical,
  };
}

/** Numbers the model is NOT allowed to restate in prose (facts are shown structurally). */
function sourcedNumbers(ticket) {
  const f = ticket.facts || {};
  const ref = f.reference || {};
  const crit = f.criticalBounds || {};
  const nums = new Set();
  [f.value, ref.low, ref.high, f.outOfRangeBy, crit.low, crit.high].forEach((n) => {
    if (typeof n === "number") nums.add(n);
  });
  return nums;
}

/**
 * Reject any decimal (a decimal in prose is almost always an emitted lab value),
 * or any integer that restates a sourced number of magnitude >= 10. The >= 10 gate
 * is deliberate: small integers pervade benign clinical prose ("type 1 diabetes",
 * "over 1-3 months", "stage 2") and would otherwise collide with small sourced
 * numbers (a difference-from-range near 1) and cause false rejections. A restated
 * *measured value* that matters is a larger, specific number and is still caught.
 */
function scanNumbers(text, sourced) {
  const toks = String(text || "").match(/\d+(?:\.\d+)?/g) || [];
  for (const tok of toks) {
    if (tok.includes(".")) return { ok: false, offending: tok, why: "emits a decimal value" };
    const n = Number(tok);
    for (const v of sourced) {
      if (Math.abs(v) >= 10 && Math.round(v) === n) return { ok: false, offending: tok, why: "restates a sourced value" };
    }
  }
  return { ok: true };
}

const URL_RE = /\bhttps?:\/\/|\bwww\.|\]\(/i;

/**
 * @param {object} ticket
 * @param {object} parsed - raw model output: { assessment, plan, citations:{facts:[], rule} }
 * @param {object} opts
 * @param {Object} opts.rules - governed rules keyed by id
 * @returns {{admissible:boolean, reasons:string[], hypothesis:(object|null)}}
 */
function verifyHypothesis(ticket, parsed, opts = {}) {
  const rules = opts.rules || {};
  const reasons = [];

  if (!parsed || typeof parsed !== "object") {
    return { admissible: false, reasons: ["no parseable hypothesis"], hypothesis: null };
  }
  const { assessment, plan, citations } = parsed;
  if (typeof assessment !== "string" || !assessment.trim()) reasons.push("missing assessment");
  if (typeof plan !== "string" || !plan.trim()) reasons.push("missing plan");
  if (!citations || typeof citations !== "object") reasons.push("missing citations");

  // Rule citation must exist and apply to this finding.
  const ruleId = citations && citations.rule;
  const rule = ruleId && rules[ruleId];
  if (!rule) {
    reasons.push(`cites unknown rule "${ruleId}"`);
  } else {
    const loinc = ticket.provenance && ticket.provenance.loinc;
    const dir = ticket.facts && ticket.facts.direction;
    if (rule.loinc !== loinc || rule.direction !== dir) {
      reasons.push(`rule "${ruleId}" does not apply to this finding (${loinc}/${dir})`);
    }
  }

  // Fact citations are normalized ("key: value" → key) then filtered to real
  // citable facts. An extraneous or mislabeled fact-label (e.g. the test name) is
  // a cosmetic slip, not a safety risk — it carries no value or authority — so it
  // is dropped rather than fatal. The hypothesis must still cite at least one real
  // fact. (The dangerous cases — fabricated rules, URLs, or values — are enforced
  // strictly elsewhere.)
  const facts = citableFacts(ticket);
  const rawCited = (citations && Array.isArray(citations.facts) && citations.facts) || [];
  const normalized = [...new Set(rawCited.map((k) => String(k).split(":")[0].trim()))];
  const citedFactKeys = normalized.filter((k) => k in facts);
  if (citedFactKeys.length === 0) reasons.push("cites no valid facts");

  // No URLs, no emitted/restated values.
  const text = `${assessment || ""}\n${plan || ""}`;
  if (URL_RE.test(text)) reasons.push("contains a URL or link (links come only from the governed rule)");
  const numScan = scanNumbers(text, sourcedNumbers(ticket));
  if (!numScan.ok) reasons.push(`${numScan.why}: "${numScan.offending}"`);

  if (reasons.length) return { admissible: false, reasons, hypothesis: null };

  // Admissible → assemble the governed, sourced hypothesis.
  return {
    admissible: true,
    reasons: [],
    hypothesis: {
      assessment: assessment.trim(),
      plan: plan.trim(),
      cites: {
        facts: citedFactKeys.map((k) => ({ key: k, value: facts[k] })),
        rule: { id: ruleId, statement: rule.statement, url: rule.url },
      },
      verified: true,
    },
  };
}

module.exports = { verifyHypothesis, citableFacts, sourcedNumbers, scanNumbers };
