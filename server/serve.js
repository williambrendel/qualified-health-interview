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
const { App } = require("./core");
const { ingestFile } = require("./pipeline/ingest");
const connector = require("./pipeline/connector");
const { buildTickets } = require("./pipeline/buildTickets");

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = path.resolve(__dirname, "../data");

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

const LANDING = `<!DOCTYPE html>
<html lang="en-us"><head><meta charset="utf-8"><title>Syntaxin — Day 1</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:820px;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
code{background:#f2f2f2;padding:.1em .4em;border-radius:4px}a{color:#0b6}</style></head>
<body>
<h1>Syntaxin</h1>
<p><a href="/tickets" style="font-size:17px;font-weight:600">→ Open the review queue</a> — abnormal-result triage tickets over the synthetic dataset.</p>
<p>Or inspect the pipeline directly:</p>
<ul>
  <li><a href="/api/sources">/api/sources</a> — list ingestable files in <code>data/</code></li>
  <li><a href="/api/ingest?file=patient.csv&limit=3">/api/ingest?file=patient.csv&amp;limit=3</a> — sniff → repair → flatten to source <code>path → value</code></li>
  <li><a href="/api/manifest?file=patient.csv">/api/manifest?file=patient.csv</a> — AI input connector: induced (or cached) mapping manifest + validation</li>
  <li><a href="/api/canonical?file=patient.csv&limit=3">/api/canonical?file=patient.csv&amp;limit=3</a> — manifest applied → records on the canonical model</li>
  <li><a href="/healthcheck">/healthcheck</a></li>
</ul>
<p style="color:#888">Manifests cache to <code>config/mapping.*.json</code> — first call induces (LLM), later calls are zero-network. Next: checkers → tickets.</p>
</body></html>`;

const endpoints = [
  { method: "get", route: "/", process: (_req, res) => res.type("html").send(LANDING) },

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

new App({ endpoints }).listen(PORT, () =>
  console.log(`✅ Syntaxin (Day 1) listening on http://localhost:${PORT}`)
);
