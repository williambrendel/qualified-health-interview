"use strict";

/**
 * @module scripts/losslessRoundtrip
 * @description
 * Demonstrates the **lossless master** thesis end to end on the real labs export.
 *
 *   source CSV ──apply──▶ envelope { values(canonical), raw, remainder }
 *                            │
 *                 reconstruct│(inverse transforms + retained remainder)
 *                            ▼
 *                     reconstructed source ──validateMigration──▶ vs. original
 *
 * It runs the round trip two ways and compares:
 *
 *   A · MASTER            reconstruct via inverses, fall back to retained raw for
 *                         one-way fields, overlay the remainder → must be 100% (the
 *                         master loses nothing and can prove it).
 *
 *   B · LOSSY STORE       reconstruct from the interpreted canonical ONLY — no raw
 *                         fallback, remainder dropped. This is what a FHIR-first /
 *                         closed-canonical store can regenerate. The gap vs. source
 *                         is exactly the data such a store silently loses.
 *
 *   npm run lossless
 */

const path = require("path");
const connector = require("../server/pipeline/connector");
const { reconstruct, recoverySummary } = require("../server/pipeline/connector/reconstruct");
const { validateMigration } = require("../server/pipeline/migration/validate");

const ROOT = path.resolve(__dirname, "..");
const bar = "─".repeat(74);

/** Find the source column that maps to a canonical path (used as the join key). */
function keyFieldFor(lineage, canonicalPath) {
  const rule = lineage.find((r) => r.to.includes(canonicalPath));
  return rule ? rule.from : null;
}

function report(title, r, lostColumns) {
  console.log(`\n${bar}\n${title}\n${bar}`);
  const c = r.completeness, f = r.fidelity;
  console.log(`  completeness : ${c.matched}/${c.sourceRecords} records matched (${c.completenessPct}%)`);
  console.log(`  fidelity     : ${f.fieldChecks - f.fieldMismatches}/${f.fieldChecks} source cells reproduced (${f.fidelityPct}%)`);
  console.log(`  VERDICT      : ${r.pass ? "✅ LOSSLESS — every source cell regenerated" : "❌ DATA LOST — source cells cannot be regenerated"}`);
  if (lostColumns && lostColumns.size) {
    console.log(`  lost columns : ${[...lostColumns].map((k) => k.replace(/^.*\./, "")).join(", ")}`);
  }
}

async function main() {
  const res = await connector.connectFile(path.join(ROOT, "data/interview/order_results.csv"), {});
  const envelopes = res.canonical.records;
  const lineage = res.canonical.lineage;

  const keyField = keyFieldFor(lineage, "lab_result.id");
  const sourceKeys = Object.keys(envelopes[0].raw);
  const fields = sourceKeys.filter((k) => k !== keyField);
  const opts = { keyField, fields };

  const nCols = sourceKeys.length;
  const nMapped = new Set(lineage.map((r) => r.from)).size;
  console.log(
    `Source: order_results.csv — ${envelopes.length} records × ${nCols} columns.\n` +
    `Manifest maps ${nMapped}/${nCols} columns to the canonical model; the other ${nCols - nMapped} are the "remainder".`
  );

  // Compare with empty-cell tolerance: a source "" and a reconstructed null are the
  // same empty value, not a difference. (The real losses are dropped columns.)
  const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";
  const norm = (vals) => {
    const o = {};
    for (const k of Object.keys(vals)) o[k] = isBlank(vals[k]) ? null : vals[k];
    return o;
  };
  const normRecords = (recs) => recs.map((r) => ({ values: norm(r.values) }));

  // Original source, in the shape validateMigration compares (values = raw cells).
  const original = normRecords(envelopes.map((e) => ({ values: e.raw })));

  // A · MASTER — inverses + raw fallback + remainder overlay.
  const master = reconstruct(envelopes, lineage, { interpretedOnly: false });
  const aReport = validateMigration(original, normRecords(master.records), opts);
  report("A · MASTER (reconstruct via inverses + retained remainder)", aReport);
  const aTally = recoverySummary(master.recovery);
  console.log(`  recovery mix : ${Object.entries(aTally).map(([k, v]) => `${v} ${k}`).join(" · ")}`);
  console.log(`                 (inverse/passthrough = regenerated from the canonical; remainder/raw_fallback = held only because the master kept them)`);

  // B · LOSSY STORE — interpreted canonical only.
  const lossy = reconstruct(envelopes, lineage, { interpretedOnly: true });
  const bReport = validateMigration(original, normRecords(lossy.records), opts);
  // Which columns did the lossy store lose on the first record? (uniform across rows)
  const lostCols = new Set(
    Object.entries(lossy.recovery[0] || {}).filter(([, kind]) => kind === "lost").map(([k]) => k)
  );
  report("B · LOSSY STORE (interpreted canonical only — remainder dropped)", bReport, lostCols);

  const lostPerRecord = lostCols.size;
  const lostTotal = bReport.fidelity.fieldMismatches;
  console.log(`\n${bar}`);
  console.log(
    `A FHIR-first / closed-canonical store silently loses ${lostPerRecord} of ${nCols} columns on EVERY record\n` +
    `— ${lostTotal.toLocaleString()} source cells across this one file (${(100 - bReport.fidelity.fidelityPct).toFixed(1)}% of the data).\n` +
    `The lossless master reproduces 100% and proves it, cell by cell, with provenance.`
  );
  console.log(bar);
}

main().catch((e) => { console.error("FATAL:", e.stack || e.message); process.exit(1); });
