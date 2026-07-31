"use strict";

const unionHits = require("../../../src/actions/query/unionHits");
const { hitKey } = unionHits;

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const hit = (score, documentId, range) => ({ score, documentId, range });

// ─────────────────────────────────────────────────────────────────────────────
// Empty / edge inputs
// ─────────────────────────────────────────────────────────────────────────────

describe("unionHits — empty inputs", () => {
  test("empty array returns empty array", () => {
    expect(unionHits([])).toEqual([]);
  });

  test("array of empty arrays returns empty array", () => {
    expect(unionHits([[], [], []])).toEqual([]);
  });

  test("null/undefined returns empty array (defensive)", () => {
    // The orchestrator should never pass these, but the function
    // shouldn't crash if it does.
    expect(unionHits(null)).toEqual([]);
    expect(unionHits(undefined)).toEqual([]);
  });

  test("non-array inner element is skipped", () => {
    const result = unionHits([
      [hit(0.8, "a|x", [0, 100])],
      null,
      [hit(0.6, "a|y", [0, 100])],
    ]);
    expect(result.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Single-segment behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("unionHits — single segment", () => {
  test("single segment passes through preserving content", () => {
    const input = [
      [
        hit(0.8, "a|x", [0, 100]),
        hit(0.6, "a|y", [200, 300]),
        hit(0.4, "a|z", [400, 500]),
      ],
    ];
    const result = unionHits(input);
    expect(result).toEqual(input[0]);
  });

  test("single segment already sorted by score descending stays sorted", () => {
    const result = unionHits([
      [
        hit(0.9, "a|x", [0, 100]),
        hit(0.5, "a|y", [0, 100]),
        hit(0.1, "a|z", [0, 100]),
      ],
    ]);
    expect(result.map(h => h.score)).toEqual([0.9, 0.5, 0.1]);
  });

  test("single segment with mixed score order gets sorted", () => {
    // The function shouldn't rely on per-segment ordering being
    // descending — VectorStore.search returns them sorted, but the
    // union function's contract is "score-descending output."
    const result = unionHits([
      [
        hit(0.5, "a|y", [0, 100]),
        hit(0.9, "a|x", [0, 100]),
        hit(0.1, "a|z", [0, 100]),
      ],
    ]);
    expect(result.map(h => h.score)).toEqual([0.9, 0.5, 0.1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-segment dedup
// ─────────────────────────────────────────────────────────────────────────────

describe("unionHits — multi-segment dedup", () => {
  test("hits with identical documentId+range are deduplicated", () => {
    const result = unionHits([
      [hit(0.8, "a|x", [0, 100])],
      [hit(0.7, "a|x", [0, 100])],
    ]);
    expect(result.length).toBe(1);
  });

  test("dedup keeps the higher score", () => {
    const result = unionHits([
      [hit(0.7, "a|x", [0, 100])],
      [hit(0.9, "a|x", [0, 100])],
    ]);
    expect(result[0].score).toBe(0.9);
  });

  test("dedup keeps the higher score regardless of segment order", () => {
    // 0.9 first
    let result = unionHits([
      [hit(0.9, "a|x", [0, 100])],
      [hit(0.7, "a|x", [0, 100])],
    ]);
    expect(result[0].score).toBe(0.9);
    // 0.9 second
    result = unionHits([
      [hit(0.7, "a|x", [0, 100])],
      [hit(0.9, "a|x", [0, 100])],
    ]);
    expect(result[0].score).toBe(0.9);
  });

  test("different ranges on same documentId are kept separately", () => {
    // Same doc but different sections — both should survive.
    const result = unionHits([
      [hit(0.8, "a|x", [0, 100])],
      [hit(0.7, "a|x", [200, 300])],
    ]);
    expect(result.length).toBe(2);
  });

  test("different documentIds with same range are kept separately", () => {
    const result = unionHits([
      [hit(0.8, "a|x", [0, 100])],
      [hit(0.7, "a|y", [0, 100])],
    ]);
    expect(result.length).toBe(2);
  });

  test("realistic multi-segment merge produces score-descending unique list", () => {
    // Two segments, each with 3 hits, some overlap. The shared hit
    // ("a|x"/[0,100]) appears in both with different scores: 0.7 in
    // segment[0], 0.85 in segment[1]. Expected: 5 unique hits, the
    // shared one carrying its higher 0.85 score.
    const result = unionHits([
      [
        hit(0.9, "a|w", [0, 100]),
        hit(0.7, "a|x", [0, 100]),
        hit(0.6, "a|y", [0, 100]),
      ],
      [
        hit(0.85, "a|x", [0, 100]),
        hit(0.5,  "a|z", [0, 100]),
        hit(0.4,  "a|v", [0, 100]),
      ],
    ]);
    expect(result.length).toBe(5);
    expect(result.map(h => h.score)).toEqual([0.9, 0.85, 0.6, 0.5, 0.4]);
    const sharedHit = result.find(h => h.documentId === "a|x");
    expect(sharedHit.score).toBe(0.85);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tie-breaking and order
// ─────────────────────────────────────────────────────────────────────────────

describe("unionHits — sort order", () => {
  test("strictly descending by score", () => {
    const result = unionHits([
      [
        hit(0.3, "a|c", [0, 100]),
        hit(0.9, "a|a", [0, 100]),
        hit(0.5, "a|b", [0, 100]),
      ],
    ]);
    const scores = result.map(h => h.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  test("ties preserve insertion order (stable sort)", () => {
    // Three hits at score 0.5, inserted in a specific documentId
    // order. Output should preserve that order at the score-0.5 tier.
    const result = unionHits([
      [
        hit(0.5, "a|first",  [0, 100]),
        hit(0.5, "a|second", [0, 100]),
        hit(0.5, "a|third",  [0, 100]),
      ],
    ]);
    expect(result.map(h => h.documentId)).toEqual(["a|first", "a|second", "a|third"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Malformed-hit handling
// ─────────────────────────────────────────────────────────────────────────────

describe("unionHits — malformed hits", () => {
  test("hits without documentId are dropped", () => {
    const result = unionHits([
      [
        hit(0.8, "a|x", [0, 100]),
        { score: 0.7, range: [0, 100] },  // no documentId
      ],
    ]);
    expect(result.length).toBe(1);
    expect(result[0].documentId).toBe("a|x");
  });

  test("hits without range are dropped", () => {
    const result = unionHits([
      [
        hit(0.8, "a|x", [0, 100]),
        { score: 0.7, documentId: "a|y" },  // no range
      ],
    ]);
    expect(result.length).toBe(1);
    expect(result[0].documentId).toBe("a|x");
  });

  test("null/undefined hits inside an array are dropped", () => {
    const result = unionHits([
      [hit(0.8, "a|x", [0, 100]), null, undefined, hit(0.6, "a|y", [0, 100])],
    ]);
    expect(result.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hitKey helper
// ─────────────────────────────────────────────────────────────────────────────

describe("hitKey", () => {
  test("emits documentId followed by bracketed range", () => {
    expect(hitKey(hit(0.8, "a|x", [10, 20]))).toBe("a|x[10,20]");
  });

  test("handles documentIds containing pipes (the structural delimiter)", () => {
    // The documentId pipe is part of the ID, not a separator in
    // the key. The brackets disambiguate the range boundary.
    expect(hitKey(hit(0.8, "theme|with|pipes", [10, 20]))).toBe("theme|with|pipes[10,20]");
  });

  test("returns null for malformed hit (no documentId)", () => {
    expect(hitKey({ score: 0.8, range: [0, 100] })).toBeNull();
  });

  test("returns null for malformed hit (no range)", () => {
    expect(hitKey({ score: 0.8, documentId: "a|x" })).toBeNull();
  });

  test("returns null for null/undefined", () => {
    expect(hitKey(null)).toBeNull();
    expect(hitKey(undefined)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────────────

describe("unionHits — module export", () => {
  test("module is the function itself", () => {
    expect(typeof unionHits).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(unionHits)).toBe(true);
  });

  test("self-referential .unionHits property", () => {
    expect(unionHits.unionHits).toBe(unionHits);
  });

  test("exposes hitKey helper", () => {
    expect(typeof unionHits.hitKey).toBe("function");
    expect(unionHits.hitKey).toBe(hitKey);
  });
});