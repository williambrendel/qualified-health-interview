"use strict";

/**
 * @module server/serve
 * @description
 * `npm start` entry point. Boots the Express scaffold ({@link App}) on port 8080
 * and exposes the Day-1 surface: a landing page and two read-only endpoints that
 * run the deterministic ingest over the bundled dataset live. No tickets are built
 * yet (that arrives with the checkers); this proves the spine end-to-end —
 * `data/` on disk → sniff/repair/flatten → canonical `path → value` over HTTP.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const { App } = require("./core");
const ingest = require("./pipeline/ingest");
const { ingestFile } = ingest;
const connector = require("./pipeline/connector");
const { triage } = require("./pipeline/checks/abnormalResult");
const ticketsMod = require("./pipeline/tickets");
const { buildTickets } = require("./pipeline/buildTickets");

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data/interview");
const PUBLIC_DIR = path.join(ROOT, "client/public");
const ANALYTES = require(path.join(ROOT, "config/clinical/analytes.json"));

/** List the ingestable CSV files in data/. */
function listSources() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".csv"))
    .sort();
}

/** Resolve a user-supplied file name to a safe path inside data/ (no traversal). */
function safeDataPath(name) {
  if (!name) return null;
  const base = path.basename(String(name)); // strip any directory component
  if (!base.endsWith(".csv")) return null;
  const abs = path.join(DATA_DIR, base);
  return fs.existsSync(abs) ? abs : null;
}

/** Ingest raw uploaded text → connect → (if labs) triage → tickets. */
async function analyzeUpload(filename, content) {
  const source = path.basename(String(filename || "upload.csv"));
  const ingested = ingest.ingestText(content, { source });
  const r = await connector.connectRecords(ingested, { write: false });

  let ticketList = [];
  let ticketSummary = null;
  if (r.validation.valid && r.manifest && r.manifest.entity === "lab_result") {
    const findings = triage(r.canonical.records, { analytes: ANALYTES });
    ticketList = ticketsMod.assemble(findings, {});
    ticketSummary = { ...ticketsMod.summarize(ticketList), skipped: findings.skipped };
  }

  return {
    source,
    cached: r.cached,
    entity: (r.manifest && r.manifest.entity) || null,
    ingest: {
      delimiter: r.ingest.meta.delimiter,
      hasHeader: r.ingest.meta.hasHeader,
      columns: r.ingest.header.length,
      rows: r.ingest.meta.rowCount,
      structuralAnomalies: (r.ingest.anomalies || []).length,
    },
    validation: r.validation,
    verification: r.verification && {
      pass: r.verification.pass,
      summary: r.verification.summary,
      coverage: r.verification.coverage,
      sampledRows: r.verification.sampledRows,
      totalRows: r.verification.totalRows,
    },
    manifest: r.manifest,
    canonicalAnomalies: (r.canonical.anomalies || []).length,
    ticketSummary,
    tickets: ticketList.slice(0, 400),
  };
}

const endpoints = [
  {
    method: "post",
    route: "/api/analyze",
    process: async (req, res) => {
      try {
        const { filename, content } = req.body || {};
        if (typeof content !== "string" || !content.trim()) {
          return res.status(400).json({ error: "no file content received" });
        }
        if (content.length > 8_000_000) return res.status(413).json({ error: "file too large for the demo (8MB max)" });
        res.json(await analyzeUpload(filename, content));
      } catch (e) {
        res.status(500).json({ error: "analysis failed", detail: String((e && e.message) || e) });
      }
    },
  },

  {
    method: "get",
    route: "/api/sources",
    process: (_req, res) => res.json({ dataDir: "data/", sources: listSources() }),
  },

  {
    method: "get",
    route: "/api/ingest",
    process: (req, res) => {
      const abs = safeDataPath(req.query.file);
      if (!abs) {
        return res.status(400).json({
          error: "unknown or invalid file",
          hint: "pass ?file=<name>.csv from /api/sources",
          sources: listSources(),
        });
      }
      const limit = Math.max(0, Math.min(Number(req.query.limit) || 5, 500));
      const { records, header, anomalies, meta } = ingestFile(abs);
      res.json({
        meta,
        header,
        anomalyCount: anomalies.length,
        anomalies: anomalies.slice(0, 20),
        recordsShown: Math.min(limit, records.length),
        records: records.slice(0, limit),
      });
    },
  },

  {
    method: "get",
    route: "/api/manifest",
    process: async (req, res) => {
      const abs = safeDataPath(req.query.file);
      if (!abs) return res.status(400).json({ error: "unknown or invalid file", sources: listSources() });
      try {
        const r = await connector.connectFile(abs, { forceInduce: req.query.fresh === "1" });
        res.json({
          source: r.source,
          cached: r.cached,
          manifestPath: path.relative(process.cwd(), r.manifestPath),
          validation: r.validation,
          verification: r.verification && {
            pass: r.verification.pass,
            summary: r.verification.summary,
            coverage: r.verification.coverage,
            sampledRows: r.verification.sampledRows,
            totalRows: r.verification.totalRows,
            fields: r.verification.fields,
          },
          manifest: r.manifest,
        });
      } catch (e) {
        res.status(502).json({ error: "induction failed", detail: String(e && e.message || e) });
      }
    },
  },

  {
    method: "get",
    route: "/api/canonical",
    process: async (req, res) => {
      const abs = safeDataPath(req.query.file);
      if (!abs) return res.status(400).json({ error: "unknown or invalid file", sources: listSources() });
      const limit = Math.max(0, Math.min(Number(req.query.limit) || 5, 500));
      try {
        const r = await connector.connectFile(abs, { forceInduce: req.query.fresh === "1" });
        if (!r.validation.valid) {
          return res.status(422).json({ source: r.source, validation: r.validation, manifest: r.manifest });
        }
        res.json({
          source: r.source,
          entity: r.manifest.entity,
          cached: r.cached,
          mappedPaths: r.validation.mapped,
          droppedColumns: r.validation.dropped,
          applyAnomalyCount: r.canonical.anomalies.length,
          recordsShown: Math.min(limit, r.canonical.records.length),
          records: r.canonical.records.slice(0, limit),
        });
      } catch (e) {
        res.status(502).json({ error: "connect failed", detail: String(e && e.message || e) });
      }
    },
  },

  {
    method: "get",
    route: "/api/tickets",
    process: async (req, res) => {
      try {
        const { tickets, summary } = await buildTickets();
        let list = tickets;
        if (req.query.queue) list = list.filter((t) => t.queue === req.query.queue);
        if (req.query.severity) list = list.filter((t) => t.severity === req.query.severity);
        const limit = Math.max(0, Math.min(Number(req.query.limit) || 200, 2000));
        res.json({ summary, count: list.length, shown: Math.min(limit, list.length), tickets: list.slice(0, limit) });
      } catch (e) {
        res.status(500).json({ error: "ticket build failed", detail: String(e && e.message || e) });
      }
    },
  },

  {
    method: "get",
    route: "/tickets",
    process: (_req, res) => {
      try {
        res.type("html").send(fs.readFileSync(path.join(__dirname, "../client/tickets.html"), "utf8"));
      } catch (e) {
        res.status(500).send("tickets UI not found");
      }
    },
  },
];

const app = new App({
  middlewares: [
    express.json({ limit: "10mb" }),
    express.static(PUBLIC_DIR), // serves the drag-and-drop demo at "/" plus css/js/assets
  ],
  endpoints,
});
app.listen(PORT, () => console.log(`✅ Syntaxin listening on http://localhost:${PORT}`));
