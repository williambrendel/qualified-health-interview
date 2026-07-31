"use strict";

/**
 * @module pipeline/ingest/cli
 * @description
 * Tiny CLI to eyeball the ingest over the real dataset:
 *
 *   npm run ingest -- data/patient.csv          # summary + first 3 records
 *   npm run ingest -- data/hno_info.csv --json  # full canonical records as JSON
 *
 * It exists so data judgment is demonstrable, not asserted: run it on any file in
 * `data/` and see exactly what was sniffed, what was repaired, and the canonical
 * `path → value` shape that comes out.
 */

const path = require("path");
const { ingestFile } = require("./index");

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes("--json");
  const file = args.find((a) => !a.startsWith("--"));

  if (!file) {
    console.error("usage: npm run ingest -- <file.csv> [--json]");
    process.exit(1);
  }

  const abs = path.resolve(process.cwd(), file);
  const { records, header, anomalies, meta } = ingestFile(abs);

  if (asJson) {
    console.log(JSON.stringify({ meta, header, anomalies, records }, null, 2));
    return;
  }

  console.log(`source        : ${path.basename(abs)}`);
  console.log(`delimiter     : ${JSON.stringify(meta.delimiter)}  (confidence ${meta.confidence.toFixed(2)})`);
  console.log(`header        : ${meta.hasHeader ? "yes" : "no (synthesized col0..colN)"}`);
  console.log(`columns       : ${header.length}`);
  console.log(`records       : ${meta.rowCount}`);
  console.log(`anomalies     : ${meta.anomalyCount}`);
  if (anomalies.length) {
    const byKind = anomalies.reduce((m, a) => ((m[a.kind] = (m[a.kind] || 0) + 1), m), {});
    console.log(`  by kind     : ${JSON.stringify(byKind)}`);
  }
  console.log(`\nfirst ${Math.min(3, records.length)} record(s) (path → value):`);
  for (const rec of records.slice(0, 3)) {
    console.log(`\n  #${rec.recordIndex}`);
    for (const [p, v] of rec.pairs.slice(0, 8)) {
      console.log(`    ${p.padEnd(34)} ${v === null ? "∅" : JSON.stringify(v)}`);
    }
    if (rec.pairs.length > 8) console.log(`    … ${rec.pairs.length - 8} more`);
  }
}

main(process.argv);
