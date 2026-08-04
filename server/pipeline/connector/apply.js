"use strict";

/**
 * @module pipeline/connector/apply
 * @description
 * The deterministic apply step: given ingest records (source `path → value`) and a
 * **validated** manifest, produce canonical records (canonical `path → value`) by
 * running the named transforms. This is fixed engine code — it never evaluates
 * anything from the manifest except *which* registered transform to call.
 *
 * Each canonical record keeps a provenance back-pointer (`_source`, `recordIndex`)
 * and every coercion that failed (a value a transform could not parse) is recorded
 * as an anomaly, so downstream steps and reviewers can see exactly what was lost.
 *
 * **Lossless master.** The interpreted canonical (`values`) is only *one* view of the
 * record. To make the mapping lossless — reconstructable back to the source, not just
 * projectable forward — each output record is an **envelope** that also carries:
 *   - `raw`       — the exact ingested `path → value` map (ground truth).
 *   - `remainder` — every source column NOT consumed by the manifest, retained
 *                   verbatim instead of dropped. This is the "unmappable remainder":
 *                   the fields a FHIR-first / closed-canonical store silently loses.
 * and the apply step returns a dataset-level `lineage` (which source column, via which
 * transform, produced each canonical path) so {@link module:pipeline/connector/reconstruct}
 * can invert the mapping and prove the round trip.
 */

const transforms = require("./transforms");

/**
 * Build a `from`-resolver from the ingest records' actual keys. Resolves an exact
 * key, or a bare column name to its namespaced key (and vice-versa). Returns a
 * function `(from) => resolvedKey | null`.
 */
function buildResolver(records) {
  const full = new Set();
  const bareToFull = {};
  const keys = records[0] ? Object.keys(records[0].values) : [];
  for (const k of keys) {
    full.add(k);
    const bare = k.includes(".") ? k.slice(k.lastIndexOf(".") + 1) : k;
    if (!(bare in bareToFull)) bareToFull[bare] = k;
  }
  return (from) => {
    if (from == null) return null;
    if (full.has(from)) return from;
    // dotted-path suffix match (handles nested JSON: "obs.id" → "labs.obs.id")
    const sfx = keys.filter((k) => k.endsWith("." + from));
    if (sfx.length === 1) return sfx[0];
    const bare = from.includes(".") ? from.slice(from.lastIndexOf(".") + 1) : from;
    return bareToFull[bare] || bareToFull[from] || (sfx.length ? sfx[0] : null);
  };
}

/**
 * @param {Array<{recordIndex:number, values:Object.<string,*>, source?:string}>} records
 *   Ingest records from {@link module:pipeline/ingest}.
 * @param {object} manifest - A manifest that has passed validation.
 * @returns {{records: Array, anomalies: Array}}
 */
function applyManifest(records, manifest) {
  const anomalies = [];
  const fields = manifest.fields.filter(
    (f) => (f.to !== undefined && f.to !== null) || (Array.isArray(f.emits) && f.emits.length)
  );

  // Resolve each field's `from` against the actual ingest keys. Models sometimes
  // emit a bare column ("RESULT_ID") where ingest keys are namespaced
  // ("order_results.RESULT_ID"), or vice-versa; resolve both, and flag any that
  // genuinely don't exist rather than silently producing nulls.
  const resolve = buildResolver(records);
  const resolvedFrom = new Map();
  const consumed = new Set();      // source keys the manifest actually maps → not remainder
  const lineage = [];              // dataset-level: how each canonical path is produced from a source column
  for (const f of fields) {
    const key = resolve(f.from);
    resolvedFrom.set(f, key);
    if (key === null) {
      anomalies.push({
        from: f.from,
        kind: "unresolved_source",
        detail: `mapped source column "${f.from}" not found in the ingested data`,
      });
      continue;
    }
    consumed.add(key);
    const multi = Array.isArray(f.emits) && f.emits.length > 0;
    lineage.push({
      from: key,
      transform: f.transform && transforms.isTransform(f.transform) ? f.transform : null,
      to: multi ? f.emits.slice() : [f.to],
      multi,
    });
  }

  const out = records.map((rec, recordIndex) => {
    const values = {};

    for (const f of fields) {
      const key = resolvedFrom.get(f);
      const raw = key === null ? null : rec.values[key];
      const emits = Array.isArray(f.emits) && f.emits.length ? f.emits : null;

      if (f.transform && transforms.isTransform(f.transform)) {
        const fn = transforms.REGISTRY[f.transform];
        const result = fn(raw);

        if (emits) {
          // Multi-emit: zip the returned array onto the emit paths.
          const arr = Array.isArray(result) ? result : [];
          emits.forEach((p, i) => (values[p] = arr[i] ?? null));
          if (raw != null && String(raw).trim() !== "" && arr.every((x) => x == null)) {
            anomalies.push({
              recordIndex,
              from: f.from,
              transform: f.transform,
              kind: "transform_unparsed",
              detail: `"${f.transform}" could not parse ${JSON.stringify(raw)}`,
            });
          }
        } else {
          values[f.to] = result;
          if (raw != null && String(raw).trim() !== "" && result === null) {
            anomalies.push({
              recordIndex,
              from: f.from,
              transform: f.transform,
              kind: "transform_unparsed",
              detail: `"${f.transform}" nulled ${JSON.stringify(raw)}`,
            });
          }
        }
      } else {
        // No transform: pass through (blank → null).
        const v = raw === undefined || raw === null || String(raw).trim() === "" ? null : raw;
        if (emits) emits.forEach((p) => (values[p] = v));
        else values[f.to] = v;
      }
    }

    // The remainder: every source column the manifest did not consume, kept verbatim.
    // This is what makes the master lossless — nothing is dropped, only set aside.
    const remainder = {};
    for (const k of Object.keys(rec.values)) {
      if (!consumed.has(k)) remainder[k] = rec.values[k];
    }

    return {
      entity: manifest.entity || null,
      source: rec.source || manifest.source,
      recordIndex,
      values,               // the interpreted canonical view (one projection)
      raw: rec.values,      // exact ingested source (ground truth)
      remainder,            // unmapped source columns, retained — not dropped
    };
  });

  return { records: out, anomalies, lineage };
}

module.exports = { applyManifest };
