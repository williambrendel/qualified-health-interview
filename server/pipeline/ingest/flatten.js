"use strict";

/**
 * @module pipeline/ingest/flatten
 * @description
 * Flattens repaired rows into the canonical shape the rest of the pipeline speaks:
 * a list of records, each a set of **`path → value`** pairs with hierarchical
 * dotted keys.
 *
 * On Day 1 there is no mapping manifest yet, so paths are *source-namespaced*:
 * `<namespace>.<COLUMN>` (e.g. `patient.PAT_ID`). Day 2's manifest re-maps these
 * source paths onto the shared canonical model (e.g. `patient.mrn`,
 * `patient.vitals.bp.systolic`) — but the flat `path → value` representation, and
 * everything downstream of it, does not change. That stability is the point: the
 * canonical model is the fixed contract; only the manifest varies per source.
 *
 * A small set of *format-level* cleanings happen here (never clinical ones):
 * whitespace trim, and text sentinels that universally mean "absent" (`NULL`,
 * `N/A`, `NA`, `None`, `-`) collapse to `null`. Domain/clinical sentinels and
 * range logic are deliberately left for the governed normalize + plausibility
 * steps, where they can be sourced and reviewed.
 */

const TEXT_SENTINELS = new Set(["", "null", "n/a", "na", "none", "-", "--", "."]);

/**
 * Normalize a single raw cell to a value or `null`.
 * @param {string|null} raw
 * @returns {{value: string|null, sentinel: boolean}}
 */
function normalizeCell(raw) {
  if (raw === null || raw === undefined) return { value: null, sentinel: false };
  const trimmed = String(raw).trim();
  if (TEXT_SENTINELS.has(trimmed.toLowerCase())) {
    return { value: null, sentinel: trimmed !== "" };
  }
  return { value: trimmed, sentinel: false };
}

/**
 * @typedef {Object} CanonicalRecord
 * @property {string} source        - Source identifier (e.g. file name).
 * @property {number} recordIndex   - 0-based index within the source.
 * @property {Object.<string,(string|null)>} values - Dotted-path → value map.
 * @property {Array<[string,(string|null)]>} pairs  - The same, as ordered pairs.
 * @property {string[]} sentinels   - Paths whose value was a text sentinel → null.
 */

/**
 * @param {string[]} header
 * @param {(string|null)[][]} rows
 * @param {object} [options]
 * @param {string} [options.namespace="record"] - Path prefix for every column.
 * @param {string} [options.source="unknown"]   - Source identifier stamped on records.
 * @returns {CanonicalRecord[]}
 */
function flatten(header, rows, options = {}) {
  const namespace = options.namespace || "record";
  const source = options.source || "unknown";
  const paths = header.map((h) => `${namespace}.${String(h).trim()}`);

  return rows.map((row, recordIndex) => {
    const values = {};
    const pairs = [];
    const sentinels = [];
    for (let c = 0; c < paths.length; c++) {
      const { value, sentinel } = normalizeCell(row[c]);
      values[paths[c]] = value;
      pairs.push([paths[c], value]);
      if (sentinel) sentinels.push(paths[c]);
    }
    return { source, recordIndex, values, pairs, sentinels };
  });
}

module.exports = { flatten, normalizeCell, TEXT_SENTINELS };
