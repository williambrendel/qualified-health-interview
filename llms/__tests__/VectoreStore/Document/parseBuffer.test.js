"use strict";

/**
 * @file parseBuffer.test.js
 * @brief Tests for the VECT v2 decoder.
 *
 * `parseBuffer` reads a `.bin`'s bytes and returns the Document field set.
 * These tests verify header parsing, error paths, view shapes, and that
 * downstream pointers remain aligned across documentId padding scenarios.
 *
 * Fixtures are produced by `serializeBuffer`. That isn't double-testing —
 * `serializeBuffer.test.js` pins its output independently. Here it's just
 * the cheapest way to produce a valid binary.
 */

const parseBuffer     = require("../../../src/VectorStore/Document/parseBuffer");
const serializeBuffer = require("../../../src/VectorStore/Document/serializeBuffer");
const { VECT_VERSION } = require("../../../src/VectorStore/Document/constants");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const makeVec = (dim, seed) => {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed * 17 + i * 0.1);
  return v;
};

const expectVecEqual = (actual, expected) => {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBe(expected[i]);
  }
};

/**
 * Build a complete fields object for serializeBuffer.
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

// ─────────────────────────────────────────────────────────────────────────────
// Top-level fields
// ─────────────────────────────────────────────────────────────────────────────

describe("parseBuffer — top-level fields", () => {
  test("returns documentId, version, dims, and counts", () => {
    const buf = serializeBuffer(fieldsOf({
      documentId: "theme|doc",
      vecDim: 4,
      sections: [
        { range: [0, 10],  vectors: [makeVec(4, 1), makeVec(4, 2)] },
        { range: [10, 20], vectors: [makeVec(4, 3)] },
      ],
    }));

    const fields = parseBuffer(buf);
    expect(fields.documentId).toBe("theme|doc");
    expect(fields.version).toBe(VECT_VERSION);
    expect(fields.indexDim).toBe(3);
    expect(fields.vecDim).toBe(4);
    expect(fields.numSections).toBe(2);
    expect(fields.totalVecs).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// vecOffsets prefix sum
// ─────────────────────────────────────────────────────────────────────────────

describe("parseBuffer — vecOffsets", () => {
  test("is a correct exclusive prefix sum of per-section vector counts", () => {
    const buf = serializeBuffer(fieldsOf({
      documentId: "t|d",
      vecDim: 4,
      sections: [
        { range: [0, 10],  vectors: [makeVec(4, 1), makeVec(4, 2)] }, // 2 vecs
        { range: [10, 20], vectors: [] },                              // 0 vecs
        { range: [20, 30], vectors: [makeVec(4, 3), makeVec(4, 4), makeVec(4, 5)] }, // 3
      ],
    }));

    const fields = parseBuffer(buf);
    expect(Array.from(fields.vecOffsets)).toEqual([0, 2, 2, 5]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Index and vec buffer round-trip via parse
// ─────────────────────────────────────────────────────────────────────────────

describe("parseBuffer — indexBuffer and vecBuffer recovery", () => {
  test("each section's range and vectors are recoverable", () => {
    const dim = 8;
    const v10 = makeVec(dim, 10);
    const v11 = makeVec(dim, 11);
    const v20 = makeVec(dim, 20);
    const v30 = makeVec(dim, 30);
    const v31 = makeVec(dim, 31);
    const v32 = makeVec(dim, 32);

    const buf = serializeBuffer(fieldsOf({
      documentId: "t|d",
      vecDim: dim,
      sections: [
        { range: [0, 50],    vectors: [v10, v11] },
        { range: [50, 200],  vectors: [v20] },
        { range: [200, 350], vectors: [v30, v31, v32] },
      ],
    }));

    const fields = parseBuffer(buf);

    // indexBuffer matches.
    expect(Array.from(fields.indexBuffer)).toEqual([
      0,   50,  2,
      50,  200, 1,
      200, 350, 3,
    ]);

    // vecBuffer contains all vectors in concatenation order.
    expect(fields.vecBuffer.length).toBe(6 * dim);
    expectVecEqual(fields.vecBuffer.subarray(0 * dim, 1 * dim), v10);
    expectVecEqual(fields.vecBuffer.subarray(1 * dim, 2 * dim), v11);
    expectVecEqual(fields.vecBuffer.subarray(2 * dim, 3 * dim), v20);
    expectVecEqual(fields.vecBuffer.subarray(3 * dim, 4 * dim), v30);
    expectVecEqual(fields.vecBuffer.subarray(4 * dim, 5 * dim), v31);
    expectVecEqual(fields.vecBuffer.subarray(5 * dim, 6 * dim), v32);
  });

  test("returned typed arrays are views into the source buffer (zero-copy)", () => {
    const buf = serializeBuffer(fieldsOf({
      documentId: "x",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [makeVec(4, 1)] }],
    }));

    const fields = parseBuffer(buf);
    expect(fields.indexBuffer.buffer).toBe(buf.buffer);
    expect(fields.vecBuffer.buffer).toBe(buf.buffer);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// documentId across alignment scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("parseBuffer — documentId across alignment paddings", () => {
  /**
   * The loader uses `(idBytes + 3) & ~3` math to skip past the padded ID
   * region. If either side miscomputes the padded length, the loader will
   * either read pad bytes into the string or start the index buffer at the
   * wrong offset, corrupting everything downstream.
   */
  const cases = ["abcd", "abcde", "abcdef", "abcdefg", "abcdefgh"];

  for (const documentId of cases) {
    test(`documentId="${documentId}" (${Buffer.byteLength(documentId, "utf8")} bytes)`, () => {
      const buf = serializeBuffer(fieldsOf({
        documentId,
        vecDim: 4,
        sections: [{ range: [42, 99], vectors: [makeVec(4, 1)] }],
      }));

      const fields = parseBuffer(buf);

      // ID reads back clean (no trailing nulls from the padding).
      expect(fields.documentId).toBe(documentId);

      // Downstream pointers still aligned correctly: section data intact.
      expect(fields.indexBuffer[0]).toBe(42);
      expect(fields.indexBuffer[1]).toBe(99);
      expect(fields.indexBuffer[2]).toBe(1);
      expectVecEqual(fields.vecBuffer.subarray(0, 4), makeVec(4, 1));
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-ASCII documentId
// ─────────────────────────────────────────────────────────────────────────────

describe("parseBuffer — non-ASCII documentId", () => {
  test("UTF-8 multibyte characters round-trip", () => {
    const documentId = "doc|résumé";
    const buf = serializeBuffer(fieldsOf({
      documentId,
      vecDim: 4,
      sections: [{ range: [0, 5], vectors: [makeVec(4, 1)] }],
    }));

    const fields = parseBuffer(buf);
    expect(fields.documentId).toBe(documentId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error paths
// ─────────────────────────────────────────────────────────────────────────────

describe("parseBuffer — error paths", () => {
  test("throws on magic-number mismatch", () => {
    const buf = serializeBuffer(fieldsOf({
      documentId: "x",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [makeVec(4, 1)] }],
    }));

    // Corrupt the magic at byte offset 0.
    const corrupted = Buffer.from(buf);
    corrupted.writeUInt32LE(0xDEADBEEF, 0);

    expect(() => parseBuffer(corrupted)).toThrow(/magic mismatch/);
  });

  test("throws on unsupported version", () => {
    const buf = serializeBuffer(fieldsOf({
      documentId: "x",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [makeVec(4, 1)] }],
    }));

    // Bump version at byte offset 4.
    const corrupted = Buffer.from(buf);
    corrupted.writeUInt32LE(VECT_VERSION + 99, 4);

    expect(() => parseBuffer(corrupted)).toThrow(/Unsupported VECT version/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export conventions
// ─────────────────────────────────────────────────────────────────────────────

describe("parseBuffer — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof parseBuffer).toBe("function");
  });

  test("exposes a self-referential .parseBuffer property", () => {
    expect(parseBuffer.parseBuffer).toBe(parseBuffer);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(parseBuffer)).toBe(true);
  });
});
