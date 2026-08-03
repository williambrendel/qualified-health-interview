"use strict";

/**
 * @module endpoints/analyze
 * @description The application layer as a microservice, dispatched through the
 * analyzer registry over a canonical dataset:
 *
 *   POST /analyze
 *     { entity, records }              — a single entity's canonical records, or
 *     { dataset: { entity: records } } — a multi-entity canonical dataset
 *
 * Runs EVERY registered analyzer whose required entities are present and unions their
 * findings into tickets. Analyzers whose entities aren't present simply don't fire —
 * so a single-entity call runs only the single-entity analyzers, and a full dataset
 * additionally runs the multi-entity ones (care-gap, med-recon).
 */

const { createEndpoint } = require("../core");
const { ticketsMod } = require("./lib");
require("../pipeline/analyzers"); // registers all analyzers on load
const registry = require("../pipeline/analyzers/registry");

const analyze = createEndpoint("post", "/analyze", async (req, res) => {
  try {
    const { entity, records, dataset } = req.body || {};

    let ds;
    if (dataset && typeof dataset === "object" && !Array.isArray(dataset)) {
      ds = dataset;
    } else if (Array.isArray(records)) {
      const ent = entity || ((records[0] && Object.keys(records[0].values || {})[0]) || "").split(".")[0];
      ds = { [ent]: records };
    } else {
      return res.status(400).json({ error: "provide records[] (single entity) or dataset { entity: records[] }" });
    }

    const applied = registry.applicable(ds).map((a) => a.id);
    const findings = await registry.runAll(ds);
    const list = ticketsMod.assemble(findings, {});
    res.json({
      entities: Object.keys(ds),
      analyzers: applied,
      summary: ticketsMod.summarize(list),
      tickets: list,
    });
  } catch (e) {
    res.status(500).json({ error: "analyze failed", detail: String((e && e.message) || e) });
  }
});

module.exports = { analyze };
