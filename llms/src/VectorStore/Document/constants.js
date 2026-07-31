"use strict";

/**
 * @file constants.js
 * @module VectorStore/Document/constants
 * @description VECT binary format constants. These describe the layout of
 * a `.bin` file on disk and the in-memory shape of a {@link Document}.
 *
 * Build-time tuning constants (e.g. word-count thresholds for the
 * vectorization heuristic) live inline in
 * `src/actions/generate/binary/extractSections.js` since they belong
 * to the build pipeline, not the data structure.
 */

/**
 * Magic number identifying a VECT binary. ASCII "VECT" interpreted as a
 * little-endian Uint32. Written by the serializer, verified by the loader.
 *
 * @type {number}
 */
const VECT_MAGIC = 0x56454354;

/**
 * Current VECT binary format version.
 *
 * v2 added an embedded `documentId` string region between the header and
 * the index buffer. Older versions are rejected at load time.
 *
 * @type {number}
 */
const VECT_VERSION = 2;

/**
 * Total header size in bytes (10 × Uint32).
 *
 * Header layout:
 *   [0] magic              = VECT_MAGIC
 *   [1] version            = VECT_VERSION
 *   [2] indexDim           = 3 (start, end, vecCount per section)
 *   [3] vecDim             = embedding dimension
 *   [4] numSections
 *   [5] totalVecs
 *   [6] indexBytes
 *   [7] vecBytes
 *   [8] documentIdBytes    = UTF-8 byte length of the embedded ID
 *   [9] reserved           = 0
 *
 * @type {number}
 */
const HEADER_BYTES = 40;

module.exports = Object.freeze({
  VECT_MAGIC,
  VECT_VERSION,
  HEADER_BYTES,
});