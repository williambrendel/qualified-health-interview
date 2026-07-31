"use strict";

/**
 * @file index.js
 * @module VectorStore/Document
 * @description In-memory representation of a single VECT v2 binary.
 *
 * A `Document` carries the parsed header, a UTF-8 documentId, and zero-copy
 * typed-array views into the binary's index and vector buffers. It owns the
 * knowledge of how vectors are laid out per section and exposes that
 * knowledge through {@link Document#score} and {@link Document#getSection}.
 *
 * Public fields (set by the constructor):
 *   - documentId   {string}        UTF-8 identifier embedded in the header
 *   - version      {number}        VECT format version
 *   - indexDim     {number}        Always 3 — (start, end, vecCount) tuples
 *   - vecDim       {number}        Embedding dimensionality
 *   - numSections  {number}        Number of sections in the document
 *   - totalVecs    {number}        Total vectors across all sections
 *   - indexBuffer  {Uint32Array}   Flat (start, end, vecCount) × numSections
 *   - vecBuffer    {Float32Array}  All vectors concatenated, row-major
 *   - vecOffsets   {Uint32Array}   Prefix sum of per-section vecCount
 *
 * Three entry points:
 *   - {@link Document.fromBuffer} parses a `.bin` file's contents into a
 *     Document. Used by `loadKnowledgeBase`.
 *   - {@link Document.fromBuffer}: if the input is the file, it loads the file first.
 *   - {@link Document.fromSpec} builds a Document from a friendly spec.
 *     Used by tests to construct in-memory fixtures without round-tripping
 *     through the binary format.
 *
 * Vectors are assumed L2-normalized. Dot product is used directly as
 * cosine similarity. Feeding non-normalized vectors produces incorrect
 * scores silently.
 */

const fs = require("fs").promises;
const { dotProductUnsafeBatch } = require("../../utilities/math/dotProduct");
const search = require("../search");
const { ABSOLUTE_FLOOR } = require("../constants");

// ─────────────────────────────────────────────────────────────────────────────
// Module helpers
// ─────────────────────────────────────────────────────────────────────────────
const buildFromSpec = require("./buildFromSpec");
const computeVecOffsets = require("./computeVecOffsets");
const parseBuffer = require("./parseBuffer");
const serializeBuffer = require("./serializeBuffer");

// ─────────────────────────────────────────────────────────────────────────────
// Document
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @class Document
 * @description In-memory VECT v2 knowledge base.
 */
class Document {
  /**
   * Construct a Document from already-parsed fields. Callers should
   * typically use {@link Document.fromBuffer}, {@link Document.fromSpec}
   * or {@link Document.fromTexts} rather than calling the constructor directly.
   *
   * @param {object} fields - The output of `parseBuffer` or `buildFromSpec`.
   * @param {string} fields.documentId
   * @param {number} fields.version
   * @param {number} fields.indexDim
   * @param {number} fields.vecDim
   * @param {number} fields.numSections
   * @param {number} fields.totalVecs
   * @param {Uint32Array}  fields.indexBuffer
   * @param {Float32Array} fields.vecBuffer
   * @param {Uint32Array}  [fields.vecOffsets]
   */
  constructor({
    documentId, version, indexDim, vecDim,
    numSections, totalVecs,
    indexBuffer, vecBuffer, vecOffsets,
  } = {}) {
    this.documentId  = documentId;
    this.version     = version;
    this.indexDim    = indexDim;
    this.vecDim      = vecDim;
    this.numSections = numSections;
    this.totalVecs   = totalVecs;
    this.indexBuffer = indexBuffer;
    this.vecBuffer   = vecBuffer;
    this.vecOffsets  = vecOffsets || computeVecOffsets(indexBuffer, indexDim, numSections);
  }

  /**
   * Look up a section by index. Returns the section's character range and a
   * Float32Array view containing all of its vectors concatenated.
   *
   * @param {number} i - Section index, `0 ≤ i < numSections`.
   * @returns {{ start: number, end: number, vectors: Float32Array }}
   */
  getSection(i) {
    const { indexBuffer, indexDim, vecBuffer, vecDim, vecOffsets } = this;
    return {
      start:   indexBuffer[i * indexDim    ],
      end:     indexBuffer[i * indexDim + 1],
      vectors: vecBuffer.subarray(vecOffsets[i] * vecDim, vecOffsets[i + 1] * vecDim),
    };
  }

  /**
   * Score every section in this document against `queryVec`.
   *
   * Computes dot products for ALL vectors in the document in one batched
   * call to {@link dotProductUnsafeBatch}, then post-processes the results
   * to extract each section's max. The batched dot product is significantly
   * faster than an inline loop because it unrolls the per-element
   * multiplication 4x — the CPU's multiplier pipeline stays busy through
   * the hot path.
   *
   * A section's score is the **maximum** dot product across its vectors
   * (breadcrumb, body, question, anchors, variants — each a different
   * phrasing of the section's content). The section matches the query if
   * any one of those phrasings is close to it.
   *
   * Sections scoring strictly below `floor` are dropped.
   *
   * @param {Float32Array} queryVec - L2-normalized query embedding. Must be
   *   a Float32Array; other array-like inputs are rejected because the
   *   batched dot product is materially slower on non-typed inputs.
   * @param {number} [floor=ABSOLUTE_FLOOR] - Drop hits below this score.
   *
   * @returns {Array<{
   *   score:      number,
   *   documentId: string,
   *   range:      [number, number],
   *   bestVec:    Float32Array
   * }>} One hit per surviving section.
   *
   *   - `score`      — the section's best dot product against the query.
   *   - `documentId` — this document's id, copied onto every hit for
   *                    cross-document use by {@link VectorStore}.
   *   - `range`      — the section's `[start, end]` character offsets into
   *                    the source markdown.
   *   - `bestVec`    — a zero-copy Float32Array view of the single vector
   *                    that produced this section's score. Used by rerank
   *                    to compute the candidate-set centroid. Stripped by
   *                    {@link module:VectorStore/search} before hits leave
   *                    the pipeline, but kept here so direct callers can
   *                    inspect or repurpose it.
   *
   * @throws {Error} If `queryVec` is not a `Float32Array`, or its length
   *   does not match this document's vector dimension.
   */
  static score(document, queryVec, floor = ABSOLUTE_FLOOR) {
    const {
      vecDim, indexDim, numSections, totalVecs,
      indexBuffer, vecBuffer, vecOffsets, documentId,
    } = document;

    if (!(queryVec instanceof Float32Array)) {
      throw new Error("Document.score: queryVec must be a Float32Array");
    }
    if (queryVec.length !== vecDim) {
      throw new Error(
        `Document.score: queryVec dim ${queryVec.length} does not match ` +
        `document "${documentId}" dim ${vecDim}`
      );
    }

    // ── Batched dot product over the entire document's vec buffer ────────
    // Produces a Float32Array of length `totalVecs` where allScores[v] is
    // the cosine similarity (since vectors are L2-normalized) between the
    // query and the v-th vector in the document.
    //
    // We pay for every vector's dot product, but we needed every one of
    // them anyway to find each section's max. The batched form is faster
    // per dot product than an inline loop — pure speed win, no extra work.
    const allScores = dotProductUnsafeBatch(queryVec, vecBuffer, totalVecs, vecDim);

    // ── Per-section max scan ────────────────────────────────────────────
    // Cheap O(totalVecs) pass through the score array. No more
    // multiplications — just comparisons.
    const out = new Array(numSections);
    let l = 0;
    for (let s = 0, index; s !== numSections; ++s) {
      const startVec = vecOffsets[s];
      const endVec   = vecOffsets[s + 1];

      // Empty section — present in the index but no vectors. Skip.
      if (startVec === endVec) continue;

      let best = -Infinity, bestVecIdx = startVec;
      for (let v = startVec; v !== endVec; ++v) {
        allScores[v] > best && (
          best = allScores[v],
          bestVecIdx = v
        );
      }

      // Floor cut — drop sections whose best phrasing didn't clear the bar.
      if (best < floor) continue;

      out[l++] = {
        score: best,
        documentId,
        range: [
          indexBuffer[index = s * indexDim ],
          indexBuffer[index + 1],
        ],
        bestVec: vecBuffer.subarray(bestVecIdx *= vecDim, bestVecIdx + vecDim),
      };
    }
    out.length = l;

    return out;
  }
  score(queryVec, floor = ABSOLUTE_FLOOR) { return Document.score(this, queryVec, floor); }

  /**
   * Search this document against `queryVec`, returning hits filtered by
   * the full pipeline (pruning, optional rerank, safety rails, cap).
   *
   * Implementation delegates to {@link module:VectorStore/search} — the
   * external function wraps a single Document in a one-element array
   * before running the pipeline, so single-document and multi-document
   * searches share one code path.
   *
   * @param {Float32Array} queryVec
   * @param {object} [options] - See {@link module:VectorStore/search} for
   *   the full option set.
   * @returns {Array<{ score: number, documentId: string, range: [number, number] }>}
   */
  static search (document, queryVec, options) {
    return search(document, queryVec, options);
  }
  search(queryVec, options) {
    return Document.search(this, queryVec, options);
  }

  /**
   * Parse a VECT v2 buffer into a Document.
   *
   * @param {Buffer} buffer
   * @returns {Document}
   *
   * @throws {Error} On magic-number or version mismatch.
   */
  static fromBuffer(buffer) {
    return new Document(parseBuffer(buffer));
  }

  /**
   * Build a Document from a high-level spec. Intended for tests and
   * scripted fixtures — constructs the internal buffers from a
   * `{ documentId, vecDim, sections: [{ range, vectors }, ...] }` spec
   * without round-tripping through the binary format.
   *
   * @param {object} spec
   * @returns {Document}
   */
  static fromSpec(spec) {
    return new Document(buildFromSpec(spec));
  }

  /**
   * Build a Document from a list of texts using a caller-supplied encoder.
   *
   * Convenience wrapper for the common case where the caller has strings
   * (anchors, passages, simple corpora) rather than pre-computed vectors.
   * Encodes every text in parallel via `encode`, packs the results into a
   * single-section Document, and returns it.
   *
   * Encoder choice is intentional and required — Document does not assume
   * a default. Callers using a BGE-family encoder should pass `embedQuery`
   * for query-side text (e.g. classifier anchors describing what a user
   * might ask) and raw `vectorize` for passage-side text (e.g. document
   * content being indexed). Mixing the two subspaces in one corpus
   * silently degrades retrieval quality, so the asymmetry stays explicit
   * at the call site.
   *
   * Section structure: the returned Document has exactly one section
   * containing all encoded vectors. {@link Document#score} will return
   * the max cosine across them as a single hit — which is the desired
   * behavior for classifier anchors (best-anchor-match) and for any
   * other "is this text similar to any of these references?" use case.
   * Callers that need multiple sections should use {@link Document.fromSpec}
   * directly.
   *
   * @async
   * @function Document.fromTexts
   *
   * @param {object} options
   * @param {string}       options.documentId
   *   The Document's id. For classifiers this is conventionally the class
   *   label (e.g. "TECHNICAL"), since that's what surfaces on each hit
   *   via the `documentId` field on `Document#score` output.
   * @param {string[]}     options.texts
   *   Strings to encode and pack. Must be non-empty.
   * @param {(text: string) => Promise<Float32Array>} options.encode
   *   Encoder function. Each text is awaited in parallel via `Promise.all`.
   *   Typically `embedQuery` or `vectorize`.
   * @param {[number, number]} [options.range=[0, 0]]
   *   Character range for the synthetic single section. Defaults to
   *   `[0, 0]` for cases where there's no source text (classifiers,
   *   ad-hoc corpora). Pass real offsets when they're meaningful.
   *
   * @returns {Promise<Document>}
   *
   * @throws {Error} If `texts` is empty, or if `encode` is not a function.
   *
   * @example <caption>Building a classifier anchor Document</caption>
   *   const doc = await Document.fromTexts({
   *     documentId: "TECHNICAL",
   *     texts: [
   *       "a question about water treatment chemistry",
   *       "a question about cooling towers or boilers",
   *     ],
   *     encode: embedQuery,
   *   });
   */
  static async fromTexts({
    documentId,
    str, txt = str, text = txt, texts = text,
    vectorize, encode = vectorize,
    start = 0, end = 0, range = [start, end]
  } = {}) {
    typeof texts === "string" && (texts = [texts]);
    if (!(Array.isArray(texts) && (texts = texts.filter(Boolean)).length)) {
      throw new Error("Document.fromTexts: texts must be a non-empty array");
    }
    if (typeof encode !== "function") {
      throw new Error("Document.fromTexts: encode must be a function");
    }
 
    // Encode all texts in parallel. The encoder is expected to queue
    // internally if the underlying model can only run one inference at a
    // time; we just hand off the promises and let Promise.all collect them.
    const vectors = await Promise.all(texts.map(t => encode(t)));
 
    // All vectors share the same dim (same encoder). Capture from the first.
    const vecDim = vectors[0].length;
 
    return Document.fromSpec({
      documentId,
      vecDim,
      sections: [{ range, vectors }],
    });
  }

  /**
   * Construct a Document from any supported input source. Dispatches on
   * the input type:
   *
   *   - `string` (filepath) — reads the file and parses the resulting buffer.
   *     Asynchronous: returns `Promise<Document>` that resolves after I/O.
   *   - `Buffer` (raw bytes) — parses directly, no I/O. Still async-returns
   *     for return-type consistency across input types.
   *   - object (spec) — builds from a friendly spec. Test/fixture path.
   *
   * For callers that know the input type and want a synchronous result,
   * {@link Document.fromBuffer} and {@link Document.fromSpec} are the
   * direct sync entry points. {@link Document.fromTexts} is the async
   * builder for the "I have strings, please encode and pack" case.
   *
   * @async
   * @param {string|Buffer|object} input - Filepath, raw VECT buffer, or spec.
   * @returns {Promise<Document>}
   *
   * @throws {Error} On magic-number or version mismatch (buffer / filepath
   *   paths), file read errors (filepath path), or malformed spec (spec path).
   */
  static async create(input) {
    if (typeof input === "string") {
      const buffer = await fs.readFile(input);
      return Document.fromBuffer(buffer);
    }
    if (Buffer.isBuffer(input)) {
      return Document.fromBuffer(input);
    }
    return Document.fromSpec(input);
  }

  /**
   * Serialize this Document back into a VECT v2 buffer.
   *
   * Inverse of {@link Document.fromBuffer}. Round-trip is bit-identical:
   * `Document.fromBuffer(doc.toBuffer())` produces a Document with the
   * same fields and the same binary representation.
   *
   * Allocates a fresh `Buffer`; does not modify or share storage with the
   * Document's internal typed-array views. Safe to call repeatedly.
   *
   * @returns {Buffer} VECT v2 binary.
   */
  toBuffer() {
    return serializeBuffer(this);
  }
 
  /**
   * Serialize this Document and write it to disk.
   *
   * Equivalent to `fs.writeFile(filepath, this.toBuffer())`. Does NOT
   * create intermediate directories — callers are responsible for ensuring
   * `dirname(filepath)` exists, since path layout is a build-pipeline
   * concern, not a Document concern.
   *
   * @async
   * @param {string} filepath - Destination path. Conventionally ends in `.bin`.
   * @returns {Promise<Document>} The instance, for chaining.
   */
  async write(filepath) {
    await fs.writeFile(filepath, this.toBuffer());
    return this;
  }
}

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(Document, "Document", {
  value: Document,
}));