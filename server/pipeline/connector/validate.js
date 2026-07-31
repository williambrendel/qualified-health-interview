"use strict";

/**
 * @module pipeline/connector/validate
 * @description
 * Deterministic validation of an AI-proposed mapping manifest. Nothing the model
 * returns is trusted until it passes here: every destination must be a real
 * canonical path, every transform must be a real registered transform, and
 * multi-emit shapes must line up. A manifest with any error never runs.
 *
 * This is the machine half of "a human reviews it before it runs" — it makes the
 * manifest safe to *show* a human (and safe to apply) by guaranteeing it only
 * references the governed vocabulary.
 */

const canonical = require("./canonical");
const transforms = require("./transforms");

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string[]} errors    - Hard failures; a manifest with any is rejected.
 * @property {string[]} warnings  - Non-fatal notes (e.g. dropped source columns).
 * @property {string[]} mapped    - Canonical paths the manifest populates.
 * @property {string[]} dropped   - Source paths intentionally not mapped.
 */

/**
 * @param {object} manifest
 * @returns {ValidationResult}
 */
function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  const mapped = [];
  const dropped = [];

  if (!manifest || typeof manifest !== "object") {
    return { valid: false, errors: ["manifest is not an object"], warnings, mapped, dropped };
  }
  if (!manifest.source || typeof manifest.source !== "string") {
    errors.push("manifest.source (string) is required");
  }
  if (manifest.entity && !canonical.entities().includes(manifest.entity)) {
    errors.push(`unknown entity "${manifest.entity}"`);
  }
  if (!Array.isArray(manifest.fields)) {
    errors.push("manifest.fields (array) is required");
    return { valid: errors.length === 0, errors, warnings, mapped, dropped };
  }

  const seenTargets = new Set();

  manifest.fields.forEach((f, i) => {
    const at = `fields[${i}]`;
    if (!f || typeof f !== "object") {
      errors.push(`${at}: not an object`);
      return;
    }
    if (typeof f.from !== "string" || f.from === "") {
      errors.push(`${at}: "from" (source path) is required`);
      return;
    }

    // Dropped column: to === null/absent and no emits.
    const hasTo = f.to !== undefined && f.to !== null;
    const hasEmits = Array.isArray(f.emits) && f.emits.length > 0;
    if (!hasTo && !hasEmits) {
      dropped.push(f.from);
      return;
    }

    // Transform checks.
    if (f.transform !== undefined && f.transform !== null) {
      if (!transforms.isTransform(f.transform)) {
        errors.push(`${at}: unknown transform "${f.transform}"`);
      }
    }

    if (hasEmits) {
      // Multi-emit: transform must be a multi transform; each emit must be canonical.
      if (!f.transform || !transforms.isMulti(f.transform)) {
        errors.push(`${at}: "emits" requires a multi-emit transform (got "${f.transform}")`);
      } else {
        const expected = transforms.MULTI_EMITS[f.transform].length;
        if (f.emits.length !== expected) {
          errors.push(
            `${at}: transform "${f.transform}" emits ${expected} value(s), but ${f.emits.length} path(s) given`
          );
        }
      }
      f.emits.forEach((p) => {
        if (!canonical.isCanonicalPath(p)) errors.push(`${at}: unknown canonical path "${p}"`);
        else registerTarget(p);
      });
    } else if (hasTo) {
      if (transforms.isMulti(f.transform)) {
        errors.push(`${at}: transform "${f.transform}" is multi-emit; use "emits", not "to"`);
      }
      if (!canonical.isCanonicalPath(f.to)) errors.push(`${at}: unknown canonical path "${f.to}"`);
      else registerTarget(f.to);
    }

    function registerTarget(p) {
      if (seenTargets.has(p)) warnings.push(`${at}: canonical path "${p}" mapped more than once`);
      seenTargets.add(p);
      mapped.push(p);
    }
  });

  if (mapped.length === 0 && errors.length === 0) {
    warnings.push("manifest maps no canonical fields");
  }

  return { valid: errors.length === 0, errors, warnings, mapped, dropped };
}

module.exports = { validateManifest };
