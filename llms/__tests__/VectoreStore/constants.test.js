"use strict";

/**
 * @file constants.test.js
 * @brief Tests for the VectorStore tuning constants.
 *
 * These constants drive the search pipeline's behavior — pruning,
 * rerank, safety rails. Pinning the values makes any change to them
 * loud and reviewable, because they affect every search the system
 * runs.
 */

const constants = require("../../src/VectorStore/constants");

describe("VectorStore/constants — defensive floor", () => {
  test("ABSOLUTE_FLOOR is 0.3 (encoder-calibrated)", () => {
    expect(constants.ABSOLUTE_FLOOR).toBe(0.3);
  });
});

describe("VectorStore/constants — output bounds", () => {
  test("MIN_OUTPUT_ROWS is 3", () => {
    expect(constants.MIN_OUTPUT_ROWS).toBe(3);
  });

  test("MAX_OUTPUT_ROWS is 12", () => {
    expect(constants.MAX_OUTPUT_ROWS).toBe(12);
  });

  test("MIN_OUTPUT_ROWS does not exceed MAX_OUTPUT_ROWS", () => {
    expect(constants.MIN_OUTPUT_ROWS).toBeLessThanOrEqual(constants.MAX_OUTPUT_ROWS);
  });
});

describe("VectorStore/constants — rerank", () => {
  test("RERANK_ENABLED is true by default", () => {
    expect(constants.RERANK_ENABLED).toBe(true);
  });

  test("RERANK_THRESHOLD is 0.5", () => {
    expect(constants.RERANK_THRESHOLD).toBe(0.5);
  });

  test("RERANK_THRESHOLD is a fraction in (0, 1]", () => {
    expect(constants.RERANK_THRESHOLD).toBeGreaterThan(0);
    expect(constants.RERANK_THRESHOLD).toBeLessThanOrEqual(1);
  });

  test("RERANK_EXTENSION_RATIO is 0.7", () => {
    expect(constants.RERANK_EXTENSION_RATIO).toBe(0.7);
  });

  test("RERANK_EXTENSION_RATIO is a fraction in (0, 1]", () => {
    expect(constants.RERANK_EXTENSION_RATIO).toBeGreaterThan(0);
    expect(constants.RERANK_EXTENSION_RATIO).toBeLessThanOrEqual(1);
  });

  test("RERANK_EXTENSION_MAX is 12", () => {
    expect(constants.RERANK_EXTENSION_MAX).toBe(12);
  });
});

describe("VectorStore/constants — module conventions", () => {
  test("the module is frozen", () => {
    expect(Object.isFrozen(constants)).toBe(true);
  });

  test("exports exactly the 13 expected keys", () => {
    expect(Object.keys(constants).sort()).toEqual([
      "ABSOLUTE_FLOOR",
      "MAX_CUT_INDEX",
      "MAX_OUTPUT_ROWS",
      "MIN_OUTPUT_ROWS",
      "PIVOT_ENABLED",
      "PIVOT_MAX_RESULTS",
      "PIVOT_MIN_ANCHOR_SCORE",
      "PIVOT_MIN_RESULTS",
      "RATIO_MIN_GAP",
      "RERANK_ENABLED",
      "RERANK_EXTENSION_MAX",
      "RERANK_EXTENSION_RATIO",
      "RERANK_THRESHOLD",
    ]);
  });
});
