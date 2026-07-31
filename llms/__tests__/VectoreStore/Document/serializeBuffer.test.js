"use strict";

/**
 * @file serializeBuffer.test.js
 * @brief Tests for the VECT v2 encoder.
 *
 * `serializeBuffer` is a pure function: `(fields) → Buffer`. These tests
 * inspect the produced buffer directly — header fields, byte counts,
 * alignment padding, and vector layout — without relying on `parseBuffer`.
 * Round-trip behavior is verified in `index.test.js`.
 */

const serializeBuffer = require("../../../src/VectorStore/Document/serializeBuffer");
const {
  VECT_MAGIC,
  VECT_VERSION,
  HEADER_BYTES,
} = require("../../../src/VectorStore/Document/constants");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic Float32Array of length `dim`. Same seed → same values.
 */
const makeVec = (dim, seed) => {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed * 17 + i * 0.1);
  return v;
};

/**
 * Build a complete fields object matching what serializeBuffer expects.
 */
const fieldsOf = ({ documentId, vecDim, sections }) => {
  const numSections = sections.length;
  let totalVecs = 0;
  for (let i = 0; i !== numSections; ++i) totalVecs += sections[i].vectors.length;

  const indexBuffer = new Uint32Array(numSections * 3);
  for (let i = 0; i !== numSections; ++i) {
    indexBuffer[i * 3    ] = sections[i].range[0];
    indexBuffer[i * 3 + 1] = sections[i].range[1];
    indexBuffer[i * 3 + 2] = sections[i].vectors.length;
  }

  const vecBuffer = new Float32Array(totalVecs * vecDim);
  for (let i = 0, off = 0; i !== numSections; ++i) {
    for (let j = 0, l = sections[i].vectors.length; j !== l; ++j, off += vecDim) {
      vecBuffer.set(sections[i].vectors[j], off);
    }
  }

  return { documentId, indexDim: 3, vecDim, numSections, totalVecs, indexBuffer, vecBuffer };
};

const readHeader = buf => new Uint32Array(buf.buffer, buf.byteOffset, 10);

// ─────────────────────────────────────────────────────────────────────────────
// Header values
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeBuffer — header values", () => {
  test("magic, version, dims, counts, and sizes match the layout spec", () => {
    const dim = 16;
    const buf = serializeBuffer(fieldsOf({
      documentId: "x|y",
      vecDim: dim,
      sections: [
        { range: [0, 100],   vectors: [makeVec(dim, 1), makeVec(dim, 2)] },
        { range: [100, 200], vectors: [makeVec(dim, 3)] },
      ],
    }));

    const h = readHeader(buf);
    expect(h[0]).toBe(VECT_MAGIC);
    expect(h[1]).toBe(VECT_VERSION);
    expect(h[2]).toBe(3);              // indexDim
    expect(h[3]).toBe(dim);            // vecDim
    expect(h[4]).toBe(2);              // numSections
    expect(h[5]).toBe(3);              // totalVecs
    expect(h[6]).toBe(2 * 3 * 4);      // indexBytes (2 sections × 3 Uint32 each)
    expect(h[7]).toBe(3 * dim * 4);    // vecBytes (3 vectors × dim × Float32)
    expect(h[8]).toBe(3);              // documentIdBytes ("x|y" = 3 bytes)
    expect(h[9]).toBe(0);              // reserved
  });

  test("documentIdBytes reflects raw UTF-8 byte length, not padded length", () => {
    const buf = serializeBuffer(fieldsOf({
      documentId: "abcde",            // 5 bytes, needs 3 pad
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [makeVec(4, 1)] }],
    }));
    expect(readHeader(buf)[8]).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Alignment padding
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeBuffer — documentId alignment padding", () => {
  /**
   * The documentId region is zero-padded to a 4-byte boundary so the index
   * buffer that follows stays aligned for a Uint32Array view.
   */
  const cases = [
    { documentId: "abcd",     padding: 0, label: "4 bytes (already aligned)" },
    { documentId: "abcde",    padding: 3, label: "5 bytes (needs 3 pad)"     },
    { documentId: "abcdef",   padding: 2, label: "6 bytes (needs 2 pad)"     },
    { documentId: "abcdefg",  padding: 1, label: "7 bytes (needs 1 pad)"     },
    { documentId: "abcdefgh", padding: 0, label: "8 bytes (already aligned)" },
  ];

  for (const { documentId, padding, label } of cases) {
    test(`documentId ${label}`, () => {
      const buf = serializeBuffer(fieldsOf({
        documentId,
        vecDim: 4,
        sections: [{ range: [0, 10], vectors: [makeVec(4, 1)] }],
      }));

      const idBytes  = Buffer.byteLength(documentId, "utf8");
      const idPadded = (idBytes + 3) & ~3;

      // Padding length is correct.
      expect(idPadded - idBytes).toBe(padding);

      // Total buffer size = header + (id + pad) + index + vec.
      const expectedSize = HEADER_BYTES + idPadded + (1 * 3 * 4) + (1 * 4 * 4);
      expect(buf.length).toBe(expectedSize);

      // Padding bytes themselves are zero.
      for (let i = 0; i < padding; i++) {
        expect(buf[HEADER_BYTES + idBytes + i]).toBe(0);
      }

      // The documentId bytes themselves are present at the expected offset.
      const idSlice = buf.slice(HEADER_BYTES, HEADER_BYTES + idBytes).toString("utf8");
      expect(idSlice).toBe(documentId);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-ASCII documentId
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeBuffer — non-ASCII documentId", () => {
  test("UTF-8 byte length differs from character length for multibyte chars", () => {
    // "résumé" is 8 bytes in UTF-8 (each é = 2 bytes), but 6 characters.
    const documentId = "doc|résumé";
    const buf = serializeBuffer(fieldsOf({
      documentId,
      vecDim: 4,
      sections: [{ range: [0, 5], vectors: [makeVec(4, 1)] }],
    }));

    expect(readHeader(buf)[8]).toBe(Buffer.byteLength(documentId, "utf8"));
    expect(readHeader(buf)[8]).not.toBe(documentId.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Index buffer layout
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeBuffer — index buffer layout", () => {
  test("each section's (start, end, vecCount) appears in order", () => {
    const buf = serializeBuffer(fieldsOf({
      documentId: "x|y",
      vecDim: 4,
      sections: [
        { range: [0, 10],   vectors: [makeVec(4, 1)] },
        { range: [10, 25],  vectors: [makeVec(4, 2), makeVec(4, 3)] },
        { range: [25, 100], vectors: [] },
      ],
    }));

    const h = readHeader(buf);
    const idBytes  = Buffer.byteLength("x|y", "utf8");
    const idPadded = (idBytes + 3) & ~3;
    const indexStart = HEADER_BYTES + idPadded;
    const indexView = new Uint32Array(
      buf.buffer, buf.byteOffset + indexStart, h[6] >> 2
    );

    expect(Array.from(indexView)).toEqual([
       0,  10, 1,
      10,  25, 2,
      25, 100, 0,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Vector buffer layout
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeBuffer — vector buffer layout", () => {
  test("vectors are concatenated in section order", () => {
    const dim = 4;
    const v1a = makeVec(dim, 1);
    const v1b = makeVec(dim, 2);
    const v2  = makeVec(dim, 3);

    const buf = serializeBuffer(fieldsOf({
      documentId: "x|y",
      vecDim: dim,
      sections: [
        { range: [0, 10],  vectors: [v1a, v1b] },
        { range: [10, 20], vectors: [v2] },
      ],
    }));

    const h = readHeader(buf);
    const idBytes  = Buffer.byteLength("x|y", "utf8");
    const idPadded = (idBytes + 3) & ~3;
    const vecStart = HEADER_BYTES + idPadded + h[6];

    const vecView = new Float32Array(
      buf.buffer, buf.byteOffset + vecStart, h[7] >> 2
    );

    for (let i = 0; i < dim; i++) expect(vecView[i]).toBe(v1a[i]);
    for (let i = 0; i < dim; i++) expect(vecView[dim + i]).toBe(v1b[i]);
    for (let i = 0; i < dim; i++) expect(vecView[2 * dim + i]).toBe(v2[i]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeBuffer — edge cases", () => {
  test("zero-section document", () => {
    const buf = serializeBuffer(fieldsOf({
      documentId: "empty",
      vecDim: 4,
      sections: [],
    }));

    const h = readHeader(buf);
    expect(h[4]).toBe(0);    // numSections
    expect(h[5]).toBe(0);    // totalVecs
    expect(h[6]).toBe(0);    // indexBytes
    expect(h[7]).toBe(0);    // vecBytes
    expect(buf.length).toBe(HEADER_BYTES + 8); // header + "empty" + 3 pad
  });

  test("sections present but no vectors anywhere", () => {
    const buf = serializeBuffer(fieldsOf({
      documentId: "x",
      vecDim: 4,
      sections: [{ range: [0, 50], vectors: [] }, { range: [50, 100], vectors: [] }],
    }));

    const h = readHeader(buf);
    expect(h[4]).toBe(2);    // numSections
    expect(h[5]).toBe(0);    // totalVecs
    expect(h[7]).toBe(0);    // vecBytes
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export conventions
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeBuffer — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof serializeBuffer).toBe("function");
  });

  test("exposes a self-referential .serializeBuffer property", () => {
    expect(serializeBuffer.serializeBuffer).toBe(serializeBuffer);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(serializeBuffer)).toBe(true);
  });
});
