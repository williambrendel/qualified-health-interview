"use strict";

/**
 * @module pipeline/connector/sweep
 * @description
 * Runs the AI input connector + verifier over every file in `data/` and prints a
 * validation matrix. This is the repeatable, real-data proof that the offline unit
 * tests can't be (they stub the LLM): a single command that shows, per source,
 * whether the induced mapping validated, verified lossless, and covered its columns.
 *
 *   npm run sweep            # uses cached manifests → zero network
 *   npm run sweep -- --fresh # re-induce every mapping (live LLM)
 *   npm run sweep -- --json  # machine-readable
 *
 * Exits non-zero if any file fails validation or verification, so it doubles as a
 * gate.
 */

const fs = require("fs");
const path = require("path");
const connector = require("./index");

const DATA_DIR = path.resolve(__dirname, "../../../data/interview");

async function main(argv) {
  const args = argv.slice(2);
  const fresh = args.includes("--fresh");
  const asJson = args.includes("--json");

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".csv")).sort();
  const rows = [];

  for (const f of files) {
    try {
      const r = await connector.connectFile(path.join(DATA_DIR, f), { forceInduce: fresh });
      const v = r.verification;
      rows.push({
        file: f,
        entity: r.manifest && r.manifest.entity,
        valid: r.validation.valid,
        pass: v ? v.pass : null,
        coverage: v ? `${v.coverage.accounted}/${v.coverage.sourceColumns}` : null,
        roundTrip: v ? v.summary.roundTripClean : null,
        types: v ? v.summary.typesPlausible : null,
        mapped: r.validation.mapped.length,
        applyAnomalies: r.canonical.anomalies.length,
        errors: r.validation.errors,
        ok: r.validation.valid && (v ? v.pass : false),
      });
    } catch (e) {
      rows.push({ file: f, error: e.message, ok: false });
    }
  }

  const failures = rows.filter((r) => !r.ok);

  if (asJson) {
    console.log(JSON.stringify({ rows, failures: failures.map((f) => f.file) }, null, 2));
  } else {
    const H = ["file", "entity", "valid", "pass", "coverage", "roundTrip", "types", "mapped", "applyAnom"];
    const w = [22, 17, 6, 5, 8, 10, 6, 7, 10];
    const line = (cells) => cells.map((c, i) => String(c == null ? "-" : c).padEnd(w[i])).join(" ");
    console.log(line(H));
    console.log("-".repeat(w.reduce((a, b) => a + b + 1, 0)));
    for (const r of rows) {
      if (r.error) { console.log(String(r.file).padEnd(22), "ERROR:", r.error); continue; }
      console.log(line([r.file, r.entity, r.valid, r.pass, r.coverage, r.roundTrip, r.types, r.mapped, r.applyAnomalies]));
      if (!r.valid && r.errors && r.errors.length) console.log("    ↳ " + r.errors.slice(0, 3).join(" | "));
    }
    console.log("-".repeat(w.reduce((a, b) => a + b + 1, 0)));
    console.log(`${rows.length - failures.length}/${rows.length} passed` + (fresh ? " (fresh induction)" : " (cached)"));
    if (failures.length) console.log("FAILED: " + failures.map((f) => f.file).join(", "));
  }

  process.exit(failures.length ? 1 : 0);
}

main(process.argv).catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
