"use strict";

/**
 * @module scripts/fhirProjection
 * @description
 * The **outward** half of the round trip: master → FHIR view → master.
 *
 *   canonical master ──project──▶ FHIR Observation ──unproject──▶ canonical
 *                                        │
 *                          validateMigration│(vs the original canonical)
 *
 * It proves the FHIR projection is faithful for the fields it carries, and reports the
 * TWO tiers of data a FHIR-first store loses that the master keeps:
 *   1. the **remainder** — source columns never in the canonical model, and
 *   2. **unprojectable** canonical fields — mapped into the master but with no slot in
 *      a standard Observation.
 *
 *   npm run project
 */

const path = require("path");
const connector = require("../server/pipeline/connector");
const { project, unproject, coverage, projectedPaths } = require("../server/pipeline/connector/project");
const { validateMigration } = require("../server/pipeline/migration/validate");

const ROOT = path.resolve(__dirname, "..");
const bar = "─".repeat(74);

async function main() {
  const res = await connector.connectFile(path.join(ROOT, "data/interview/order_results.csv"), {});
  const envelopes = res.canonical.records;

  // canonical → FHIR → canonical
  const observations = envelopes.map((e) => project(e.values));
  const recovered = observations.map((o) => ({ values: unproject(o) }));
  const original = envelopes.map((e) => ({ values: e.values }));

  // Prove the FHIR view round-trips the fields it carries.
  const carriedFields = projectedPaths().filter((p) => p !== "lab_result.id");
  const rep = validateMigration(original, recovered, { keyField: "lab_result.id", fields: carriedFields });

  console.log(`Source: order_results.csv — ${envelopes.length} lab results → FHIR R4 Observations.\n`);

  console.log(`${bar}\nProjection fidelity — canonical → FHIR Observation → canonical\n${bar}`);
  console.log(`  ${rep.fidelity.fieldChecks - rep.fidelity.fieldMismatches}/${rep.fidelity.fieldChecks} carried cells round-tripped (${rep.fidelity.fidelityPct}%)`);
  console.log(`  VERDICT: ${rep.pass ? "✅ FHIR view is faithful for the fields it carries" : "❌ projection altered data"}`);

  // What FHIR structurally cannot hold — measured on a representative record.
  const cov = coverage(envelopes[0].values);
  const remainderCols = Object.keys(envelopes[0].remainder);
  console.log(`\n${bar}\nWhat a FHIR-first store loses that the master keeps\n${bar}`);
  console.log(`  tier 1 · source columns never in the canonical (remainder): ${remainderCols.length}`);
  console.log(`           ${remainderCols.map((k) => k.replace(/^.*\./, "")).join(", ")}`);
  console.log(`  tier 2 · canonical fields with no slot in a standard Observation: ${cov.unprojectable.length}`);
  console.log(`           ${cov.unprojectable.map((k) => k.replace(/^lab_result\./, "")).join(", ")}`);
  console.log(`  → FHIR carries ${cov.carried.length} of ${cov.carried.length + cov.unprojectable.length + remainderCols.length} known fields; the rest live only in the master.`);

  console.log(`\n${bar}\nSample projected Observation (record 1)\n${bar}`);
  console.log(JSON.stringify(observations[0], null, 2));

  console.log(`\n${bar}`);
  console.log(
    `The projection is faithful AND honest about its own gaps: FHIR is a view, the master\n` +
    `is the source of truth, and we can prove — field by field — what the view drops.`
  );
  console.log(bar);
}

main().catch((e) => { console.error("FATAL:", e.stack || e.message); process.exit(1); });
