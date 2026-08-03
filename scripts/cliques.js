"use strict";

/**
 * @module scripts/cliques
 * @description
 * Research probe: discover which lab analytes co-vary across patients, then group them
 * into coherent cliques with dominant sets (Pavan–Pelillo). This is the k-uplet
 * *suggester* run on real data — pairwise (polynomial) structure → higher-order groups,
 * without enumerating combinations.
 *
 *   npm run cliques          # over data/interview/order_results.csv (cached manifest → zero network)
 *
 * Pipeline: connect → canonical lab_result → pivot to patient × analyte → Pearson
 * correlations (support-gated) → affinity graph (|corr|) → dominant-set cliques.
 */

const path = require("path");
const connector = require("../server/pipeline/connector");
const { pearson, cliques, mean } = require("../server/pipeline/analyzers/correlation");

const MIN_SUPPORT = 12;     // min patients co-observed for a correlation to count
const EDGE_MIN = 0.30;      // |corr| below this → no edge
const ROOT = path.resolve(__dirname, "..");

/** patientId → { loinc → mean value }, plus loinc → label. */
function pivot(records) {
  const byPatient = new Map();
  const label = {};
  for (const r of records) {
    const v = r.values;
    const pid = v["lab_result.patient_id"], loinc = v["lab_result.loinc"], val = v["lab_result.value"];
    if (!pid || !loinc || typeof val !== "number" || !Number.isFinite(val)) continue;
    label[loinc] = v["lab_result.component"] || loinc;
    if (!byPatient.has(pid)) byPatient.set(pid, {});
    const cell = byPatient.get(pid);
    (cell[loinc] || (cell[loinc] = [])).push(val);
  }
  // collapse repeats to a mean per patient/analyte
  for (const cell of byPatient.values()) for (const k of Object.keys(cell)) cell[k] = mean(cell[k]);
  return { byPatient, label };
}

/** Pairwise correlations over analytes with enough co-observation. */
function correlations(byPatient, analytes) {
  const patients = [...byPatient.values()];
  const edges = [];
  for (let a = 0; a < analytes.length; a++) {
    for (let b = a + 1; b < analytes.length; b++) {
      const xs = [], ys = [];
      for (const p of patients) {
        if (p[analytes[a]] != null && p[analytes[b]] != null) { xs.push(p[analytes[a]]); ys.push(p[analytes[b]]); }
      }
      if (xs.length < MIN_SUPPORT) continue;
      const r = pearson(xs, ys);
      if (r == null) continue;
      edges.push({ a, b, r, support: xs.length });
    }
  }
  return edges;
}

async function main() {
  const r = await connector.connectFile(path.join(ROOT, "data/interview/order_results.csv"), {});
  const { byPatient, label } = pivot(r.canonical.records);
  const analytes = [...new Set(r.canonical.records.map((x) => x.values["lab_result.loinc"]).filter(Boolean))];

  const edges = correlations(byPatient, analytes);
  const A = analytes.map(() => analytes.map(() => 0));
  for (const e of edges) if (Math.abs(e.r) >= EDGE_MIN) { A[e.a][e.b] = Math.abs(e.r); A[e.b][e.a] = Math.abs(e.r); }

  console.log(`patients: ${byPatient.size} · analytes: ${analytes.length} · edges (|corr|≥${EDGE_MIN}, support≥${MIN_SUPPORT}): ${edges.filter(e => Math.abs(e.r) >= EDGE_MIN).length}`);

  console.log("\nstrongest relationships:");
  edges.slice().sort((x, y) => Math.abs(y.r) - Math.abs(x.r)).slice(0, 12).forEach((e) => {
    const sign = e.r >= 0 ? "＋" : "－";
    console.log(`  ${sign} r=${e.r.toFixed(2)} (n=${e.support})  ${label[analytes[e.a]]}  ⟷  ${label[analytes[e.b]]}`);
  });

  const groups = cliques(A);
  console.log("\ncohesive dominant-set cliques (co-varying analyte groups → candidate k-uplets):");
  if (!groups.length) console.log("  (none above threshold — weak pairwise structure)");
  groups.forEach((g, k) => {
    console.log(`  clique ${k + 1} (cohesion ${g.cohesion.toFixed(2)}): { ${g.members.map((i) => label[analytes[i]]).join(", ")} }`);
  });
  console.log("\nNOTE: these are CORRELATION-based candidates, not causal claims. They suggest");
  console.log("which analytes to analyze jointly; governed rules + a human decide meaning.");
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
