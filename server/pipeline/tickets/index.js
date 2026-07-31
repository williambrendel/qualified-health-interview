"use strict";

/**
 * @module pipeline/tickets
 * @description
 * Assembles checker findings into **tickets** — the standardized unit of human
 * review. A ticket separates **fact** from **hypothesis**: the `facts` and
 * `provenance` are deterministic and authoritative; `hypothesis` is left `null`
 * here and filled later by the advisory (cited) LLM layer. Nothing in a ticket
 * writes to a chart — an actionable ticket only ever proposes work for a human to
 * approve.
 *
 * Ticket ids are deterministic (derived from the source record), so re-running the
 * pipeline produces stable ids and natural de-duplication.
 */

/** Build a stable ticket id from a finding. */
function ticketId(finding) {
  if (finding.checker === "care-gap") {
    const key = (finding.provenance && finding.provenance.problem_id) || finding.patientId;
    return `CG-${key}-${finding.facts.loinc}`;
  }
  const prefix = finding.kind === "implausible-value" ? "DQ" : "AR";
  const key = (finding.provenance && finding.provenance.result_id) || `${finding.patientId}-${finding.facts.component}`;
  return `${prefix}-${key}`;
}

/** Convert a care-gap finding into a ticket. */
function toCareGapTicket(finding, ctx = {}) {
  const patient = (ctx.patients && finding.patientId && ctx.patients[finding.patientId]) || null;
  return {
    id: ticketId(finding),
    checker: "care-gap",
    kind: finding.kind, // "never-ordered" | "ordered-not-resulted"
    status: "open",
    queue: "care-gap",
    severity: "care-gap",
    gapType: finding.kind,
    slaHours: null,
    patient: {
      id: finding.patientId || null,
      name: patient ? patient.name : null,
      age: patient ? patient.age : null,
      sex: patient ? patient.sex : null,
    },
    encounterId: null,
    facts: finding.facts,
    provenance: finding.provenance,
    hypothesis: null, // care gaps are actionable as-is; the action is "order/result the expected test"
  };
}

/**
 * Convert one finding into a ticket.
 * @param {object} finding
 * @param {object} [ctx]
 * @param {Object.<string,object>} [ctx.patients] - patientId → { name, age, sex }
 */
function toTicket(finding, ctx = {}) {
  if (finding.checker === "care-gap") return toCareGapTicket(finding, ctx);
  const isDataQuality = finding.kind === "implausible-value";
  const patient = (ctx.patients && finding.patientId && ctx.patients[finding.patientId]) || null;
  return {
    id: ticketId(finding),
    checker: finding.checker,
    kind: finding.kind,
    status: "open",
    queue: isDataQuality ? "data-quality" : finding.queue,
    severity: finding.severity || (isDataQuality ? "data-quality" : null),
    slaHours: finding.slaHours || null,
    patient: {
      id: finding.patientId || null,
      name: patient ? patient.name : null,
      age: patient ? patient.age : null,
      sex: patient ? patient.sex : null,
    },
    encounterId: finding.encounterId || null,
    facts: finding.facts,
    provenance: finding.provenance,
    hypothesis: null, // filled by the advisory LLM layer (Day 4), cited
  };
}

/**
 * Assemble tickets from a checker's findings, de-duplicated by id and ranked
 * (clinical severity first, data-quality last).
 *
 * @param {{clinical: object[], dataQuality: object[]}} findings
 * @param {object} [ctx] - see {@link toTicket}
 * @returns {object[]}
 */
function assemble(findings, ctx = {}) {
  const all = [
    ...(findings.clinical || []),
    ...(findings.dataQuality || []),
    ...(findings.careGaps || []),
  ];
  const byId = new Map();
  for (const f of all) {
    const t = toTicket(f, ctx);
    if (!byId.has(t.id)) byId.set(t.id, t);
  }
  const sevRank = { critical: 0, moderate: 1, mild: 2, "care-gap": 3, "data-quality": 4 };
  return [...byId.values()].sort((a, b) => {
    const r = (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9);
    if (r !== 0) return r;
    if (a.queue === "care-gap" && b.queue === "care-gap") {
      // open loops (ordered but never resulted) before never-ordered
      const g = (a.gapType === "ordered-not-resulted" ? 0 : 1) - (b.gapType === "ordered-not-resulted" ? 0 : 1);
      if (g !== 0) return g;
    }
    return (b.facts.outOfRangeBy || 0) - (a.facts.outOfRangeBy || 0);
  });
}

/** Summary counts for a ticket list. */
function summarize(tickets) {
  const byQueue = {};
  const bySeverity = {};
  for (const t of tickets) {
    byQueue[t.queue] = (byQueue[t.queue] || 0) + 1;
    bySeverity[t.severity] = (bySeverity[t.severity] || 0) + 1;
  }
  return { total: tickets.length, byQueue, bySeverity };
}

module.exports = { assemble, toTicket, ticketId, summarize };
