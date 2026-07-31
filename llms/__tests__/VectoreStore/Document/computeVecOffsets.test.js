"use strict";

/**
 * @file computeVecOffsets.test.js
 * @brief Tests for the prefix-sum helper.
 *
 * `computeVecOffsets` reads `vecCount` at index `i*indexDim + 2` for each
 * section and produces an `(numSections + 1)`-length cumulative sum.
 * Correctness here is foundational — both parsing and score iteration
 * depend on the output being right.
 */

const computeVecOffsets = require("../../../src/VectorStore/Document/computeVecOffsets");

/**
 * Build an index buffer from a list of (start, end, vecCount) tuples.
 */
const indexBufferOf = sections => {
  const buf = new Uint32Array(sections.length * 3);
  for (let i = 0; i !== sections.length; ++i) {
    buf[i * 3    ] = sections[i][0];
    buf[i * 3 + 1] = sections[i][1];
    buf[i * 3 + 2] = sections[i][2];
  }
  return buf;
};

describe("computeVecOffsets — basic correctness", () => {
  test("typical case: section counts [2, 1, 3]", () => {
    const idx = indexBufferOf([[0, 50, 2], [50, 100, 1], [100, 200, 3]]);
    const offsets = computeVecOffsets(idx, 3, 3);
    expect(Array.from(offsets)).toEqual([0, 2, 3, 6]);
  });

  test("returns Uint32Array of length numSections + 1", () => {
    const idx = indexBufferOf([[0, 10, 1], [10, 20, 1]]);
    const offsets = computeVecOffsets(idx, 3, 2);
    expect(offsets).toBeInstanceOf(Uint32Array);
    expect(offsets.length).toBe(3);
  });

  test("first offset is always 0", () => {
    const idx = indexBufferOf([[0, 10, 42]]);
    expect(computeVecOffsets(idx, 3, 1)[0]).toBe(0);
  });

  test("last offset equals total vector count", () => {
    const idx = indexBufferOf([[0, 10, 4], [10, 20, 7], [20, 30, 2]]);
    const offsets = computeVecOffsets(idx, 3, 3);
    expect(offsets[3]).toBe(13); // 4 + 7 + 2
  });
});

describe("computeVecOffsets — edge cases", () => {
  test("zero sections produces a single-element [0] array", () => {
    const offsets = computeVecOffsets(new Uint32Array(0), 3, 0);
    expect(Array.from(offsets)).toEqual([0]);
  });

  test("single empty section [0, 10, 0]", () => {
    const idx = indexBufferOf([[0, 10, 0]]);
    expect(Array.from(computeVecOffsets(idx, 3, 1))).toEqual([0, 0]);
  });

  test("empty sections interleaved with non-empty", () => {
    const idx = indexBufferOf([
      [0, 10, 2],
      [10, 20, 0],   // empty
      [20, 30, 3],
      [30, 40, 0],   // empty
      [40, 50, 1],
    ]);
    expect(Array.from(computeVecOffsets(idx, 3, 5))).toEqual([0, 2, 2, 5, 5, 6]);
  });

  test("all sections empty", () => {
    const idx = indexBufferOf([[0, 10, 0], [10, 20, 0], [20, 30, 0]]);
    expect(Array.from(computeVecOffsets(idx, 3, 3))).toEqual([0, 0, 0, 0]);
  });
});

describe("computeVecOffsets — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof computeVecOffsets).toBe("function");
  });

  test("exposes a self-referential .computeVecOffsets property", () => {
    expect(computeVecOffsets.computeVecOffsets).toBe(computeVecOffsets);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(computeVecOffsets)).toBe(true);
  });
});
