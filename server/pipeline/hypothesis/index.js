"use strict";

/**
 * @module pipeline/hypothesis
 * @description
 * Generates the advisory, cited hypothesis for a ticket (the "Assessment / Plan" of
 * a generic SOAP note). The model is handed the ticket's deterministic facts and the
 * **governed rules that apply to this exact finding** (matched by LOINC + direction),
 * and must compose from them: pick one rule, explain the correlation in plain words,
 * and cite the facts it explains. It never sees or emits values, thresholds, or URLs
 * as authority — those are resolved deterministically after verification.
 *
 * Output is always run through {@link module:pipeline/hypothesis/verify}; only an
 * admissible, fully-sourced hypothesis is returned. If no governed rule applies, no
 * hypothesis is generated (the honest default is silence, not speculation).
 *
 * `runLLM` is injectable (defaults to the vendored `llms/src/claude`), so this whole
 * module is testable offline with a stub.
 */

const { verifyHypothesis, citableFacts } = require("./verify");

let _claudeRun, _haiku, _parse;
function lazyDefaults() {
  if (!_claudeRun) {
    _claudeRun = require("../../../llms/src/claude");
    _haiku = require("../../../llms/src/claude/config").HAIKU45_CONFIG;
    _parse = require("../../../llms/src/utilities/parseResponseJson");
  }
  return { runLLM: _claudeRun, config: _haiku, parse: _parse };
}

/** Governed rules whose LOINC + direction match this ticket's finding. */
function applicableRules(ticket, rules) {
  const loinc = ticket.provenance && ticket.provenance.loinc;
  const dir = ticket.facts && ticket.facts.direction;
  const out = {};
  for (const [id, r] of Object.entries(rules)) {
    if (id.startsWith("_")) continue;
    if (r.loinc === loinc && r.direction === dir) out[id] = r;
  }
  return out;
}

const SYSTEM_PROMPT = `You are a clinical triage assistant. You produce a brief, advisory note for a human reviewer about ONE abnormal lab result. You are NOT the source of truth: the facts and the clinical rule are given to you and are authoritative.

Output ONLY JSON:
{ "assessment": "<1-2 sentences: the likely clinical significance / cause>",
  "plan": "<1 sentence: a reasonable next step for the reviewer to consider>",
  "citations": { "facts": ["<fact key>", ...], "rule": "<rule id>" } }

Hard rules:
- Choose exactly ONE rule id from the provided rules and put it in citations.rule. If none fit, return {"assessment":"","plan":"","citations":{"facts":[],"rule":null}}.
- citations.facts must contain ONLY keys from this exact set: ["component","value","unit","direction","reference_low","reference_high","out_of_range_by","beyond_critical"]. Never use the test name (e.g. "Sodium", "eGFR") as a key.
- Write qualitatively. Do NOT write ANY number anywhere — not the result value, not the reference limits, not thresholds or doses. Use words only: "elevated", "markedly low", "above the reference range", "beyond the critical threshold".
- Never write a URL or link. Never invent a clinical rule.
- Keep it advisory ("consider", "suggest", "may warrant"); the human decides.`;

function buildUserPrompt(ticket, rules) {
  const facts = citableFacts(ticket);
  const factLines = Object.entries(facts)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const ruleLines = Object.entries(rules)
    .map(([id, r]) => `    ${id}: ${r.statement}`)
    .join("\n");
  return `Abnormal result (facts are authoritative; do not restate their numbers):
  component: ${ticket.facts.component}
  severity: ${ticket.severity}
  citable facts:
${factLines}

Applicable governed rules (choose one to cite by id):
${ruleLines}

Return the JSON note now.`;
}

/**
 * Generate and verify a hypothesis for one ticket.
 * @param {object} ticket
 * @param {object} opts
 * @param {Object}   opts.rules   - governed rules keyed by id
 * @param {Function} [opts.runLLM]
 * @param {object}   [opts.config]
 * @param {Function} [opts.parse]
 * @returns {Promise<{hypothesis:(object|null), admissible:boolean, reasons:string[], noRule?:boolean, usage?:object}>}
 */
async function generateHypothesis(ticket, opts = {}) {
  const rules = applicableRules(ticket, opts.rules || {});
  if (Object.keys(rules).length === 0) {
    return { hypothesis: null, admissible: false, reasons: ["no governed rule applies"], noRule: true };
  }

  const d = opts.runLLM ? {} : lazyDefaults();
  const runLLM = opts.runLLM || d.runLLM;
  const config = opts.config || d.config;
  const parse = opts.parse || d.parse || ((x) => JSON.parse(typeof x === "string" ? x : x.output.text));

  const res = await runLLM({ ...config, system: SYSTEM_PROMPT, max_tokens: 700 }, buildUserPrompt(ticket, rules));
  const parsed = parse(res && res.output ? res : (typeof res === "string" ? res : ""));

  const verdict = verifyHypothesis(ticket, parsed, { rules: opts.rules || {} });
  return { ...verdict, usage: (res && res.stats) || null };
}

module.exports = { generateHypothesis, applicableRules, SYSTEM_PROMPT, buildUserPrompt };
