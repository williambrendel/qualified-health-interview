"use strict";

const Document = require("../../../VectorStore/Document");

/**
 * @file encodeSections.js
 * @module actions/generate/binary/encodeSections
 * @description Final stage of the binary pipeline. Resolves all
 * vectorize Promises that earlier stages pushed onto each
 * section's `vecs` array, then packs the resolved vectors into a
 * VECT binary via {@link Document.fromSpec}.
 *
 * ## Parallelism
 *
 * Every Promise in every section's `vecs` is awaited in one big
 * batch via `Promise.allSettled`. That's the maximum-fanout point
 * of the whole pipeline — for a typical file with ~30 sections of
 * ~10 vectors each, that's ~300 vectorize Promises in flight at
 * once.
 *
 * Why `allSettled` instead of `Promise.all`:
 *   - A single bad vectorize Promise (rare, but possible with
 *     local WASM models) would otherwise abort the entire encoding
 *     and lose all the work
 *   - `allSettled` preserves all successful vectors while
 *     surfacing the failed ones through the optional
 *     `onSectionError` callback
 *   - The Document still gets built with the surviving vectors;
 *     the file isn't lost just because one vector hiccupped
 *
 * ## Failure model
 *
 * Per-vector failures are tolerated:
 *   - Failed Promise → drop the vector, fire `onSectionError(i, err)`,
 *     continue
 *   - All vectors in a section fail → section gets zero vectors,
 *     still passed to Document.fromSpec (it'll be an empty section
 *     in the binary)
 *
 * Fundamental failures throw:
 *   - Sections not an array
 *   - Document.fromSpec / toBuffer throws (malformed input, OOM, etc.)
 */

/**
 * Encode a list of sections-with-vec-Promises into a VECT binary.
 *
 * @async
 * @param {object} options
 * @param {Array}    options.sections   - From extractSections (+ optional
 *   augmentSections). Each section must have `range: [start, end]` and
 *   `vecs: Promise<Float32Array>[]`.
 * @param {string}   options.documentId - Document ID string for the
 *   VECT header.
 * @param {number}   options.vecDim     - Embedding dimension. Caller
 *   probes once at boot via `vectorize("probe").length`.
 * @param {Function} [options.onSectionError] - Called when a section's
 *   vectorize Promise rejects. Signature `(sectionIndex, err) => void`.
 *   The failed vector is dropped; processing continues.
 *
 * @returns {Promise<Buffer>} The VECT binary buffer ready to write.
 *
 * @throws {Error} On fundamental setup failures or Document.fromSpec
 *   failures. Per-vector rejections are tolerated via callback.
 *
 * @example
 *   const buffer = await encodeSections({
 *     sections,
 *     documentId: "biocides|water_chemistry",
 *     vecDim: 384,
 *     onSectionError: (i, err) => console.warn(`section ${i}:`, err.message),
 *   });
 *   await fs.writeFile(outPath, buffer);
 */
const encodeSections = async ({
  sections,
  documentId,
  vecDim,
  onSectionError,
} = {}) => {
  // ── Input validation ─────────────────────────────────────────────────────
  if (!Array.isArray(sections)) {
    throw new Error("encodeSections: sections must be an array");
  }
  if (typeof documentId !== "string" || documentId.length === 0) {
    throw new Error("encodeSections: documentId must be a non-empty string");
  }
  if (!Number.isInteger(vecDim) || vecDim <= 0) {
    throw new Error("encodeSections: vecDim must be a positive integer");
  }

  // ── Resolve all vectorize Promises in parallel ───────────────────────────
  //
  // For each section, await its vecs as a single Promise.allSettled batch.
  // We do this per-section (not flat across all sections) because we need
  // to attribute failures to a section index for the callback. The actual
  // parallelism comes from JavaScript's event loop — all the underlying
  // vectorize() calls were issued by extractSections/augmentSections
  // EAGERLY, so the Promises are already in flight (or queued). Calling
  // Promise.allSettled here doesn't START anything; it just COLLECTS
  // results that are already pending.
  //
  // Equivalently in terms of total work: all vectorize calls across all
  // sections of all files in a batch share the same event loop, so they
  // all progress concurrently. The hierarchical Promise.allSettled here
  // is just for accounting.
  const perSection = await Promise.all(
    sections.map(s => Promise.allSettled(s.vecs || []))
  );

  // ── Build the per-section vector arrays, dropping failures ───────────────
  const docSections = [];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const results = perSection[i];
    const vectors = [];
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        vectors.push(r.value);
      } else {
        // Drop the failed vector but keep going. The section may still
        // have other successful vectors; the binary will be built with
        // whatever survives.
        onSectionError && onSectionError(i, r.reason);
      }
    }
    docSections.push({ range: section.range, vectors });
  }

  // ── Build the Document and serialize ─────────────────────────────────────
  //
  // Document.fromSpec validates input shape; on bad shape it'll throw,
  // which propagates as a fundamental "encode" failure.
  const doc = Document.fromSpec({
    documentId,
    vecDim,
    sections: docSections,
  });

  return doc.toBuffer();
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(encodeSections, "encodeSections", {
  value: encodeSections,
}));
