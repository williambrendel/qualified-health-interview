"use strict";

/**
 * @module pipeline/ingest
 * @description
 * The deterministic front door of the pipeline. Given raw text (or a file), it
 * runs the fixed sequence — **sniff → tokenize → structural repair → flatten** —
 * and returns canonical `path → value` records plus a full anomaly log. No AI is
 * involved at this stage: this is the "clean grid + canonical shape" that the AI
 * input connector (Day 2) will propose a *mapping manifest* over.
 */

const fs = require("fs");
const path = require("path");
const { sniff } = require("./sniff");
const csv = require("./csv");
const { repair } = require("./structural");
const { flatten } = require("./flatten");

/**
 * Ingest raw delimited text into canonical records.
 *
 * @param {string} text - Raw source text.
 * @param {object} [options]
 * @param {string} [options.source="text"]       - Source identifier for provenance.
 * @param {string} [options.namespace]           - Path prefix; defaults to `source` sans extension.
 * @param {string} [options.delimiter]           - Override the sniffed delimiter.
 * @param {boolean} [options.hasHeader]          - Override header detection.
 * @param {number[]|"all"} [options.fillSpanning] - Columns whose blanks inherit from above.
 * @returns {{records: import("./flatten").CanonicalRecord[], header: string[], anomalies: object[], meta: object}}
 */
function ingestText(text, options = {}) {
  const source = options.source || "text";
  const namespace =
    options.namespace || String(source).replace(/\.[^.]+$/, "") || "record";

  const sniffed = sniff(text);
  const delimiter = options.delimiter || sniffed.delimiter;
  const hasHeader = options.hasHeader ?? sniffed.hasHeader;

  const rows = csv.parse(text, { delimiter, quote: sniffed.quote });
  if (rows.length === 0) {
    return { source, namespace, records: [], header: [], anomalies: [], meta: { ...sniffed, delimiter, hasHeader, rowCount: 0 } };
  }

  const header = hasHeader ? rows[0] : rows[0].map((_, i) => `col${i}`);
  const bodyRows = hasHeader ? rows.slice(1) : rows;

  const { rows: repaired, anomalies } = repair(header, bodyRows, {
    fillSpanning: options.fillSpanning,
  });
  const records = flatten(header, repaired, { namespace, source });

  return {
    source,
    namespace,
    records,
    header,
    anomalies,
    meta: {
      ...sniffed,
      delimiter,
      hasHeader,
      namespace,
      rowCount: records.length,
      anomalyCount: anomalies.length,
    },
  };
}

/**
 * Ingest a file from disk.
 * @param {string} filePath
 * @param {object} [options] - Same as {@link ingestText}; `source`/`namespace` default from the file name.
 * @returns {ReturnType<typeof ingestText>}
 */
function ingestFile(filePath, options = {}) {
  const text = fs.readFileSync(filePath, "utf8");
  const source = options.source || path.basename(filePath);
  return ingestText(text, { ...options, source });
}

module.exports = { ingestText, ingestFile };
