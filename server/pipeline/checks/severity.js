"use strict";

/**
 * @module pipeline/checks/severity
 * @description
 * Deterministic severity → queue/SLA mapping. Severity is a *fact* derived from
 * governed thresholds and reference ranges — never model output. The queue and SLA
 * a ticket is routed to are a pure function of that severity.
 */

/** Severity tiers, most-urgent first. */
const TIERS = ["critical", "moderate", "mild"];

const ROUTING = {
  critical: { queue: "clinical-urgent", slaHours: 4 },
  moderate: { queue: "clinical-routine", slaHours: 24 },
  mild: { queue: "clinical-routine", slaHours: 72 },
};

/** @param {string} sev @returns {number} rank (0 = most severe) */
function rank(sev) {
  const i = TIERS.indexOf(sev);
  return i === -1 ? TIERS.length : i;
}

/** @param {string} sev @returns {{queue:string, slaHours:number}} */
function route(sev) {
  return ROUTING[sev] || ROUTING.mild;
}

module.exports = { TIERS, ROUTING, rank, route };
