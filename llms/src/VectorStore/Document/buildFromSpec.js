"use strict";

const { VECT_VERSION } = require("./constants");
const computeVecOffsets = require("./computeVecOffsets");

/**
 * Build a Document's internal buffers from a high-level spec.
 *
 * The spec format is friendlier than raw buffers for tests and
 * inspections — sections are described as `{ range: [s, e], vectors: [vec, ...] }`
 * tuples, and the helper materializes the index and vec buffers internally.
 *
 * @param {object} spec
 * @param {string} spec.documentId
 * @param {number} spec.vecDim
 * @param {Array<{ range: [number, number], vectors: Float32Array[] }>} spec.sections
 * @returns {object} Same shape as {@link parseBuffer}'s return.
 */
const buildFromSpec = spec => {
  const { documentId, vecDim, sections } = spec;
  const numSections = sections.length;
  const indexDim = 3;
 
  let totalVecs = 0;
  for (let i = 0; i !== numSections; ++i) totalVecs += sections[i].vectors.length;
 
  const indexBuffer = new Uint32Array(numSections * indexDim);
  for (let i = 0; i !== numSections; ++i) {
    const { range, vectors } = sections[i];
    indexBuffer[i * indexDim    ] = range[0];
    indexBuffer[i * indexDim + 1] = range[1];
    indexBuffer[i * indexDim + 2] = vectors.length;
  }
 
  const vecBuffer = new Float32Array(totalVecs * vecDim);
  for (let i = 0, offset = 0; i !== numSections; ++i) {
    const vectors = sections[i].vectors;
    for (let j = 0, l = vectors.length; j !== l; ++j, offset += vecDim) {
      vecBuffer.set(vectors[j], offset);
    }
  }
 
  return {
    documentId,
    version: VECT_VERSION,
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
module.exports = Object.freeze(Object.defineProperty(buildFromSpec, "buildFromSpec", {
  value: buildFromSpec,
}));