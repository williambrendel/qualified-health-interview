"use strict";

/**
 * @module scripts/makeRenamedFixture
 * @description
 * Generates a *renamed-schema fixture*: the same lab-result data as
 * `data/order_results.csv`, but shaped like a different EHR's export — every column
 * renamed and the delimiter changed to `;`. The values are byte-for-byte identical;
 * only the *syntax* differs.
 *
 * This is the input to the data-agnosticism proof (`npm run agnostic-demo`): the AI
 * connector must re-induce a fresh mapping for this shape and produce the exact same
 * canonical records, so the downstream checkers run unchanged.
 *
 *   npm run make-fixture
 */

const fs = require("fs");
const path = require("path");
const csv = require("../server/pipeline/ingest/csv");

// original column → a plausibly-different EHR's column name
const RENAME = {
  RESULT_ID: "obs_id",
  ORDER_PROC_ID: "order_ref",
  PAT_ID: "patient_key",
  PAT_ENC_CSN_ID: "encounter_key",
  COMPONENT_ID: "analyte_code",
  COMPONENT_NAME: "analyte_name",
  LOINC_CODE: "loinc",
  ORD_NUM_VALUE: "result_num",
  RESULT_VALUE_TEXT: "result_text",
  RESULT_FLAG_C: "abnormal_flag",
  REFERENCE_UNIT: "units",
  REFERENCE_RANGE: "normal_range",
  REFERENCE_LOW: "low_limit",
  REFERENCE_HIGH: "high_limit",
  RESULT_DATE: "collected_on",
  RESULT_TIME: "collected_at",
  source_system: "src",
  source_observation_id: "src_obs",
  inserted_timestamp: "ingested_at",
  last_updated_timestamp: "updated_at",
};

const DELIM = ";";

function serialize(rows, delim) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /["\n\r]/.test(s) || s.includes(delim) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(delim)).join("\n") + "\n";
}

function main() {
  const root = path.resolve(__dirname, "..");
  const srcText = fs.readFileSync(path.join(root, "data/interview/order_results.csv"), "utf8");
  const rows = csv.parse(srcText);
  if (!rows.length) throw new Error("source is empty");

  rows[0] = rows[0].map((h) => RENAME[h] || h);
  const outDir = path.join(root, "data/interview/fixtures");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "order_results.renamed.csv");
  fs.writeFileSync(outPath, serialize(rows, DELIM));

  console.log(`wrote ${path.relative(root, outPath)}`);
  console.log(`  rows: ${rows.length - 1} · delimiter: ";" · columns renamed: ${Object.keys(RENAME).length}`);
  console.log(`  header: ${rows[0].slice(0, 8).join(" ; ")} ...`);
}

main();
