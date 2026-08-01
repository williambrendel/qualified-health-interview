"use strict";

/**
 * @module pipeline/analyzers/registry
 * @description
 * The application layer as a **plug-in registry**. Each analyzer is a self-contained
 * module that consumes canonical records and emits findings; it registers itself here
 * (like the endpoint modules do with `createEndpoint`). The `/analyze` service
 * dispatches to whichever analyzers apply to the incoming canonical entity and unions
 * their findings.
 *
 * Because the contract is fixed on both sides — canonical records in, findings out —
 * the application layer is swappable without touching the input or output connectors.
 *
 * An analyzer is `{ id, title, appliesTo(entity) → boolean, run(records, opts) → findings[] }`.
 */

const _analyzers = [];

/** Register an analyzer. Returns it (so a module can `module.exports = register({...})`). */
function register(analyzer) {
  if (!analyzer || typeof analyzer.run !== "function" || typeof analyzer.appliesTo !== "function" || !analyzer.id) {
    throw new Error("invalid analyzer: needs { id, appliesTo(entity), run(records) }");
  }
  if (_analyzers.some((a) => a.id === analyzer.id)) return _analyzers.find((a) => a.id === analyzer.id);
  _analyzers.push(analyzer);
  return analyzer;
}

/** Analyzers that apply to a given canonical entity. */
function analyzersFor(entity) {
  return _analyzers.filter((a) => {
    try { return a.appliesTo(entity); } catch { return false; }
  });
}

/** All registered analyzers (id + title). */
function list() {
  return _analyzers.map((a) => ({ id: a.id, title: a.title || a.id }));
}

/** Test helper: reset the registry. */
function _clear() { _analyzers.length = 0; }

module.exports = { register, analyzersFor, list, _clear };
