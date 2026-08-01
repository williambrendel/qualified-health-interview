"use strict";

/**
 * @module endpoints/connect
 * @description The input connector as two microservices:
 *
 *   POST /connect/discover  — schema discovery (LLM): induce a manifest and quick-check
 *                             it round-trips on a small random sample. The advisory step.
 *   POST /connect/load      — loader (deterministic): apply a manifest to the FULL dataset
 *                             and verify every row. Supply `manifest` to bypass the LLM;
 *                             omit it to auto-discover. An induced manifest that passes the
 *                             sample but fails on the full data is re-adjusted (re-induced
 *                             once); a supplied manifest is never silently changed.
 *
 * The canonical model is the contract between these and the downstream `/analyze`.
 */

const path = require("path");
const { createEndpoint } = require("../core");
const { ingest, connector } = require("./lib");

const discover = createEndpoint("post", "/connect/discover", async (req, res) => {
  try {
    const { filename, content } = req.body || {};
    if (typeof content !== "string" || !content.trim()) return res.status(400).json({ error: "no file content" });
    const source = path.basename(filename || "upload.csv");
    const ingested = ingest.ingestText(content, { source });
    const { manifest, usage } = await connector.induceManifest(ingested, {});
    const validation = connector.validateManifest(manifest);

    let sampleCheck = null;
    if (validation.valid) {
      const N = Math.min(25, ingested.records.length);
      const sample = { ...ingested, records: ingested.records.slice(0, N) };
      const applied = connector.applyManifest(sample.records, manifest);
      const v = connector.verifyMapping(sample, manifest, applied.records, { sampleSize: N });
      sampleCheck = {
        rowsChecked: N, pass: v.pass,
        coverageComplete: v.summary.coverageComplete,
        roundTripClean: v.summary.roundTripClean,
        typesPlausible: v.summary.typesPlausible,
      };
    }

    res.json({
      source,
      structure: { format: ingested.meta.format || "delimited", delimiter: ingested.meta.delimiter, columns: ingested.header.length, rows: ingested.meta.rowCount },
      entity: manifest && manifest.entity,
      manifest, validation, sampleCheck, usage,
    });
  } catch (e) {
    res.status(502).json({ error: "discovery failed", detail: String((e && e.message) || e) });
  }
});

const load = createEndpoint("post", "/connect/load", async (req, res) => {
  try {
    const { filename, content, manifest } = req.body || {};
    if (typeof content !== "string" || !content.trim()) return res.status(400).json({ error: "no file content" });
    const source = path.basename(filename || "upload.csv");
    const ingested = ingest.ingestText(content, { source });

    // Full-dataset load with targeted repair: an induced manifest that fails the full
    // verification is re-induced with the specific failing fields fed back (not re-rolled).
    const r = await connector.loadWithRepair(ingested, { manifest: manifest || undefined, write: false });
    if (!r.validation.valid) return res.status(422).json({ source, llmUsed: r.llmUsed, validation: r.validation, manifest: r.manifest, repair: r.repair });

    const limit = Math.max(0, Math.min(Number(req.body.limit) || 50, 5000));
    res.json({
      source, entity: r.manifest.entity, llmUsed: r.llmUsed, cached: r.cached,
      repair: r.repair, // { attempts, repaired, log:[{attempt, fields, reasons}] }
      manifest: r.manifest,
      verification: r.verification && { pass: r.verification.pass, summary: r.verification.summary, coverage: r.verification.coverage, sampledRows: r.verification.sampledRows, totalRows: r.verification.totalRows },
      canonical: { count: r.canonical.records.length, records: r.canonical.records.slice(0, limit) },
    });
  } catch (e) {
    res.status(502).json({ error: "load failed", detail: String((e && e.message) || e) });
  }
});

module.exports = { discover, load };
