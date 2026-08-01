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
const { verifyMapping } = require("./verify");

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
  connectFile, connectRecords, manifestPath, CONFIG_DIR,
  induceManifest, validateManifest, applyManifest, verifyMapping,
};
