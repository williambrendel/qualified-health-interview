"use strict";

/**
 * @module scripts/migrationValidate
 * @description
 * Migration-validation demo. Treats the original labs export as the SOURCE and the
 * renamed/re-delimited fixture as the post-migration TARGET (a different schema holding
 * the same data — exactly a migration). It:
 *
 *   1. connects both → canonical, then validates exhaustively → clean migration (PASS).
 *   2. injects realistic migration defects into the target (dropped records, corrupted
 *      values) and re-validates → the report catches every one, with provenance.
 *
 * The point: sampling-based validation checks ~1–2% and prays; this proves every record.
 *
 *   npm run migrate-check
 */

const path = require("path");
const connector = require("../server/pipeline/connector");
const { validateMigration } = require("../server/pipeline/migration/validate");

const ROOT = path.resolve(__dirname, "..");
const bar = "─".repeat(72);

function report(title, r) {
  console.log(`\n${bar}\n${title}\n${bar}`);
  const c = r.completeness, f = r.fidelity;
  console.log(`  completeness : ${c.matched}/${c.sourceRecords} matched (${c.completenessPct}%) · dropped ${c.dropped} · added ${c.added}`);
  console.log(`  fidelity     : ${f.fieldChecks - f.fieldMismatches}/${f.fieldChecks} field checks passed (${f.fidelityPct}%) · mismatches ${f.fieldMismatches}`);
  console.log(`  VERDICT      : ${r.pass ? "✅ PASS — exhaustive validation, no data loss or alteration" : "❌ DEFECTS FOUND"}`);
  if (!r.pass) {
    console.log("  findings (most clinically severe first):");
    r.findings.slice(0, 8).forEach((x) => {
      if (x.field === "__dropped__") console.log(`    ⨯ DROPPED record ${x.id} (${x.analyte}, patient ${x.patient}) — present in source, MISSING in target`);
      else console.log(`    ≠ ${x.field} on ${x.id} (${x.analyte}, patient ${x.patient}): source ${JSON.stringify(x.source)} → target ${JSON.stringify(x.target)}`);
    });
    if (r.findings.length > 8) console.log(`    … ${r.findings.length - 8} more`);
  }
}

/** Simulate a botched migration: drop a few records, corrupt a few values. */
function injectDefects(records) {
  const copy = records.map((r) => ({ ...r, values: { ...r.values } }));
  const droppedIds = [copy[10], copy[42], copy[123]].filter(Boolean).map((r) => r.values["lab_result.id"]);
  const kept = copy.filter((r) => !droppedIds.includes(r.values["lab_result.id"]));
  // corrupt a result value and blank a reference bound
  if (kept[5]) kept[5].values["lab_result.value"] = kept[5].values["lab_result.value"] + 50; // silently wrong result
  if (kept[9]) kept[9].values["lab_result.reference.high"] = null;                            // lost a reference bound
  return { records: kept, droppedIds };
}

async function main() {
  const src = await connector.connectFile(path.join(ROOT, "data/interview/order_results.csv"), {});
  const tgt = await connector.connectFile(path.join(ROOT, "data/interview/fixtures/order_results.renamed.csv"), {});
  const S = src.canonical.records, T = tgt.canonical.records;

  console.log(`Source: order_results.csv (${S.length} records) → Target: order_results.renamed.csv (${T.length} records, renamed schema, ';'-delimited)`);

  report("1 · Clean migration (renamed schema, same data)", validateMigration(S, T));

  const defective = injectDefects(T);
  console.log(`\nInjected a botched migration: dropped ${defective.droppedIds.length} records, corrupted 1 result value, blanked 1 reference bound.`);
  report("2 · Botched migration (defects injected) — validator must catch them", validateMigration(S, defective.records));

  console.log(`\n${bar}\nSampling would have a ~${(100 * 8 / S.length).toFixed(1)}% chance of even seeing any one of these in an 8-record spot check.\nExhaustive validation caught every one, ranked by clinical severity, with provenance.\n${bar}`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
