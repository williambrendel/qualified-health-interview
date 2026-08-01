"use strict";

/**
 * @module pipeline/connector
 * @description
 * The AI input connector, end to end:
 *
 *   ingest → (cached manifest? load : induce via LLM) → validate → apply → canonical records
 *
 * A manifest is induced **once** and cached to `config/mapping.<source>.json` — a
 * plain, human-reviewable JSON artifact. After that, runs are fully deterministic
 * and make **zero network calls**, which is exactly what the live demo needs. Force
 * a fresh induction with `{ forceInduce: true }`.
 *
 * The manifest is only applied if it *passes validation*; an invalid manifest is
 * returned with its errors and nothing is written or applied.
 */

const fs = require("fs");
const path = require("path");
const ingest = require("../ingest");
const { induceManifest } = require("./induce");
const { validateManifest } = require("./validate");
const { applyManifest } = require("./apply");
const { verifyMapping, collectFailures } = require("./verify");

const CONFIG_DIR = path.resolve(__dirname, "../../../config");

/** Resolve the cache path for a source's manifest. */
function manifestPath(source) {
  const base = String(source).replace(/\.[^.]+$/, "");
  return path.join(CONFIG_DIR, `mapping.${base}.json`);
}

/**
 * Connect already-ingested records (no file IO) — the unit useful for tests.
 *
 * @param {{source:string, header:string[], records:Array, anomalies?:Array, meta?:object}} ingested
 * @param {object} [opts]
 * @param {boolean} [opts.forceInduce=false] - Ignore any cached manifest.
 * @param {boolean} [opts.write=true]        - Persist a freshly-induced valid manifest.
 * @param {Function} [opts.runLLM]           - Injected LLM runner (see induce).
 * @param {object}  [opts.config]            - Model config override.
 * @returns {Promise<object>}
 */
async function connectRecords(ingested, opts = {}) {
  const source = ingested.source;
  const cachePath = manifestPath(source);

  let manifest = null;
  let cached = false;
  let llmUsed = false;

  if (opts.manifest) {
    manifest = opts.manifest; // supplied manifest → LLM bypassed entirely (deterministic load)
  } else if (!opts.forceInduce && fs.existsSync(cachePath)) {
    manifest = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    cached = true;
  } else {
    const induced = await induceManifest(ingested, opts);
    manifest = induced.manifest;
    llmUsed = true;
  }

  const validation = validateManifest(manifest);

  let canonical = { records: [], anomalies: [] };
  let verification = null;
  if (validation.valid) {
    canonical = applyManifest(ingested.records, manifest);
    verification = verifyMapping(ingested, manifest, canonical.records, {
      sampleSize: opts.sampleSize,
    });
    // Persist only freshly-induced manifests (never a supplied one, never a cache reload).
    if (llmUsed && opts.write !== false) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(manifest, null, 2) + "\n");
    }
  }

  return {
    source,
    cached,
    llmUsed,
    manifest,
    validation,
    verification,
    ingest: { meta: ingested.meta, header: ingested.header, anomalies: ingested.anomalies || [] },
    canonical,
    manifestPath: cachePath,
  };
}

/** Validate → apply → verify a manifest against the (full) ingested records. */
function applyAndVerify(ingested, manifest, sampleSize) {
  const validation = validateManifest(manifest);
  if (!validation.valid) return { validation, canonical: { records: [], anomalies: [] }, verification: null };
  const canonical = applyManifest(ingested.records, manifest);
  const verification = verifyMapping(ingested, manifest, canonical.records, { sampleSize });
  return { validation, canonical, verification };
}

/**
 * The **production loader**: apply a manifest to the FULL dataset, verify every row,
 * and if an *induced* manifest fails, **re-induce with targeted feedback** — the
 * specific fields that failed, with reasons and example rows — so the model repairs
 * only what broke rather than re-rolling blindly. Loops up to `maxRepairs` times.
 *
 * A *supplied* manifest is applied verbatim and never repaired (it's the caller's
 * contract). Only a freshly-passing induced manifest is persisted.
 *
 * @param {object} ingested
 * @param {object} [opts] - connect opts plus:
 * @param {object}  [opts.manifest]        - supplied manifest → deterministic, no repair.
 * @param {number}  [opts.maxRepairs=2]    - max targeted re-inductions after the first attempt.
 * @returns {Promise<object>} connect result + `repair: { attempts, repaired, log }`.
 */
async function loadWithRepair(ingested, opts = {}) {
  const source = ingested.source;
  const cachePath = manifestPath(source);
  const full = ingested.records.length;
  const maxRepairs = opts.maxRepairs ?? 2;
  const repairLog = [];

  let manifest;
  let cached = false;
  let llmUsed = false;
  if (opts.manifest) manifest = opts.manifest;
  else if (!opts.forceInduce && fs.existsSync(cachePath)) { manifest = JSON.parse(fs.readFileSync(cachePath, "utf8")); cached = true; }
  else { manifest = (await induceManifest(ingested, opts)).manifest; llmUsed = true; }

  let { validation, canonical, verification } = applyAndVerify(ingested, manifest, full);

  let repairs = 0;
  while (!opts.manifest && validation.valid && verification && !verification.pass && repairs < maxRepairs) {
    repairs++;
    const failures = collectFailures(verification, canonical.anomalies);
    repairLog.push({ attempt: repairs, fields: failures.map((f) => f.from), reasons: [...new Set(failures.map((f) => f.reason))] });
    manifest = (await induceManifest(ingested, {
      runLLM: opts.runLLM, config: opts.config, parse: opts.parse,
      feedback: { priorManifest: manifest, failures },
    })).manifest;
    llmUsed = true;
    ({ validation, canonical, verification } = applyAndVerify(ingested, manifest, full));
  }

  const passed = validation.valid && verification && verification.pass;
  if (llmUsed && passed && !opts.manifest && opts.write !== false) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(manifest, null, 2) + "\n");
  }

  return {
    source, cached, llmUsed, manifest, validation, verification,
    ingest: { meta: ingested.meta, header: ingested.header, anomalies: ingested.anomalies || [] },
    canonical,
    manifestPath: cachePath,
    repair: { attempts: repairs, repaired: repairs > 0 && passed, log: repairLog },
  };
}

/**
 * Connect a source file from disk.
 * @param {string} filePath
 * @param {object} [opts] - Same as {@link connectRecords}.
 * @returns {Promise<object>}
 */
async function connectFile(filePath, opts = {}) {
  const ingested = ingest.ingestFile(filePath);
  return connectRecords(ingested, opts);
}

module.exports = {
  connectFile, connectRecords, loadWithRepair, manifestPath, CONFIG_DIR,
  induceManifest, validateManifest, applyManifest, verifyMapping, collectFailures,
};
