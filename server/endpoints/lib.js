"use strict";

/**
 * @module endpoints/lib
 * @description Shared wiring for the endpoint modules — data locations, the pipeline
 * modules, and a couple of small helpers. Each endpoint file requires what it needs
 * from here and from `../core` (for {@link createEndpoint}).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(ROOT, "data/interview");
const PUBLIC_DIR = path.join(ROOT, "client/public");
const ANALYTES = require(path.join(ROOT, "config/clinical/analytes.json"));

const ingest = require("../pipeline/ingest");
const connector = require("../pipeline/connector");
const { triage } = require("../pipeline/checks/abnormalResult");
const ticketsMod = require("../pipeline/tickets");
const output = require("../pipeline/output");
const { buildTickets } = require("../pipeline/buildTickets");

/** List the ingestable CSV files in the interview dataset. */
function listSources() {
  return fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".csv")).sort();
}

/** Resolve a user-supplied file name to a safe path inside the dataset (no traversal). */
function safeDataPath(name) {
  if (!name) return null;
  const base = path.basename(String(name));
  if (!base.endsWith(".csv")) return null;
  const abs = path.join(DATA_DIR, base);
  return fs.existsSync(abs) ? abs : null;
}

/** All-in-one convenience used by the drag-and-drop demo: ingest → connect → (labs) triage → tickets. */
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

module.exports = {
  ROOT, DATA_DIR, PUBLIC_DIR, ANALYTES,
  ingest, connector, triage, ticketsMod, output, buildTickets,
  listSources, safeDataPath, analyzeUpload,
};
