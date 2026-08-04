"use strict";

/**
 * @module pipeline/connector/project
 * @description
 * The **outward** projection: canonical → a target format (here, FHIR R4 `Observation`)
 * and back. Where {@link module:pipeline/connector/apply} maps a source *into* the
 * canonical master and {@link module:pipeline/connector/reconstruct} regenerates the
 * source *from* it, this module renders the master *out* to a downstream format — and,
 * crucially, lets us **prove** that render is faithful for the fields it carries while
 * **quantifying** the fields it structurally cannot.
 *
 * The key inversion of the whole system: **FHIR is a lossy *view* of the master, not
 * the master.** A FHIR-first store makes Observation the source of truth and loses
 * everything Observation has no slot for. Here the master keeps everything; FHIR is a
 * projection you regenerate on demand — and we report exactly what it drops.
 *
 * The projection is a small bidirectional manifest (`canonical ⇄ FHIR path`), the mirror
 * image of an induce manifest. `project` walks it forward; `unproject` walks it back.
 */

/** canonical path ⇄ FHIR Observation path. `encode`/`decode` handle reference wrapping. */
const PROJECTION = [
  { canonical: "lab_result.id", fhir: "id" },
  { canonical: "lab_result.patient_id", fhir: "subject.reference",
    encode: (v) => `Patient/${v}`, decode: (v) => String(v).replace(/^Patient\//, "") },
  { canonical: "lab_result.encounter_id", fhir: "encounter.reference",
    encode: (v) => `Encounter/${v}`, decode: (v) => String(v).replace(/^Encounter\//, "") },
  { canonical: "lab_result.loinc", fhir: "code.coding.0.code" },
  { canonical: "lab_result.component", fhir: "code.coding.0.display" },
  { canonical: "lab_result.date", fhir: "effectiveDateTime" },
  { canonical: "lab_result.value", fhir: "valueQuantity.value" },
  { canonical: "lab_result.unit", fhir: "valueQuantity.unit" },
  { canonical: "lab_result.reference.low", fhir: "referenceRange.0.low.value" },
  { canonical: "lab_result.reference.high", fhir: "referenceRange.0.high.value" },
  { canonical: "lab_result.flag", fhir: "interpretation.0.text" },
];

const isIndex = (s) => /^\d+$/.test(s);

/** Set a dotted FHIR path (numeric segments = array indices). Nulls are skipped. */
function setPath(root, path, value) {
  if (value === null || value === undefined) return;
  const segs = path.split(".");
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const key = isIndex(segs[i]) ? Number(segs[i]) : segs[i];
    if (cur[key] === undefined) cur[key] = isIndex(segs[i + 1]) ? [] : {};
    cur = cur[key];
  }
  const last = segs[segs.length - 1];
  cur[isIndex(last) ? Number(last) : last] = value;
}

/** Read a dotted FHIR path. */
function getPath(root, path) {
  let cur = root;
  for (const s of path.split(".")) {
    if (cur == null) return undefined;
    cur = cur[isIndex(s) ? Number(s) : s];
  }
  return cur;
}

/** Canonical → FHIR Observation. */
function project(values) {
  const obs = { resourceType: "Observation", status: "final" };
  setPath(obs, "code.coding.0.system", "http://loinc.org");
  for (const m of PROJECTION) {
    let v = values[m.canonical];
    if (v === null || v === undefined) continue;
    setPath(obs, m.fhir, m.encode ? m.encode(v) : v);
  }
  return obs;
}

/** FHIR Observation → canonical (the inverse projection). */
function unproject(obs) {
  const values = {};
  for (const m of PROJECTION) {
    const v = getPath(obs, m.fhir);
    values[m.canonical] = v === null || v === undefined ? null : (m.decode ? m.decode(v) : v);
  }
  return values;
}

/** Canonical paths this projection carries. */
function projectedPaths() {
  return PROJECTION.map((m) => m.canonical);
}

/**
 * Split a record's canonical fields into those FHIR can carry and those it cannot
 * (mapped into the canonical model but with no slot in a standard Observation — the
 * projection-boundary loss a FHIR-first store also incurs).
 */
function coverage(values) {
  const carried = new Set(projectedPaths());
  const present = Object.keys(values).filter((k) => values[k] !== null && values[k] !== undefined);
  return {
    carried: present.filter((k) => carried.has(k)),
    unprojectable: present.filter((k) => !carried.has(k)),
  };
}

module.exports = { project, unproject, projectedPaths, coverage, PROJECTION, setPath, getPath };
