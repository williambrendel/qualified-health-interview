"use strict";

/**
 * @module pipeline/connector/canonical
 * @description
 * The **canonical model** — the fixed, human-reviewed target schema every source
 * is mapped onto. This is the "protobuf": it does not change per source. Only the
 * mapping manifest varies, and a manifest may only target paths that appear here.
 *
 * Keeping the target closed (a known set of dotted paths with types) is what makes
 * AI-proposed mapping safe: the model chooses *from* this vocabulary, it never
 * invents a destination. Validation (see {@link module:pipeline/connector/validate})
 * rejects any manifest that points at a path not defined here.
 *
 * Scope: the entities the three checkers need (triage, care-gap, med-recon). It is
 * intentionally not exhaustive of every source column — unmapped columns are
 * dropped explicitly and logged, never guessed into a new field.
 */

/**
 * Canonical entities → { dotted-path: { type, desc } }.
 * `type` is one of: string | number | date | boolean.
 */
const ENTITIES = {
  patient: {
    "patient.id": { type: "string", desc: "Stable patient identifier" },
    "patient.mrn": { type: "string", desc: "Medical record number" },
    "patient.name.first": { type: "string", desc: "First name" },
    "patient.name.middle": { type: "string", desc: "Middle name" },
    "patient.name.last": { type: "string", desc: "Last name" },
    "patient.birth_date": { type: "date", desc: "Date of birth" },
    "patient.death_date": { type: "date", desc: "Date of death, if any" },
    "patient.age": { type: "number", desc: "Age in years" },
    "patient.sex": { type: "string", desc: "Sex/gender label" },
    "patient.status": { type: "string", desc: "Record status, e.g. Active" },
    "patient.pcp.id": { type: "string", desc: "Primary care provider id" },
    "patient.pcp.name": { type: "string", desc: "Primary care provider name" },
  },
  provider: {
    "provider.id": { type: "string", desc: "Provider identifier" },
    "provider.name": { type: "string", desc: "Provider display name" },
    "provider.npi": { type: "string", desc: "National Provider Identifier" },
    "provider.type": { type: "string", desc: "Provider type, e.g. Physician" },
    "provider.specialty": { type: "string", desc: "Clinical specialty" },
    "provider.department": { type: "string", desc: "Department name" },
  },
  encounter: {
    "encounter.id": { type: "string", desc: "Encounter/contact serial id" },
    "encounter.patient_id": { type: "string", desc: "Patient id for the encounter" },
    "encounter.type": { type: "string", desc: "Encounter type, e.g. Office Visit" },
    "encounter.status": { type: "string", desc: "Appointment status, e.g. Completed" },
    "encounter.date": { type: "date", desc: "Contact date" },
    "encounter.department": { type: "string", desc: "Department name" },
    "encounter.location": { type: "string", desc: "Location name" },
    "encounter.provider.id": { type: "string", desc: "Visit provider id" },
    "encounter.provider.name": { type: "string", desc: "Visit provider name" },
    "encounter.visit_reason": { type: "string", desc: "Reason/category, e.g. Annual Wellness Visit" },
    "encounter.insurance": { type: "string", desc: "Insurance/coverage label" },
  },
  problem: {
    "problem.id": { type: "string", desc: "Problem list entry id" },
    "problem.patient_id": { type: "string", desc: "Patient id" },
    "problem.dx_id": { type: "string", desc: "Diagnosis id" },
    "problem.name": { type: "string", desc: "Problem name" },
    "problem.icd10": { type: "string", desc: "ICD-10 code" },
    "problem.status": { type: "string", desc: "Problem status, e.g. Active" },
    "problem.chronic": { type: "boolean", desc: "Chronic flag (Y/N)" },
    "problem.noted_date": { type: "date", desc: "Date noted" },
    "problem.resolved_date": { type: "date", desc: "Date resolved, if any" },
  },
  diagnosis: {
    "diagnosis.encounter_id": { type: "string", desc: "Encounter id" },
    "diagnosis.seq": { type: "number", desc: "Diagnosis sequence" },
    "diagnosis.dx_id": { type: "string", desc: "Diagnosis id" },
    "diagnosis.name": { type: "string", desc: "Diagnosis name" },
    "diagnosis.icd10": { type: "string", desc: "ICD-10 code" },
    "diagnosis.type": { type: "string", desc: "Diagnosis type, e.g. Primary" },
    "diagnosis.date": { type: "date", desc: "Diagnosis date" },
  },
  medication_order: {
    "medication_order.id": { type: "string", desc: "Medication order id" },
    "medication_order.patient_id": { type: "string", desc: "Patient id" },
    "medication_order.encounter_id": { type: "string", desc: "Encounter id" },
    "medication_order.name": { type: "string", desc: "Medication display name" },
    "medication_order.generic": { type: "string", desc: "Generic class/name" },
    "medication_order.dose": { type: "number", desc: "Discrete dose amount" },
    "medication_order.dose_unit": { type: "string", desc: "Dose unit, e.g. mg" },
    "medication_order.frequency": { type: "string", desc: "Frequency, e.g. daily" },
    "medication_order.route": { type: "string", desc: "Route, e.g. Oral" },
    "medication_order.status": { type: "string", desc: "Order status, e.g. Active" },
    "medication_order.class": { type: "string", desc: "Order class, e.g. Normal" },
    "medication_order.ordering_date": { type: "date", desc: "Ordering date" },
    "medication_order.start_date": { type: "date", desc: "Start date" },
    "medication_order.end_date": { type: "date", desc: "End date, if any" },
    "medication_order.provider_id": { type: "string", desc: "Ordering provider id" },
    "medication_order.sig": { type: "string", desc: "SIG / instructions" },
    "medication_order.rxnorm": { type: "string", desc: "RxNorm code" },
  },
  lab_order: {
    "lab_order.id": { type: "string", desc: "Procedure order id" },
    "lab_order.encounter_id": { type: "string", desc: "Encounter id" },
    "lab_order.patient_id": { type: "string", desc: "Patient id" },
    "lab_order.code": { type: "string", desc: "Procedure/LOINC code" },
    "lab_order.name": { type: "string", desc: "Procedure name" },
    "lab_order.type": { type: "string", desc: "Order type, e.g. Lab" },
    "lab_order.status": { type: "string", desc: "Order status, e.g. Completed" },
    "lab_order.provider_id": { type: "string", desc: "Ordering provider id" },
    "lab_order.specialty": { type: "string", desc: "Ordering specialty" },
    "lab_order.order_date": { type: "date", desc: "Order date" },
    "lab_order.result_value": { type: "number", desc: "Result value on the order row" },
    "lab_order.result_unit": { type: "string", desc: "Result unit" },
    "lab_order.result_date": { type: "date", desc: "Result date" },
    "lab_order.result_flag": { type: "string", desc: "Result flag code" },
    "lab_order.days_from_visit": { type: "number", desc: "Signed days from visit" },
  },
  lab_result: {
    "lab_result.id": { type: "string", desc: "Result id" },
    "lab_result.order_id": { type: "string", desc: "Originating order id" },
    "lab_result.patient_id": { type: "string", desc: "Patient id" },
    "lab_result.encounter_id": { type: "string", desc: "Encounter id" },
    "lab_result.component_id": { type: "string", desc: "Component id" },
    "lab_result.component": { type: "string", desc: "Component name, e.g. LDL Cholesterol" },
    "lab_result.loinc": { type: "string", desc: "LOINC code" },
    "lab_result.value": { type: "number", desc: "Numeric result value" },
    "lab_result.value_text": { type: "string", desc: "Raw text result value" },
    "lab_result.flag": { type: "string", desc: "Result flag code" },
    "lab_result.unit": { type: "string", desc: "Reference/result unit" },
    "lab_result.reference.low": { type: "number", desc: "Reference range low bound" },
    "lab_result.reference.high": { type: "number", desc: "Reference range high bound" },
    "lab_result.reference.raw": { type: "string", desc: "Reference range as given, e.g. 136-145" },
    "lab_result.date": { type: "date", desc: "Result date" },
  },
  vital: {
    "vital.id": { type: "string", desc: "Flowsheet measure id" },
    "vital.patient_id": { type: "string", desc: "Patient id" },
    "vital.name": { type: "string", desc: "Measure name, e.g. BLOOD PRESSURE" },
    "vital.value_text": { type: "string", desc: "Raw measure value, e.g. 150/99" },
    "vital.value": { type: "number", desc: "Numeric measure value when scalar" },
    "vital.bp.systolic": { type: "number", desc: "Systolic BP when measure is blood pressure" },
    "vital.bp.diastolic": { type: "number", desc: "Diastolic BP when measure is blood pressure" },
    "vital.date": { type: "date", desc: "Recorded date" },
  },
  note: {
    "note.id": { type: "string", desc: "Note id" },
    "note.patient_id": { type: "string", desc: "Patient id" },
    "note.encounter_id": { type: "string", desc: "Encounter id" },
    "note.type": { type: "string", desc: "Note type, e.g. Progress Notes" },
    "note.text": { type: "string", desc: "Free-text note body" },
    "note.author": { type: "string", desc: "Authoring provider name" },
    "note.service": { type: "string", desc: "Authoring service/specialty" },
    "note.status": { type: "string", desc: "Note status, e.g. Signed" },
    "note.entry_time": { type: "date", desc: "Entry timestamp" },
  },
  surgical_history: {
    "surgical_history.patient_id": { type: "string", desc: "Patient id" },
    "surgical_history.encounter_id": { type: "string", desc: "Encounter id" },
    "surgical_history.procedure": { type: "string", desc: "Procedure name, e.g. Sleeve Gastrectomy" },
    "surgical_history.procedure_id": { type: "string", desc: "Procedure id" },
    "surgical_history.cpt": { type: "string", desc: "CPT code" },
    "surgical_history.date": { type: "date", desc: "Surgical history date" },
    "surgical_history.start_date": { type: "date", desc: "Procedure start date" },
    "surgical_history.end_date": { type: "date", desc: "Procedure end date, if any" },
    "surgical_history.comments": { type: "string", desc: "Free-text comments" },
  },
};

/** Flat map of every canonical path → its spec. */
const PATHS = Object.freeze(
  Object.assign({}, ...Object.values(ENTITIES).map((e) => e))
);

/** @param {string} path @returns {boolean} */
function isCanonicalPath(path) {
  return Object.prototype.hasOwnProperty.call(PATHS, path);
}

/** @param {string} path @returns {string|null} declared type, or null if unknown */
function typeOf(path) {
  return isCanonicalPath(path) ? PATHS[path].type : null;
}

/** @returns {string[]} entity names */
function entities() {
  return Object.keys(ENTITIES);
}

/** @param {string} entity @returns {string[]} canonical paths for an entity */
function pathsFor(entity) {
  return ENTITIES[entity] ? Object.keys(ENTITIES[entity]) : [];
}

module.exports = { ENTITIES, PATHS, isCanonicalPath, typeOf, entities, pathsFor };
