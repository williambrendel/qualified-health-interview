"use strict";

/**
 * @module endpoints/upload
 * @description The drag-and-drop demo's all-in-one endpoint:
 *
 *   POST /api/analyze — { filename, content } → the full pipeline in one call
 *                       (ingest → connect → verify → triage → tickets).
 *
 * The three-stage microservices (`/connect/*`, `/analyze`, `/publish`) are the
 * composable version; this is the convenience wrapper the browser demo calls.
 */

const { createEndpoint } = require("../core");
const { analyzeUpload } = require("./lib");

const upload = createEndpoint("post", "/api/analyze", async (req, res) => {
  try {
    const { filename, content } = req.body || {};
    if (typeof content !== "string" || !content.trim()) return res.status(400).json({ error: "no file content received" });
    if (content.length > 8_000_000) return res.status(413).json({ error: "file too large for the demo (8MB max)" });
    res.json(await analyzeUpload(filename, content));
  } catch (e) {
    res.status(500).json({ error: "analysis failed", detail: String((e && e.message) || e) });
  }
});

module.exports = { upload };
