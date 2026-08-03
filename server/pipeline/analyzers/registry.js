"use strict";

/**
 * @module pipeline/analyzers/registry
 * @description
 * The application layer as a **plug-in registry** over a *canonical dataset* — the
 * connected records grouped by entity: `{ lab_result: [...], problem: [...], ... }`.
 *
 * Each analyzer declares the entities it needs and consumes the dataset:
 *
 *   { id, title, requires: string[] | "*", run(dataset, opts) → findings[] }
 *
 * - `requires: ["lab_result"]`                     — single-entity (e.g. triage)
 * - `requires: ["problem","lab_result","lab_order"]` — multi-entity join (e.g. care-gap)
 * - `requires: "*"`                                — entity-agnostic (runs on whatever is present)
 *
 * Dispatch is one rule: run every analyzer whose `requires` are all present, and
 * union the findings. Because the contract is fixed on both sides — canonical dataset
 * in, findings out — the app layer is swappable without touching the connectors.
 */

const _analyzers = [];

/** Register an analyzer. Returns it, so a module can `module.exports = register({...})`. */
function register(analyzer) {
  const ok = analyzer && analyzer.id && typeof analyzer.run === "function" &&
    (analyzer.requires === "*" || Array.isArray(analyzer.requires));
  if (!ok) throw new Error("invalid analyzer: needs { id, requires: string[]|'*', run(dataset) }");
  const existing = _analyzers.find((a) => a.id === analyzer.id);
  if (existing) return existing;
  _analyzers.push(analyzer);
  return analyzer;
}

/** Are an analyzer's required entities all present (non-empty) in the dataset? */
function requirementsMet(analyzer, dataset) {
  if (analyzer.requires === "*") return true;
  return analyzer.requires.every((e) => Array.isArray(dataset[e]) && dataset[e].length > 0);
}

/** Analyzers whose requirements the dataset satisfies. */
function applicable(dataset) {
  return _analyzers.filter((a) => requirementsMet(a, dataset));
}

/** Run every applicable analyzer (await async ones) and union their findings. */
async function runAll(dataset, opts = {}) {
  const findings = [];
  for (const a of _analyzers) {
    if (!requirementsMet(a, dataset)) continue;
    const f = await a.run(dataset, opts);
    if (Array.isArray(f)) findings.push(...f);
  }
  return findings;
}

/** All registered analyzers (id, title, requires). */
function list() {
  return _analyzers.map((a) => ({ id: a.id, title: a.title || a.id, requires: a.requires }));
}

/** Test helper: reset the registry. */
function _clear() { _analyzers.length = 0; }

module.exports = { register, requirementsMet, applicable, runAll, list, _clear };
