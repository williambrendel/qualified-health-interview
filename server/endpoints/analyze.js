"use strict";

/**
 * @module endpoints/analyze
 * @description The application layer as a microservice:
 *
 *   POST /analyze — canonical records → tickets. Deterministic; no LLM. Runs
 *                   abnormal-result triage on `lab_result` records.
 */

const { createEndpoint } = require("../core");
const { triage, ticketsMod, ANALYTES } = require("./lib");

const analyze = createEndpoint("post", "/analyze", (req, res) => {
  try {
    const { entity, records } = req.body || {};
    if (!Array.isArray(records)) return res.status(400).json({ error: "canonical records[] required" });
    const ent = entity || ((records[0] && Object.keys(records[0].values || {})[0]) || "").split(".")[0];
    if (ent !== "lab_result") {
      return res.json({ entity: ent, tickets: [], summary: null, note: "this microservice runs abnormal-result triage on lab_result records" });
    }
    const findings = triage(records, { analytes: ANALYTES });
    const list = ticketsMod.assemble(findings, {});
    res.json({ entity: "lab_result", summary: { ...ticketsMod.summarize(list), skipped: findings.skipped }, tickets: list });
  } catch (e) {
    res.status(500).json({ error: "analyze failed", detail: String((e && e.message) || e) });
  }
});

module.exports = { analyze };
