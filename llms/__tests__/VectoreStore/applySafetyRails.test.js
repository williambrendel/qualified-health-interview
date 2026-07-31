"use strict";

/**
 * @file applySafetyRails.test.js
 * @brief Tests for the MIN/MAX safety-rail enforcement.
 *
 * Pruning can leave hits below `MIN_OUTPUT_ROWS` (over-aggressive prune)
 * or above `MAX_OUTPUT_ROWS` (under-aggressive prune). `applySafetyRails`
 * brings the count into bounds in place. These tests cover both
 * directions and the no-op case.
 */

const applySafetyRails = require("../../src/VectorStore/applySafetyRails");
const {
  MIN_OUTPUT_ROWS,
  MAX_OUTPUT_ROWS,
} = require("../../src/VectorStore/constants");

const hits = (...scores) => scores.map(score => ({ score }));

// ─────────────────────────────────────────────────────────────────────────────
// MIN floor (restoration from snapshot)
// ─────────────────────────────────────────────────────────────────────────────

describe("applySafetyRails — MIN floor restoration", () => {
  test("restores hits up to MIN_OUTPUT_ROWS from the saved snapshot", () => {
    const saved = hits(0.95, 0.92, 0.88, 0.80, 0.70);
    const post  = saved.slice(0, 1); // pruning kept just the top hit

    applySafetyRails(post, saved);

    expect(post.length).toBe(MIN_OUTPUT_ROWS);
    expect(post.map(h => h.score)).toEqual([0.95, 0.92, 0.88]);
  });

  test("uses identity from saved when restoring (not new objects)", () => {
    const saved = hits(0.95, 0.92, 0.88);
    const post = [];

    applySafetyRails(post, saved);

    for (let i = 0; i < post.length; i++) {
      expect(post[i]).toBe(saved[i]);
    }
  });

  test("does not exceed saved.length when saved is small", () => {
    const saved = hits(0.95, 0.92); // only 2 hits total
    const post = [];

    applySafetyRails(post, saved);

    expect(post.length).toBe(2); // can't restore more than we have
    expect(post.map(h => h.score)).toEqual([0.95, 0.92]);
  });

  test("empty saved with empty hits stays empty", () => {
    const post  = [];
    const saved = [];
    applySafetyRails(post, saved);
    expect(post.length).toBe(0);
  });

  test("no restoration when post-prune already meets the floor", () => {
    // post already has MIN_OUTPUT_ROWS — leave it alone.
    const post  = hits(0.95, 0.92, 0.88);
    const saved = hits(0.95, 0.92, 0.88, 0.50, 0.40);
    const originalRef = post;

    applySafetyRails(post, saved);

    expect(post).toBe(originalRef);
    expect(post.length).toBe(MIN_OUTPUT_ROWS);
    expect(post[0].score).toBe(0.95);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MAX ceiling (truncation)
// ─────────────────────────────────────────────────────────────────────────────

describe("applySafetyRails — MAX ceiling truncation", () => {
  test("truncates a list above MAX_OUTPUT_ROWS down to MAX", () => {
    const count = MAX_OUTPUT_ROWS + 5;
    const post = Array(count).fill(null).map((_, i) => ({ score: 0.9 - i * 0.01 }));
    const saved = post.slice();

    applySafetyRails(post, saved);

    expect(post.length).toBe(MAX_OUTPUT_ROWS);
    // Top hits preserved in order.
    expect(post[0].score).toBe(0.9);
  });

  test("exact-MAX list is untouched", () => {
    const post = Array(MAX_OUTPUT_ROWS).fill(null).map((_, i) => ({ score: 0.9 - i * 0.01 }));
    const saved = post.slice();
    const ref = post;

    applySafetyRails(post, saved);

    expect(post).toBe(ref);
    expect(post.length).toBe(MAX_OUTPUT_ROWS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined: empty post + huge saved exercises both rails
// ─────────────────────────────────────────────────────────────────────────────

describe("applySafetyRails — combined edges", () => {
  test("empty post with oversized saved restores to MIN, not MAX", () => {
    // Adaptive prune emptied the list; saved holds the original ranking.
    // Should restore exactly MIN_OUTPUT_ROWS, not MAX.
    const saved = Array(MAX_OUTPUT_ROWS + 10).fill(null).map((_, i) => ({ score: 0.9 - i * 0.01 }));
    const post  = [];

    applySafetyRails(post, saved);

    expect(post.length).toBe(MIN_OUTPUT_ROWS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Return value
// ─────────────────────────────────────────────────────────────────────────────

describe("applySafetyRails — return value", () => {
  test("returns the same hits array that was passed in", () => {
    const post = hits(0.95);
    const saved = hits(0.95, 0.92, 0.88);
    expect(applySafetyRails(post, saved)).toBe(post);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export conventions
// ─────────────────────────────────────────────────────────────────────────────

describe("applySafetyRails — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof applySafetyRails).toBe("function");
  });

  test("exposes a self-referential .applySafetyRails property", () => {
    expect(applySafetyRails.applySafetyRails).toBe(applySafetyRails);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(applySafetyRails)).toBe(true);
  });
});
