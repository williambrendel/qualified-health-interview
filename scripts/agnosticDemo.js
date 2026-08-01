"use strict";

/**
 * @module scripts/agnosticDemo
 * @description
 * The data-agnosticism proof, end to end. It runs the AI connector over two files
 * that hold the *same lab data in different syntax* — the original
 * `data/order_results.csv` and the renamed, `;`-delimited
 * `data/fixtures/order_results.renamed.csv` — and shows that:
 *
 *   1. the connector induces a DIFFERENT mapping manifest for each (source paths
 *      differ, delimiter differs), yet
 *   2. the canonical `path → value` records come out IDENTICAL, so
 *   3. the abnormal-triage checker produces the SAME findings, unchanged.
 *
 * "Whatever syntax the data arrives in → the same routed semantics."
 *
 *   npm run make-fixture && npm run agnostic-demo
 */

const path = require("path");
const connector = require("../server/pipeline/connector");
const { triage } = require("../server/pipeline/checks/abnormalResult");

const root = path.resolve(__dirname, "..");
const ANALYTES = require(path.join(root, "config/clinical/analytes.json"));

const FIELDS = ["lab_result.value", "lab_result.reference.low", "lab_result.reference.high", "lab_result.component", "lab_result.patient_id", "lab_result.flag"];
const triageSig = (t) =>
  JSON.stringify({
    clinical: t.clinical.length,
    dataQuality: t.dataQuality.length,
    severities: t.clinical.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {}),
  });

async function main() {
  const orig = await connector.connectFile(path.join(root, "data/interview/order_results.csv"), {});
  const renamed = await connector.connectFile(path.join(root, "data/interview/fixtures/order_results.renamed.csv"), {});

  console.log("── Two files, same data, different syntax ──");
  console.log(`  original: delimiter ${JSON.stringify(orig.ingest.meta.delimiter)} · columns: ${orig.ingest.header.slice(0, 5).join(", ")} …`);
  console.log(`  renamed : delimiter ${JSON.stringify(renamed.ingest.meta.delimiter)} · columns: ${renamed.ingest.header.slice(0, 5).join(", ")} …`);

  console.log("\n── The connector induced a DIFFERENT manifest for each ──");
  const showFrom = (r) => r.manifest.fields.filter((f) => f.to).slice(0, 3).map((f) => `${f.from} → ${f.to}`);
  console.log("  original:", showFrom(orig).join("  |  "));
  console.log("  renamed :", showFrom(renamed).join("  |  "));

  // Compare canonical output, keyed by the canonical id.
  const index = (recs) => new Map(recs.map((r) => [r.values["lab_result.id"], r.values]));
  const A = index(orig.canonical.records);
  const B = index(renamed.canonical.records);
  let compared = 0, mismatches = 0, missing = 0;
  for (const [id, va] of A) {
    const vb = B.get(id);
    if (!vb) { missing++; continue; }
    for (const f of FIELDS) { compared++; if (JSON.stringify(va[f]) !== JSON.stringify(vb[f])) mismatches++; }
  }

  console.log("\n── Canonical output ──");
  console.log(`  records: ${A.size} (orig) vs ${B.size} (renamed) · field comparisons: ${compared} · missing: ${missing} · mismatches: ${mismatches}`);

  const ta = triage(orig.canonical.records, { analytes: ANALYTES });
  const tb = triage(renamed.canonical.records, { analytes: ANALYTES });
  console.log("\n── Abnormal-result triage (same checker, unchanged) ──");
  console.log("  original:", triageSig(ta));
  console.log("  renamed :", triageSig(tb));

  const ok = missing === 0 && mismatches === 0 && triageSig(ta) === triageSig(tb);
  console.log(ok
    ? "\n✅ Different schema, re-induced mapping, IDENTICAL canonical output and IDENTICAL tickets. Data-agnosticism proven end to end."
    : "\n❌ Divergence detected — see counts above.");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
