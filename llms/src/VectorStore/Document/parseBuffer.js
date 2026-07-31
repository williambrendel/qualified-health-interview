"use strict";

const computeVecOffsets = require("./computeVecOffsets");
const {
  VECT_MAGIC,
  VECT_VERSION,
  HEADER_BYTES,
} = require("./constants");

/**
 * Parse a VECT v2 buffer into the fields a Document needs.
 *
 * Returns typed-array VIEWS into the buffer — no copies. The returned views
 * share their underlying ArrayBuffer with the input. Callers that need to
 * detach the buffer (e.g. serialize the Document) should copy first.
 *
 * @param {Buffer} buffer
 * @returns {object} Fields suitable for Document construction.
 */
const parseBuffer = buffer => {
  // 1. Header (40 bytes).
  const header = new Uint32Array(buffer.buffer, buffer.byteOffset, 10);
  const [
    magic, version, indexDim, vecDim, numSections,
    totalVecs, indexBytes, vecBytes, documentIdBytes, /* reserved */
  ] = header;

  if (magic !== VECT_MAGIC) {
    throw new Error(`Invalid VECT binary: magic mismatch (got 0x${magic.toString(16)})`);
  }
  if (version !== VECT_VERSION) {
    throw new Error(`Unsupported VECT version: ${version} (expected ${VECT_VERSION})`);
  }

  let offset = HEADER_BYTES;

  // 2. documentId (UTF-8, padded to 4-byte boundary).
  const documentIdPadded = (documentIdBytes + 3) & ~3;
  const documentId = buffer.slice(offset, offset + documentIdBytes).toString("utf8");
  offset += documentIdPadded;

  // 3. Index buffer (Uint32).
  const indexBuffer = new Uint32Array(buffer.buffer, buffer.byteOffset + offset, indexBytes >> 2);
  offset += indexBytes;

  // 4. Vec buffer (Float32).
  const vecBuffer = new Float32Array(buffer.buffer, buffer.byteOffset + offset, vecBytes >> 2);

  return {
    documentId,
    version,
    indexDim,
    vecDim,
    numSections,
    totalVecs,
    indexBuffer,
    vecBuffer,
    vecOffsets: computeVecOffsets(indexBuffer, indexDim, numSections),
  };
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(parseBuffer, "parseBuffer", {
  value: parseBuffer,
}));