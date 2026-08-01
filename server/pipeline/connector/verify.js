"use strict";

/**
 * @module pipeline/connector/verify
 * @description
 * Confidence gate for an AI-proposed mapping. It does not trust that the manifest
 * is right — it *proves* three properties and reports them, so a fresh induction on
 * a new/renamed schema can be trusted without eyeballing every field:
 *
 * 1. **Coverage** — every source column is accounted for (mapped or explicitly
 *    dropped). Catches a column silently forgotten by the model.
 * 2. **Round-trip** — for each mapped field, reconstruct the source value from the
 *    canonical value via the transform's declared `inverse`/`check` and compare.
 *    Proves the forward mapping is lossless up to the transform's declared
 *    semantics; a real corruption shows up as a mismatch. Runs over a sample.
 * 3. **Type-plausibility** — each mapped value satisfies its canonical path's
 *    declared type (a value in `patient.birth_date` parses as a date, etc.).
 *    Catches coarse transform mistakes a round-trip can miss.
 *
 * What it deliberately does NOT claim: semantic correctness of a same-type mapping
 * (first-name vs last-name). That is low-risk with descriptive headers and is
 * backstopped by human review of the manifest.
 */

const canonical = require("./canonical");
const transforms = require("./transforms");

/** Evenly-spaced (deterministic) sample of indices from [0, n). */
function sampleIndices(n, k) {
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  const stride = n / k;
  const idx = [];
  for (let i = 0; i < k; i++) idx.push(Math.floor(i * stride));
  return idx;
}

/** Resolve a manifest `from` to the real ingest key (bare ↔ namespaced). */
function makeResolve(record) {
  const keys = record ? Object.keys(record.values) : [];
  const full = new Set(keys);
  const bare = {};
  for (const k of keys) {
    const b = k.includes(".") ? k.slice(k.lastIndexOf(".") + 1) : k;
    if (!(b in bare)) bare[b] = k;
  }
  return (from) => {
    if (from == null) return null;
    if (full.has(from)) return from;
    const sfx = keys.filter((k) => k.endsWith("." + from));
    if (sfx.length === 1) return sfx[0];
    const b = from.includes(".") ? from.slice(from.lastIndexOf(".") + 1) : from;
    return bare[b] || bare[from] || (sfx.length ? sfx[0] : null);
  };
}

const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";

/** Type-plausibility for a single value against a canonical path's declared type. */
function typeOk(path, value) {
  if (value === null || value === undefined) return true;
  const type = canonical.typeOf(path);
  switch (type) {
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "date": return typeof value === "string" && /^\d{4}(-\d{2}-\d{2})?/.test(value.trim());
    case "string": return true;
    default: return true;
  }
}

/**
 * @param {{header:string[], records:Array}} ingested
 * @param {object} manifest - A validated manifest.
 * @param {Array<{values:Object}>} applied - Canonical records aligned with ingested.records.
 * @param {object} [opts]
 * @param {number} [opts.sampleSize=100] - Rows sampled for round-trip + type checks.
 * @returns {object} report
 */
function verifyMapping(ingested, manifest, applied, opts = {}) {
  const sampleSize = opts.sampleSize || 100;
  const records = ingested.records;
  const resolve = makeResolve(records[0]);

  // ---- 1. Coverage -------------------------------------------------------
  const referenced = new Set();
  for (const f of manifest.fields) {
    const key = resolve(f.from);
    if (key) referenced.add(key);
  }
  const allKeys = records[0] ? Object.keys(records[0].values) : [];
  const unaccounted = allKeys.filter((k) => !referenced.has(k));
  const coverage = {
    sourceColumns: allKeys.length,
    accounted: allKeys.length - unaccounted.length,
    unaccounted,
    ratio: allKeys.length ? (allKeys.length - unaccounted.length) / allKeys.length : 1,
  };

  // ---- 2 & 3. Round-trip + type-plausibility over a sample ---------------
  const idx = sampleIndices(records.length, sampleSize);
  const mappedFields = manifest.fields.filter(
    (f) => (f.to != null) || (Array.isArray(f.emits) && f.emits.length)
  );

  const fieldReports = mappedFields.map((f) => {
    const key = resolve(f.from);
    const emits = Array.isArray(f.emits) && f.emits.length ? f.emits : null;
    const c = f.transform ? transforms.contract(f.transform) : null;
    const revClass = f.transform ? (c ? c.rev : "unknown") : "passthrough";

    let checked = 0, mismatches = [], typeViolations = [];

    for (const i of idx) {
      const raw = key ? records[i].values[key] : null;
      const out = emits ? emits.map((p) => applied[i].values[p]) : applied[i].values[f.to];
      checked++;

      // round-trip / equivalence
      let ok = true;
      if (f.transform && c) {
        ok = c.check(raw, out);
      } else if (!f.transform) {
        // passthrough: blank normalizes to null
        const norm = isBlank(raw) ? null : raw;
        ok = emits ? emits.every((p) => applied[i].values[p] === norm) : out === norm;
      }
      if (!ok && mismatches.length < 5) mismatches.push({ recordIndex: i, raw, out });

      // type-plausibility
      const paths = emits || [f.to];
      const vals = emits ? out : [out];
      paths.forEach((p, j) => {
        if (!typeOk(p, vals[j]) && typeViolations.length < 5)
          typeViolations.push({ recordIndex: i, path: p, value: vals[j], expected: canonical.typeOf(p) });
      });
    }

    return {
      from: f.from,
      to: emits || f.to,
      transform: f.transform || null,
      revClass,
      resolved: key !== null,
      sampled: checked,
      roundTripOk: mismatches.length === 0,
      mismatches,
      typeOk: typeViolations.length === 0,
      typeViolations,
    };
  });

  const lossFields = fieldReports.filter((r) => !r.roundTripOk);
  const typeFields = fieldReports.filter((r) => !r.typeOk);

  return {
    sampledRows: idx.length,
    totalRows: records.length,
    coverage,
    fields: fieldReports,
    summary: {
      coverageComplete: unaccounted.length === 0,
      roundTripClean: lossFields.length === 0,
      typesPlausible: typeFields.length === 0,
      lossFields: lossFields.map((r) => r.from),
      typeViolationFields: typeFields.map((r) => r.from),
      byClass: fieldReports.reduce((m, r) => ((m[r.revClass] = (m[r.revClass] || 0) + 1), m), {}),
    },
    // Overall pass = nothing corrupted and nothing implausibly typed. Coverage is
    // reported but not fatal (dropping columns can be legitimate).
    pass: lossFields.length === 0 && typeFields.length === 0,
  };
}

module.exports = { verifyMapping, typeOk, sampleIndices };
