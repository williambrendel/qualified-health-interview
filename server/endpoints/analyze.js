"use strict";

/**
 * @module endpoints/analyze
 * @description The application layer as a microservice, dispatched through the
 * analyzer registry:
 *
 *   POST /analyze — canonical records → tickets. Runs EVERY registered analyzer that
 *                   applies to the incoming entity and unions their findings.
 *
 * The app layer is swappable: register a different analyzer module and this endpoint
 * routes to it — the input/output connectors don't change.
 */

const { createEndpoint } = require("../core");
const { ticketsMod } = require("./lib");
require("../pipeline/analyzers"); // registers all analyzers on load
const registry = require("../pipeline/analyzers/registry");

const analyze = createEndpoint("post", "/analyze", (req, res) => {
  try {
    const { entity, records } = req.body || {};
    if (!Array.isArray(records)) return res.status(400).json({ error: "canonical records[] required" });
    const ent = entity || ((records[0] && Object.keys(records[0].values || {})[0]) || "").split(".")[0];

    const analyzers = registry.analyzersFor(ent);
    if (!analyzers.length) {
      return res.json({ entity: ent, analyzers: [], tickets: [], summary: null, note: "no analyzer registered for this entity" });
    }
    const findings = analyzers.flatMap((a) => a.run(records));
    const list = ticketsMod.assemble(findings, {});
    res.json({
      entity: ent,
      analyzers: analyzers.map((a) => a.id),
      summary: ticketsMod.summarize(list),
      tickets: list,
    });
  } catch (e) {
    res.status(500).json({ error: "analyze failed", detail: String((e && e.message) || e) });
  }
});

module.exports = { analyze };
