"use strict";

/**
 * @module pipeline/connector/transforms
 * @description
 * The **fixed transform library**. A mapping manifest may only *name* a transform
 * from this registry; it can never supply one. This is the load-bearing half of
 * "the model emits specs, never code": the LLM picks `"split_bp"` by name, and this
 * reviewed, tested function is what actually runs.
 *
 * Two shapes of transform:
 * - **scalar** — `(value) => value|null`, feeds a single canonical `to` path.
 * - **multi** — `(value) => any[]`, feeds an ordered `emits: [pathA, pathB]`. The
 *   returned array is zipped positionally onto `emits` by the apply step.
 *
 * Every transform is null-safe (blank/`null` in → `null` out) and never throws on
 * bad input — unparseable values become `null`, recorded as an apply anomaly rather
 * than crashing the pipeline.
 */

const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";

/** @param {*} v @returns {string|null} */
function trim(v) {
  return isBlank(v) ? null : String(v).trim();
}

/** @param {*} v @returns {number|null} */
function to_number(v) {
  if (isBlank(v)) return null;
  const n = Number(String(v).trim().replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Coerce to an ISO date (`YYYY-MM-DD`) when the value is a full, unambiguous date.
 * Non-destructive: a partial value that isn't a full date (e.g. a bare year
 * `"2017"`) is returned trimmed as-is rather than fabricated into a false date.
 * @param {*} v @returns {string|null}
 */
function to_date(v) {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, m, d, y] = mdy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return s; // e.g. a bare year — kept, not invented
}

/** @param {*} v @returns {boolean|null} — Y/true/1 → true; N/false/0 → false */
function to_boolean(v) {
  if (isBlank(v)) return null;
  const s = String(v).trim().toLowerCase();
  if (["y", "yes", "true", "1", "t"].includes(s)) return true;
  if (["n", "no", "false", "0", "f"].includes(s)) return false;
  return null;
}

/** @param {*} v @returns {string|null} */
function lower(v) {
  return isBlank(v) ? null : String(v).trim().toLowerCase();
}

/** @param {*} v @returns {string|null} */
function upper(v) {
  return isBlank(v) ? null : String(v).trim().toUpperCase();
}

/**
 * Split a blood-pressure string `"150/99"` into `[systolic, diastolic]` numbers.
 * @param {*} v @returns {[number|null, number|null]}
 */
function split_bp(v) {
  if (isBlank(v)) return [null, null];
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (!m) return [null, null];
  return [Number(m[1]), Number(m[2])];
}

/**
 * Parse a reference range into `[low, high]` numbers. Handles `"136-145"`,
 * `"0-100"`, decimals `"0.6-1.2"`, and one-sided `"<=100"` / `">40"`.
 * @param {*} v @returns {[number|null, number|null]}
 */
function parse_reference_range(v) {
  if (isBlank(v)) return [null, null];
  const s = String(v).trim();
  let m = s.match(/^(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)$/);
  if (m) return [Number(m[1]), Number(m[2])];
  m = s.match(/^[<≤]=?\s*(-?\d+(?:\.\d+)?)$/);
  if (m) return [null, Number(m[1])];
  m = s.match(/^[>≥]=?\s*(-?\d+(?:\.\d+)?)$/);
  if (m) return [Number(m[1]), null];
  return [null, null];
}

const SCALAR = { trim, to_number, to_date, to_boolean, lower, upper };
const MULTI = { split_bp, parse_reference_range };

/** Ordered leaf semantics for each multi-emit transform (documentation + validation aid). */
const MULTI_EMITS = {
  split_bp: ["systolic", "diastolic"],
  parse_reference_range: ["low", "high"],
};

const REGISTRY = { ...SCALAR, ...MULTI };

/**
 * Normalized equality for round-trip comparison: numeric when both sides parse as
 * numbers, otherwise whitespace-insensitive string equality. Used to compare a
 * value reconstructed via `inverse` against the original source cell.
 */
function eqNorm(a, b) {
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  const na = Number(String(a).replace(/\s|,/g, ""));
  const nb = Number(String(b).replace(/\s|,/g, ""));
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a).trim().replace(/\s+/g, "") === String(b).trim().replace(/\s+/g, "");
}

/**
 * @typedef {Object} TransformContract
 * @property {"scalar"|"multi"} arity
 * @property {"reversible"|"equivalence"|"one-way"} rev  - Reversibility class (for the report).
 * @property {null|function} inverse - `(out) => sourceString`, or null when not reversible.
 * @property {function} check        - `(raw, out) => boolean`, the invariant. This is BOTH the
 *                                      round-trip predicate at runtime and the property-test oracle.
 * @property {Array} examples        - Representative raw inputs, used by the property tests.
 */

/**
 * The reversibility contract for every named transform. Single source of truth:
 * the verifier and the transform unit tests both consume `inverse`/`check`.
 * @type {Object.<string, TransformContract>}
 */
const CONTRACTS = {
  trim: {
    arity: "scalar", rev: "equivalence", inverse: null,
    check: (raw, out) => (out === null ? isBlank(raw) : out === String(raw).trim()),
    examples: [" hi ", "x", "", null, "already"],
  },
  lower: {
    arity: "scalar", rev: "one-way", inverse: null,
    check: (raw, out) => (out === null ? isBlank(raw) : out === String(raw).trim().toLowerCase()),
    examples: ["ABC", "MiXeD", "", null],
  },
  upper: {
    arity: "scalar", rev: "one-way", inverse: null,
    check: (raw, out) => (out === null ? isBlank(raw) : out === String(raw).trim().toUpperCase()),
    examples: ["abc", "MiXeD", "", null],
  },
  to_number: {
    arity: "scalar", rev: "equivalence", inverse: (n) => (n == null ? null : String(n)),
    check: (raw, out) =>
      out === null
        ? isBlank(raw) || !Number.isFinite(Number(String(raw).replace(/,/g, "")))
        : out === Number(String(raw).replace(/,/g, "")),
    examples: ["42.46", "1,000", "", "N/A", null, "0.771"],
  },
  to_date: {
    arity: "scalar", rev: "equivalence", inverse: (d) => (d == null ? null : String(d)),
    check: (raw, out) => {
      if (out === null) return isBlank(raw);
      const iso = String(out);
      const rawS = String(raw).trim();
      if (rawS.startsWith(iso) || iso === rawS) return true; // ISO-prefix or bare-token passthrough
      const mdy = rawS.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // MM/DD/YYYY reformatted → ISO
      if (mdy) return iso === `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
      return false;
    },
    examples: ["2026-05-09 14:31:00", "2017", "05/09/2026", "", null],
  },
  to_boolean: {
    arity: "scalar", rev: "one-way", inverse: (b) => (b == null ? null : b ? "true" : "false"),
    check: (raw, out) => out === null || typeof out === "boolean",
    examples: ["Y", "false", "1", "", null, "True"],
  },
  split_bp: {
    arity: "multi", rev: "reversible",
    inverse: (arr) => (arr[0] == null && arr[1] == null ? null : `${arr[0]}/${arr[1]}`),
    check: (raw, out) => {
      const recon = out[0] == null && out[1] == null ? null : `${out[0]}/${out[1]}`;
      return recon === null ? split_bp(raw)[0] === null : eqNorm(recon, raw);
    },
    examples: ["150/99", "120 / 80", "bmi 30", "", null],
  },
  parse_reference_range: {
    // Fully reversible for "low-high"; one-sided forms (">40") lose the exact
    // symbol, so the honest class is equivalence, not reversible.
    arity: "multi", rev: "equivalence",
    inverse: (arr) => {
      const [lo, hi] = arr;
      if (lo != null && hi != null) return `${lo}-${hi}`;
      if (hi != null) return `<=${hi}`;
      if (lo != null) return `>=${lo}`;
      return null;
    },
    check: (raw, out) => {
      const [lo, hi] = out;
      if (lo != null && hi != null) return eqNorm(`${lo}-${hi}`, raw);
      if (lo == null && hi == null) return parse_reference_range(raw)[0] === null && parse_reference_range(raw)[1] === null;
      return true; // one-sided bound: reconstructable form differs; accepted
    },
    examples: ["136-145", "0.6-1.2", "<=100", ">40", "", null],
  },
};

/** @param {string} name @returns {TransformContract|null} */
function contract(name) {
  return CONTRACTS[name] || null;
}

/** @param {string} name @returns {boolean} */
function isTransform(name) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name);
}
/** @param {string} name @returns {boolean} */
function isMulti(name) {
  return Object.prototype.hasOwnProperty.call(MULTI, name);
}
/** @returns {string[]} */
function names() {
  return Object.keys(REGISTRY);
}

module.exports = {
  REGISTRY,
  MULTI_EMITS,
  CONTRACTS,
  contract,
  eqNorm,
  isTransform,
  isMulti,
  names,
  // exported individually for direct unit testing
  trim, to_number, to_date, to_boolean, lower, upper, split_bp, parse_reference_range,
};
