"use strict";

/**
 * @module endpoints/publish
 * @description The output connector as a microservice:
 *
 *   POST /publish — tickets → target field-map → DRY RUN. A real push is a human-gated
 *                   action, so only the payloads that *would* be sent are returned.
 */

const { createEndpoint } = require("../core");
const { output } = require("./lib");

const publish = createEndpoint("post", "/publish", (req, res) => {
  try {
    const { tickets, fieldMap, target, dryRun } = req.body || {};
    if (!Array.isArray(tickets)) return res.status(400).json({ error: "tickets[] required" });
    res.json(output.publish(tickets, { fieldMap, target, dryRun }));
  } catch (e) {
    res.status(500).json({ error: "publish failed", detail: String((e && e.message) || e) });
  }
});

module.exports = { publish };
