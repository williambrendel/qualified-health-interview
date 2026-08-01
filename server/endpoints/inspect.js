"use strict";

/**
 * @module endpoints/inspect
 * @description Read-only pipeline-inspection endpoints over the bundled dataset:
 *   GET /api/sources   — list ingestable files
 *   GET /api/ingest    — sniff → repair → flatten to source path→value
 *   GET /api/manifest  — induced/cached mapping manifest + verification
 *   GET /api/canonical — manifest applied → records on the canonical model
 */

const path = require("path");
const { createEndpoint } = require("../core");
const { ingest, connector, listSources, safeDataPath } = require("./lib");
const { ingestFile } = ingest;

const sources = createEndpoint("get", "/api/sources", (_req, res) =>
  res.json({ dataDir: "data/interview/", sources: listSources() })
);

const ingestEndpoint = createEndpoint("get", "/api/ingest", (req, res) => {
  const abs = safeDataPath(req.query.file);
  if (!abs) return res.status(400).json({ error: "unknown or invalid file", hint: "pass ?file=<name>.csv from /api/sources", sources: listSources() });
  const limit = Math.max(0, Math.min(Number(req.query.limit) || 5, 500));
  const { records, header, anomalies, meta } = ingestFile(abs);
  res.json({ meta, header, anomalyCount: anomalies.length, anomalies: anomalies.slice(0, 20), recordsShown: Math.min(limit, records.length), records: records.slice(0, limit) });
});

const manifest = createEndpoint("get", "/api/manifest", async (req, res) => {
  const abs = safeDataPath(req.query.file);
  if (!abs) return res.status(400).json({ error: "unknown or invalid file", sources: listSources() });
  try {
    const r = await connector.connectFile(abs, { forceInduce: req.query.fresh === "1" });
    res.json({
      source: r.source, cached: r.cached,
      manifestPath: path.relative(process.cwd(), r.manifestPath),
      validation: r.validation,
      verification: r.verification && { pass: r.verification.pass, summary: r.verification.summary, coverage: r.verification.coverage, sampledRows: r.verification.sampledRows, totalRows: r.verification.totalRows, fields: r.verification.fields },
      manifest: r.manifest,
    });
  } catch (e) {
    res.status(502).json({ error: "induction failed", detail: String((e && e.message) || e) });
  }
});

const canonical = createEndpoint("get", "/api/canonical", async (req, res) => {
  const abs = safeDataPath(req.query.file);
  if (!abs) return res.status(400).json({ error: "unknown or invalid file", sources: listSources() });
  const limit = Math.max(0, Math.min(Number(req.query.limit) || 5, 500));
  try {
    const r = await connector.connectFile(abs, { forceInduce: req.query.fresh === "1" });
    if (!r.validation.valid) return res.status(422).json({ source: r.source, validation: r.validation, manifest: r.manifest });
    res.json({
      source: r.source, entity: r.manifest.entity, cached: r.cached,
      mappedPaths: r.validation.mapped, droppedColumns: r.validation.dropped,
      applyAnomalyCount: r.canonical.anomalies.length,
      recordsShown: Math.min(limit, r.canonical.records.length),
      records: r.canonical.records.slice(0, limit),
    });
  } catch (e) {
    res.status(502).json({ error: "connect failed", detail: String((e && e.message) || e) });
  }
});

module.exports = { sources, ingest: ingestEndpoint, manifest, canonical };
