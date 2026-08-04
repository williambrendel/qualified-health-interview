"use strict";

/**
 * @module pipeline/connector/reconstruct
 * @description
 * The **reverse direction** of {@link module:pipeline/connector/apply}: given an
 * envelope (`{ values, raw, remainder }`) and the dataset `lineage`, regenerate the
 * original source record from the *interpreted* canonical layer — running each
 * transform's declared `inverse` — and overlay the retained `remainder`.
 *
 * This is what proves the master is lossless rather than merely forward-mapped:
 * `apply` goes source → canonical; `reconstruct` goes canonical → source; and
 * {@link module:pipeline/migration/validate} compares the round trip field-by-field.
 *
 * Two modes:
 *   - **default (lossless master):** reconstruct via `inverse`; where a transform is
 *     one-way / not faithfully invertible, fall back to the retained `raw` value; and
 *     overlay the `remainder` verbatim. Result reproduces the source exactly — the
 *     master loses nothing.
 *   - **`interpretedOnly` (what a lossy store keeps):** reconstruct *only* from the
 *     canonical via `inverse`, with **no** raw fallback and **no** remainder. This is
 *     what a FHIR-first / closed-canonical store can regenerate — and the gap between
 *     it and the source is exactly the data such a store silently drops.
 */

const transforms = require("./transforms");

const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";

/**
 * Does the reconstructed candidate reproduce the original source cell **exactly**?
 * For a lossless master this must be strict — `to_number` turning `"5.0"` into `5`
 * (reconstructing as `"5"`) is a *formatting* loss, so it is NOT faithful and must
 * fall back to the retained raw. Blank ≡ blank (`""` and `null` are the same empty).
 */
function faithful(candidate, original) {
  const cb = isBlank(candidate), ob = isBlank(original);
  if (cb && ob) return true;
  if (cb || ob) return false;
  return String(candidate) === String(original);
}

/**
 * Invert one lineage rule to the source string it came from.
 * @returns {{value:*, via:"inverse"|"passthrough"|"one_way"}}
 */
function invertRule(rule, values) {
  const outs = rule.to.map((p) => values[p]);

  if (!rule.transform) {
    // Pass-through: the canonical value IS the (trimmed) source value.
    return { value: outs[0], via: "passthrough" };
  }

  const contract = transforms.contract(rule.transform);
  if (!contract || typeof contract.inverse !== "function") {
    // No inverse declared → cannot regenerate from the interpreted layer alone.
    return { value: null, via: "one_way" };
  }

  const value = rule.multi ? contract.inverse(outs) : contract.inverse(outs[0]);
  // Reversible/equivalence transforms round-trip; "one-way" ones (lower/upper/to_boolean)
  // produce a normalized string that need not match the original casing/spelling.
  const via = contract.rev === "one-way" ? "one_way" : "inverse";
  return { value, via };
}

/**
 * Reconstruct a single envelope's source record.
 * @param {{values:Object, raw?:Object, remainder?:Object}} envelope
 * @param {Array<{from:string, transform:?string, to:string[], multi:boolean}>} lineage
 * @param {object} [opts]
 * @param {boolean} [opts.interpretedOnly=false] - simulate a lossy store (inverse only,
 *        no raw fallback, drop the remainder).
 * @returns {{values:Object, recovery:Object.<string,string>}}
 *   `values` is the reconstructed source (`sourceKey → value`); `recovery` records how
 *   each key was recovered: "inverse" | "passthrough" | "raw_fallback" | "remainder" | "lost".
 */
function reconstructRecord(envelope, lineage, opts = {}) {
  const interpretedOnly = !!opts.interpretedOnly;
  const raw = envelope.raw || {};
  const remainder = envelope.remainder || {};
  const out = {};
  const recovery = {};

  // 1) Invert the mapped columns from the interpreted canonical layer.
  for (const rule of lineage) {
    const { value, via } = invertRule(rule, envelope.values);
    const faithfulEnough = via !== "one_way" && faithful(value, raw[rule.from]);

    if (faithfulEnough) {
      out[rule.from] = value;
      recovery[rule.from] = via; // "inverse" | "passthrough"
    } else if (interpretedOnly) {
      // A lossy store has only the interpreted layer: a one-way/lossy field is gone
      // (or wrong). Record what the interpreted value alone would yield.
      out[rule.from] = value;
      recovery[rule.from] = "lost";
    } else {
      // The master retains the exact source — fall back to it. Never lossy.
      out[rule.from] = raw[rule.from];
      recovery[rule.from] = "raw_fallback";
    }
  }

  // 2) The remainder: columns the manifest never mapped. The master kept them; a
  //    lossy store dropped them.
  for (const k of Object.keys(remainder)) {
    if (interpretedOnly) {
      recovery[k] = "lost";
    } else {
      out[k] = remainder[k];
      recovery[k] = "remainder";
    }
  }

  return { values: out, recovery };
}

/**
 * Reconstruct a whole dataset of envelopes.
 * @returns {{records: Array<{values:Object}>, recovery: Array<Object>}}
 */
function reconstruct(envelopes, lineage, opts = {}) {
  const records = [];
  const recovery = [];
  for (const env of envelopes) {
    const r = reconstructRecord(env, lineage, opts);
    records.push({ values: r.values });
    recovery.push(r.recovery);
  }
  return { records, recovery };
}

/** Tally recovery kinds across a dataset (for the report). */
function recoverySummary(recoveryList) {
  const tally = {};
  for (const rec of recoveryList) {
    for (const kind of Object.values(rec)) tally[kind] = (tally[kind] || 0) + 1;
  }
  return tally;
}

module.exports = { reconstruct, reconstructRecord, recoverySummary, faithful };
