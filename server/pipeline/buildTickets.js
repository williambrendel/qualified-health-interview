"use strict";

/**
 * @module pipeline/buildTickets
 * @description
 * End-to-end ticket build for the abnormal-result triage checker:
 *
 *   connect(order_results) → canonical lab_result
 *   connect(patient)       → patient index (for names/age/sex on the ticket)
 *   triage                 → clinical + data-quality findings
 *   assemble               → tickets (facts + provenance, hypothesis:null)
 *   cache                  → tickets.json   (so the running app is zero-network)
 *
 * Once `tickets.json` exists, the server serves it directly — the demo makes no
 * network calls. Rebuild explicitly with `{ rebuild: true }`.
 */

const fs = require("fs");
const path = require("path");
const connector = require("./connector");
const { triage } = require("./checks/abnormalResult");
const { careGaps } = require("./checks/careGap");
const { medRecon } = require("./checks/medRecon");
const tickets = require("./tickets");
const { generateHypothesis } = require("./hypothesis");

const ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(ROOT, "data");
const TICKETS_PATH = path.join(ROOT, "tickets.json");
const ANALYTES = require(path.join(ROOT, "config/clinical/analytes.json"));
const RULES = require(path.join(ROOT, "config/clinical/rules.json"));
const CARE_GAPS = require(path.join(ROOT, "config/clinical/care_gaps.json"));

/** Run `worker` over `items` with bounded concurrency. */
async function pool(items, concurrency, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

/**
 * Generate + verify advisory hypotheses for the selected tickets (mutates them),
 * caching the result into the ticket so the running server never calls the LLM.
 */
async function attachHypotheses(list, opts = {}) {
  const severities = opts.severities || ["critical"];
  const targets = list.filter((t) => t.queue !== "data-quality" && severities.includes(t.severity));
  const counts = { admitted: 0, rejected: 0, noRule: 0, error: 0 };
  await pool(targets, opts.concurrency || 6, async (t) => {
    try {
      const r = await generateHypothesis(t, { rules: RULES });
      if (r.admissible) { t.hypothesis = r.hypothesis; t.hypothesisStatus = "admitted"; counts.admitted++; }
      else if (r.noRule) { t.hypothesisStatus = "no-rule"; counts.noRule++; }
      else { t.hypothesisStatus = "rejected"; t.hypothesisRejectReasons = r.reasons; counts.rejected++; }
    } catch (e) {
      t.hypothesisStatus = "error"; t.hypothesisError = e.message; counts.error++;
    }
  });
  return counts;
}

/** Build a patientId → { name, age, sex } index from the canonical patient records. */
async function patientIndex() {
  try {
    const r = await connector.connectFile(path.join(DATA_DIR, "patient.csv"), {});
    const idx = {};
    for (const rec of r.canonical.records) {
      const v = rec.values;
      const id = v["patient.id"];
      if (!id) continue;
      const name = [v["patient.name.first"], v["patient.name.last"]].filter(Boolean).join(" ") || null;
      idx[id] = { name, age: v["patient.age"], sex: v["patient.sex"] };
    }
    return idx;
  } catch {
    return {}; // enrichment is best-effort; tickets still build without names
  }
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.rebuild=false] - Ignore a cached tickets.json and rebuild.
 * @param {boolean} [opts.write=true]    - Persist the built tickets to tickets.json.
 * @returns {Promise<{tickets: object[], summary: object, cached: boolean}>}
 */
async function buildTickets(opts = {}) {
  if (!opts.rebuild && fs.existsSync(TICKETS_PATH)) {
    const cached = JSON.parse(fs.readFileSync(TICKETS_PATH, "utf8"));
    return { tickets: cached.tickets, summary: cached.summary, cached: true };
  }

  const [results, problems, orders] = await Promise.all([
    connector.connectFile(path.join(DATA_DIR, "order_results.csv"), {}),
    connector.connectFile(path.join(DATA_DIR, "problem_list.csv"), {}),
    connector.connectFile(path.join(DATA_DIR, "order_proc_awv.csv"), {}),
  ]);

  const findings = triage(results.canonical.records, { analytes: ANALYTES });
  const gap = careGaps(
    {
      problems: problems.canonical.records,
      labResults: results.canonical.records,
      labOrders: orders.canonical.records,
    },
    { careGaps: CARE_GAPS }
  );

  // Med reconciliation (LLM-forward) — only when requested (networked).
  let medReconFindings = [];
  let medReconStats = null;
  if (opts.medRecon) {
    const [notesR, medsR] = await Promise.all([
      connector.connectFile(path.join(DATA_DIR, "hno_info.csv"), {}),
      connector.connectFile(path.join(DATA_DIR, "order_med.csv"), {}),
    ]);
    const mr = await medRecon(
      { notes: notesR.canonical.records, medOrders: medsR.canonical.records },
      opts.medRecon === true ? {} : opts.medRecon
    );
    medReconFindings = mr.findings;
    medReconStats = mr.stats;
  }

  const patients = await patientIndex();
  const list = tickets.assemble(
    { ...findings, careGaps: gap.findings, medRecon: medReconFindings },
    { patients }
  );

  let hypothesisCounts = null;
  if (opts.hypotheses) {
    hypothesisCounts = await attachHypotheses(list, opts.hypotheses === true ? {} : opts.hypotheses);
  }

  const summary = {
    ...tickets.summarize(list),
    skipped: findings.skipped,
    careGaps: gap.stats,
    medRecon: medReconStats,
    hypotheses: hypothesisCounts,
  };

  if (opts.write !== false) {
    fs.writeFileSync(TICKETS_PATH, JSON.stringify({ summary, tickets: list }, null, 2) + "\n");
  }
  return { tickets: list, summary, cached: false };
}

module.exports = { buildTickets, TICKETS_PATH };
