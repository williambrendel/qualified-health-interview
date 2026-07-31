"use strict";

/**
 * @module pipeline/ingest/structural
 * @description
 * Deterministic structural repair, applied after tokenizing and before flattening.
 * This is where the two nastiest CSV realities are handled *explicitly and
 * visibly*, never silently:
 *
 * 1. **Ragged rows** — rows with fewer or more cells than the header. Short rows
 *    are padded with `null`; long rows are kept but truncated cells are preserved
 *    in an `overflow` note. Every touched row is recorded as an anomaly.
 *
 * 2. **Spanning / merged cells** — a value that logically applies to several rows
 *    but, in a flat CSV, is written once and then left blank below it (the
 *    artifact you get when a spreadsheet with merged cells is exported). When
 *    `fillSpanning` is enabled for a column, a blank cell inherits the last
 *    non-blank value above it — and each fill is recorded so a reviewer can audit
 *    exactly what was inferred versus what was in the file.
 *
 * Nothing here is a guess the user can't see: repairs are opt-in per concern and
 * every one emits an anomaly with row, column, and what changed.
 */

/**
 * @typedef {Object} Anomaly
 * @property {number} row     - 0-based body row index (excludes the header).
 * @property {number} [col]   - 0-based column index, when column-specific.
 * @property {string} kind    - "ragged_short" | "ragged_long" | "spanning_fill".
 * @property {string} detail  - Human-readable description.
 */

const isBlank = (v) => v === undefined || v === null || String(v).trim() === "";

/**
 * Align body rows to the header width and (optionally) fill spanning cells.
 *
 * @param {string[]} header - Header cells (column names).
 * @param {string[][]} bodyRows - Raw body rows from the tokenizer.
 * @param {object} [options]
 * @param {number[]|"all"} [options.fillSpanning] - Column indices (or "all") whose
 *   blank cells should inherit the last non-blank value above. Off by default —
 *   forward-fill is a real inference and must be requested.
 * @returns {{rows: (string|null)[][], anomalies: Anomaly[]}}
 */
function repair(header, bodyRows, options = {}) {
  const width = header.length;
  const fill = options.fillSpanning;
  const fillSet =
    fill === "all"
      ? new Set(header.map((_, i) => i))
      : new Set(Array.isArray(fill) ? fill : []);

  const anomalies = [];
  const lastNonBlank = new Array(width).fill(null);
  const rows = [];

  for (let r = 0; r < bodyRows.length; r++) {
    const raw = bodyRows[r];
    const out = new Array(width).fill(null);

    if (raw.length < width) {
      anomalies.push({
        row: r,
        kind: "ragged_short",
        detail: `row has ${raw.length} cells, expected ${width}; padded with null`,
      });
    } else if (raw.length > width) {
      anomalies.push({
        row: r,
        kind: "ragged_long",
        detail: `row has ${raw.length} cells, expected ${width}; extra cells: ${JSON.stringify(
          raw.slice(width)
        )}`,
      });
    }

    for (let c = 0; c < width; c++) {
      let v = c < raw.length ? raw[c] : null;
      if (isBlank(v) && fillSet.has(c) && lastNonBlank[c] !== null) {
        v = lastNonBlank[c];
        anomalies.push({
          row: r,
          col: c,
          kind: "spanning_fill",
          detail: `blank in "${header[c]}" filled from row above with ${JSON.stringify(v)}`,
        });
      }
      if (!isBlank(v)) lastNonBlank[c] = v;
      out[c] = isBlank(v) ? null : v;
    }
    rows.push(out);
  }

  return { rows, anomalies };
}

module.exports = { repair, isBlank };
