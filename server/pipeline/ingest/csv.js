"use strict";

/**
 * @module pipeline/ingest/csv
 * @description
 * A dependency-free, RFC 4180-tolerant delimited-text tokenizer. It turns raw
 * text into a rectangle of string cells (rows × columns) while surviving the
 * mess real EHR exports carry:
 *
 * - **Quoted fields** containing the delimiter, or line breaks (a single logical
 *   cell that spans several physical lines — common in free-text note columns).
 * - **Escaped quotes** (`""` inside a quoted field → a literal `"`).
 * - **Mixed line endings** (`\r\n`, `\n`, or a bare `\r`).
 * - **Ragged rows** (varying column counts) — reported as-is; padding/repair is
 *   the job of {@link module:pipeline/ingest/structural}, not the tokenizer.
 *
 * The tokenizer is intentionally lossless and opinion-free: it does not trim,
 * coerce, or drop anything. Every downstream cleaning decision is made later, on
 * an explicit, inspectable step.
 */

/**
 * Tokenize delimited text into an array of rows, each an array of raw string cells.
 *
 * @param {string} text - The full source text.
 * @param {object} [options]
 * @param {string} [options.delimiter=","] - Field separator (single character).
 * @param {string} [options.quote="\""]    - Quote character used to wrap fields.
 * @returns {string[][]} Rows of raw string cells. A trailing newline does not
 *   produce a spurious empty final row.
 */
function parse(text, options = {}) {
  const delimiter = options.delimiter || ",";
  const quote = options.quote || "\"";

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false; // distinguishes a real empty row from "no cells yet"

  const pushField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0, n = text.length; i < n; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === quote) {
        if (text[i + 1] === quote) { field += quote; i++; }  // escaped quote ""
        else inQuotes = false;                               // closing quote
      } else {
        field += ch;                                         // includes newlines
      }
      continue;
    }

    if (ch === quote && field === "") {
      inQuotes = true;      // opening quote (only valid at field start)
      fieldStarted = true;
      continue;
    }
    if (ch === delimiter) { pushField(); fieldStarted = true; continue; }
    if (ch === "\n") { pushRow(); continue; }
    if (ch === "\r") {                                       // \r or \r\n
      if (text[i + 1] === "\n") i++;
      pushRow();
      continue;
    }
    field += ch;
    fieldStarted = true;
  }

  // Flush the final field/row unless the text ended exactly on a newline.
  if (fieldStarted || field !== "" || row.length > 0) pushRow();

  return rows;
}

module.exports = { parse };
