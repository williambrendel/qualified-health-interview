"use strict";

/**
 * @module pipeline/output
 * @description
 * The **output connector** — the mirror image of the input connector. Where the
 * input side maps *arbitrary source → canonical*, the output side maps *canonical
 * ticket → an arbitrary target system's API* (a ticketing/EHR/CRM endpoint).
 *
 * Same two-part shape as the input connector: a **field map** (which in production
 * the LLM would induce from the target's API doc, exactly like the input manifest)
 * and a **deterministic apply** that builds the payloads. And the same safety rule:
 * a real push is a human-gated action, so this prototype only ever produces a
 * **dry run** — the payloads that *would* be sent, never sent.
 */

const PRIORITY = { critical: "P1", moderate: "P2", mild: "P3", "care-gap": "P3", "med-recon": "P3", "data-quality": "P4" };

const getPath = (obj, path) => String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Default payload for a generic ticketing target (used when no field map is supplied). */
function defaultPayload(t) {
  const f = t.facts || {};
  const subject = f.component || f.expectedTest || f.medication || t.checker;
  const description = f.value != null ? `${subject} = ${f.value}${f.unit ? " " + f.unit : ""}`
    : f.gapType ? `${subject}: ${f.gapType}`
    : f.discrepancy ? `${subject}: ${f.discrepancy}` : subject;
  return {
    external_id: t.id,
    summary: `${subject} — ${t.severity}`,
    priority: PRIORITY[t.severity] || "P3",
    queue: t.queue,
    patient_ref: (t.patient && t.patient.id) || null,
    description,
    source: t.provenance && t.provenance.source,
  };
}

/** Apply an explicit field map `{ targetField: canonicalTicketPath }`. */
function applyFieldMap(t, fieldMap) {
  const out = {};
  for (const [target, path] of Object.entries(fieldMap)) out[target] = getPath(t, path);
  return out;
}

/**
 * Build the payloads that would be pushed to the target — a DRY RUN.
 * @param {object[]} tickets
 * @param {object} [opts]
 * @param {Object}  [opts.fieldMap] - `{ targetField: ticketPath }`; omit for the default map.
 * @param {string}  [opts.target]   - target system label.
 * @param {boolean} [opts.dryRun=true] - only dry-run is supported in this prototype.
 * @returns {object}
 */
function publish(tickets, opts = {}) {
  const dryRun = opts.dryRun !== false; // dry-run is the only mode; a real push is human-gated
  const payloads = tickets.map((t) => (opts.fieldMap ? applyFieldMap(t, opts.fieldMap) : defaultPayload(t)));
  return {
    dryRun: true,
    requestedDryRun: dryRun,
    target: opts.target || "generic-ticketing (mock)",
    fieldMapSource: opts.fieldMap ? "provided" : "default (LLM would induce this from the target's API doc)",
    count: payloads.length,
    note: "DRY RUN — a real push is a human-gated action; nothing was written to any external system.",
    payloads,
  };
}

module.exports = { publish, defaultPayload, applyFieldMap, PRIORITY };
