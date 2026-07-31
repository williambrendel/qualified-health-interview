"use strict";

/**
 * @file buildFromSpec.test.js
 * @brief Tests for the friendly-spec to Document-fields builder.
 *
 * `buildFromSpec` is the in-memory entry point — bypasses the binary
 * format. It's used by tests for fixture construction and by anyone who
 * already has vectors in hand. Correctness here ensures spec-based
 * fixtures produce the same Document-shape that real `.bin` loading does.
 */

const buildFromSpec = require("../../../src/VectorStore/Document/buildFromSpec");
const { VECT_VERSION } = require("../../../src/VectorStore/Document/constants");

const v = (...components) => new Float32Array(components);

describe("buildFromSpec — basic shape", () => {
  test("returns the full Document field set", () => {
    const fields = buildFromSpec({
      documentId: "test|doc",
      vecDim: 4,
      sections: [{ range: [0, 50], vectors: [v(1, 0, 0, 0)] }],
    });

    expect(fields).toMatchObject({
      documentId:  "test|doc",
      version:     VECT_VERSION,
      indexDim:    3,
      vecDim:      4,
      numSections: 1,
      totalVecs:   1,
    });
    expect(fields.indexBuffer).toBeInstanceOf(Uint32Array);
    expect(fields.vecBuffer).toBeInstanceOf(Float32Array);
    expect(fields.vecOffsets).toBeInstanceOf(Uint32Array);
  });

  test("version is always VECT_VERSION (synthetic Documents are current)", () => {
    const fields = buildFromSpec({ documentId: "x", vecDim: 2, sections: [] });
    expect(fields.version).toBe(VECT_VERSION);
  });

  test("indexDim is always 3", () => {
    const fields = buildFromSpec({ documentId: "x", vecDim: 2, sections: [] });
    expect(fields.indexDim).toBe(3);
  });
});

describe("buildFromSpec — totalVecs", () => {
  test("sums vector counts across sections", () => {
    const fields = buildFromSpec({
      documentId: "x",
      vecDim: 2,
      sections: [
        { range: [0, 10],  vectors: [v(1, 0), v(0, 1)] },     // 2
        { range: [10, 20], vectors: [v(1, 1)] },              // 1
        { range: [20, 30], vectors: [v(1, 0), v(0, 1), v(1, 1)] }, // 3
      ],
    });
    expect(fields.totalVecs).toBe(6);
  });

  test("zero for an empty document", () => {
    const fields = buildFromSpec({ documentId: "x", vecDim: 2, sections: [] });
    expect(fields.totalVecs).toBe(0);
  });

  test("zero when all sections are empty", () => {
    const fields = buildFromSpec({
      documentId: "x",
      vecDim: 2,
      sections: [{ range: [0, 10], vectors: [] }, { range: [10, 20], vectors: [] }],
    });
    expect(fields.totalVecs).toBe(0);
  });
});

describe("buildFromSpec — indexBuffer layout", () => {
  test("each section's (start, end, vecCount) appears in order", () => {
    const fields = buildFromSpec({
      documentId: "x",
      vecDim: 2,
      sections: [
        { range: [0, 50],    vectors: [v(1, 0), v(0, 1)] },
        { range: [50, 150],  vectors: [v(1, 1)] },
        { range: [150, 300], vectors: [] },
      ],
    });

    expect(Array.from(fields.indexBuffer)).toEqual([
      0,   50,  2,
      50,  150, 1,
      150, 300, 0,
    ]);
  });
});

describe("buildFromSpec — vecBuffer layout", () => {
  test("vectors are concatenated in section order, row-major", () => {
    const a = v(1, 0, 0, 0);
    const b = v(0, 1, 0, 0);
    const c = v(0, 0, 1, 0);
    const d = v(0, 0, 0, 1);

    const fields = buildFromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [
        { range: [0, 10],  vectors: [a, b] },
        { range: [10, 20], vectors: [c, d] },
      ],
    });

    expect(fields.vecBuffer.length).toBe(4 * 4); // 4 vectors × dim 4

    // Vectors in concatenation order: a, b, c, d.
    const expected = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];
    expect(Array.from(fields.vecBuffer)).toEqual(expected);
  });

  test("empty sections contribute no vectors", () => {
    const fields = buildFromSpec({
      documentId: "x",
      vecDim: 2,
      sections: [
        { range: [0, 10],  vectors: [v(1, 0)] },
        { range: [10, 20], vectors: [] },           // empty
        { range: [20, 30], vectors: [v(0, 1)] },
      ],
    });

    // vecBuffer holds 2 vectors × dim 2 = 4 floats.
    expect(fields.vecBuffer.length).toBe(4);
    expect(Array.from(fields.vecBuffer)).toEqual([1, 0, 0, 1]);
  });
});

describe("buildFromSpec — vecOffsets", () => {
  test("correctly computed from indexBuffer", () => {
    const fields = buildFromSpec({
      documentId: "x",
      vecDim: 2,
      sections: [
        { range: [0, 10],  vectors: [v(1, 0), v(0, 1)] }, // 2
        { range: [10, 20], vectors: [] },                  // 0
        { range: [20, 30], vectors: [v(1, 1), v(1, 0), v(0, 1)] }, // 3
      ],
    });
    expect(Array.from(fields.vecOffsets)).toEqual([0, 2, 2, 5]);
  });
});

describe("buildFromSpec — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof buildFromSpec).toBe("function");
  });

  test("exposes a self-referential .buildFromSpec property", () => {
    expect(buildFromSpec.buildFromSpec).toBe(buildFromSpec);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(buildFromSpec)).toBe(true);
  });
});
