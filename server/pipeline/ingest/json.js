"use strict";

/**
 * @module pipeline/ingest/json
 * @description
 * JSON ingest — the non-delimited sibling of the CSV path. A JSON export (an array
 * of records, or an object wrapping one) is flattened into the exact same canonical
 * shape the rest of the pipeline speaks: a list of records, each a set of
 * **`path → value`** pairs with hierarchical dotted keys. Nested objects become
 * dotted paths (`observation.value`), arrays become indexed paths (`codes.0`).
 *
 * This is where the hierarchical `path → value` model earns its keep: CSV columns
 * and JSON nesting collapse to the *same* representation, so the AI connector and
 * every checker downstream are identical regardless of the source format.
 */

/** Recursively flatten a value into `out[dottedPath] = scalar`. */
function flattenValue(value, prefix, out) {
  if (value === null || value === undefined) {
    if (prefix) out[prefix] = null;
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) { if (prefix) out[prefix] = null; return; }
    value.forEach((v, i) => flattenValue(v, prefix ? `${prefix}.${i}` : String(i), out));
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) { if (prefix) out[prefix] = null; return; }
    for (const k of keys) flattenValue(value[k], prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out[prefix] = value; // scalar: string | number | boolean
}

/** Normalize a flattened scalar: keep numbers/booleans; trim strings; blank → null. */
function normJson(v) {
  if (typeof v === "string") { const t = v.trim(); return t === "" ? null : t; }
  return v;
}

/**
 * @param {string} text - raw JSON text
 * @param {object} options - { source, namespace }
 * @returns {{source, namespace, records, header, anomalies, meta}}
 */
function ingestJson(text, options = {}) {
  const source = options.source || "text.json";
  const namespace = options.namespace || String(source).replace(/\.[^.]+$/, "") || "record";

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return {
      source, namespace, records: [], header: [],
      anomalies: [{ kind: "json_parse_error", detail: e.message }],
      meta: { format: "json", delimiter: "json", hasHeader: true, namespace, rowCount: 0, anomalyCount: 1 },
    };
  }

  // Normalize to an array of record objects.
  let arr;
  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === "object") {
    const arrKey = Object.keys(data).find((k) => Array.isArray(data[k])); // e.g. { results: [...] }
    arr = arrKey ? data[arrKey] : [data];
  } else arr = [];

  const headerSet = new Set();
  const records = arr.map((item, recordIndex) => {
    const flat = {};
    flattenValue(item, "", flat);
    const values = {};
    const pairs = [];
    for (const [p, raw] of Object.entries(flat)) {
      const path = `${namespace}.${p}`;
      const v = normJson(raw);
      values[path] = v;
      pairs.push([path, v]);
      headerSet.add(p);
    }
    return { source, recordIndex, values, pairs, sentinels: [] };
  });

  return {
    source, namespace, records,
    header: [...headerSet],
    anomalies: [],
    meta: { format: "json", delimiter: "json", hasHeader: true, namespace, rowCount: records.length, anomalyCount: 0 },
  };
}

module.exports = { ingestJson, flattenValue };
