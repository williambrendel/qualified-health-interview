"use strict";

const {
  VECT_MAGIC,
  VECT_VERSION,
  HEADER_BYTES,
} = require("./constants");

/**
 * Serialize a Document's parsed fields back into a VECT v2 buffer.
 *
 * Inverse of {@link parseBuffer}. Reads the same field set the constructor
 * stores on the instance and produces a byte-identical binary (round-trip
 * preserves all observable state).
 *
 * Layout produced:
 *   1. Header (40 bytes): magic, version, dims, counts, sizes.
 *   2. documentId (UTF-8, padded to 4-byte boundary).
 *   3. Index buffer (Uint32 little-endian).
 *   4. Vec buffer (Float32 little-endian).
 *
 * Steps 3 and 4 are bit-copied via Buffer.from(typedArray.buffer, ...) —
 * no per-element conversion. The serializer assumes the host is little-
 * endian (which Node guarantees on every supported platform).
 *
 * @param {object} fields - Document fields (same shape as parseBuffer's return).
 * @returns {Buffer}
 */
const serializeBuffer = ({
  documentId, indexDim, vecDim, numSections, totalVecs,
  indexBuffer, vecBuffer,
}) => {
  const idBytes  = Buffer.byteLength(documentId, "utf8");
  const idPadded = (idBytes + 3) & ~3;
 
  const indexBytes = numSections * indexDim * 4;
  const vecBytes   = totalVecs * vecDim * 4;
 
  const totalBytes = HEADER_BYTES + idPadded + indexBytes + vecBytes;
  const out = Buffer.alloc(totalBytes);
 
  // Header (10 × Uint32, little-endian).
  const header = new Uint32Array(out.buffer, out.byteOffset, 10);
  header[0] = VECT_MAGIC;
  header[1] = VECT_VERSION;
  header[2] = indexDim;
  header[3] = vecDim;
  header[4] = numSections;
  header[5] = totalVecs;
  header[6] = indexBytes;
  header[7] = vecBytes;
  header[8] = idBytes;
  header[9] = 0; // reserved
 
  let offset = HEADER_BYTES;
 
  // documentId — Buffer.alloc zero-fills, so the padding tail is already
  // zeroed; we only need to write the UTF-8 bytes themselves.
  out.write(documentId, offset, idBytes, "utf8");
  offset += idPadded;
 
  // Index buffer — bit-copy.
  Buffer.from(indexBuffer.buffer, indexBuffer.byteOffset, indexBytes).copy(out, offset);
  offset += indexBytes;
 
  // Vec buffer — bit-copy.
  Buffer.from(vecBuffer.buffer, vecBuffer.byteOffset, vecBytes).copy(out, offset);
 
  return out;
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(serializeBuffer, "serializeBuffer", {
  value: serializeBuffer,
}));