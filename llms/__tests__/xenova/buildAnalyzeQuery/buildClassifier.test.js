"use strict";

/**
 * @file buildClassifier.test.js
 * @brief Unit tests for the BGE + NLI two-tier classifier factory.
 *
 * Mocks `embedQuery` and `classify` so tests run without loading any
 * model. Behavior covered:
 *
 * - Mode 1 (TECHNICAL anchors provided): 3-class max-cosine routing.
 * - Mode 2 (no TECHNICAL anchors): TECHNICAL by absence.
 * - NLI fallback triggers on low margin OR low absolute score.
 * - NLI fallback only fires when the classifier has access to the
 *   original text (vector-only input bypasses NLI).
 * - Custom thresholds.
 * - Defaults applied when class config is omitted.
 * - Dim mismatch throws at classify time.
 * - Module export shape.
 *
 * Integration tests against the real models live in
 * `buildClassifier.integration.test.js`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic embedding mock
// ─────────────────────────────────────────────────────────────────────────────
//
// Returns a stable, L2-normalized Float32Array per input text. Tests that
// need to force a specific vector for a specific text can call
// `mockForced.set(text, vec)` in their setup.

const DIM = 4;

/** Force-override map. Cleared between tests. */
const mockForced = new Map();

/** Build an L2-normalized vector deterministically from text. */
const hashEmbed = (text, dim = DIM) => {
  const v = new Float32Array(dim);
  for (let i = 0; i < text.length; i++) v[i % dim] += text.charCodeAt(i);
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
};

// Mock the embedQuery module that buildClassifier imports.
jest.mock("../../../src/xenova/embedQuery", () => {
  return jest.fn(async (text) => {
    if (mockForced.has(text)) return mockForced.get(text);
    // Lazy-call hashEmbed because top-level access fires before the
    // const is defined; safe inside the function body.
    const dim = 4;
    const v = new Float32Array(dim);
    for (let i = 0; i < text.length; i++) v[i % dim] += text.charCodeAt(i);
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) v[i] /= norm;
    return v;
  });
});

// Mock the classify (NLI) module.
const mockClassify = jest.fn();
jest.mock("../../../src/xenova/classify", () => mockClassify);

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

const buildClassifier = require("../../../src/xenova/buildAnalyzeQuery/buildClassifier");
const embedQuery      = require("../../../src/xenova/embedQuery");

beforeEach(() => {
  jest.clearAllMocks();
  mockForced.clear();
  // Default NLI response — first label wins by a comfortable margin.
  mockClassify.mockResolvedValue({
    labels: ["a technical or factual question", "a greeting, thank you, or off-topic message", "a request for human help or contact information"],
    scores: [0.85, 0.10, 0.05],
  });
});

// Helper: a vector that points exactly at the embedding of a given text.
// Lets tests align a query with a specific anchor's vector for a near-1
// cosine.
const sameAs = (text) => hashEmbed(text);

// Helper: a vector orthogonal-ish to everything (uniform).
const uniform = () => {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = 1 / Math.sqrt(DIM);
  return v;
};

// ─────────────────────────────────────────────────────────────────────────────
// Mode 1: TECHNICAL anchors provided
// ─────────────────────────────────────────────────────────────────────────────

describe("buildClassifier — Mode 1 (TECHNICAL anchors provided)", () => {
  let classify;
  const TECH_ANCHOR = "tech-anchor-A";
  const SUP_ANCHOR  = "sup-anchor-A";
  const CONV_ANCHOR = "conv-anchor-A";

  beforeEach(async () => {
    classify = await buildClassifier({
      classes: {
        TECHNICAL:      { anchors: [TECH_ANCHOR], description: "a tech Q" },
        SUPPORT:        { anchors: [SUP_ANCHOR],  description: "a help req" },
        CONVERSATIONAL: { anchors: [CONV_ANCHOR], description: "small talk" },
      },
      // Disable NLI fallback for these tests by setting impossibly low
      // thresholds so the BGE path always reports its result.
      thresholds: { technical: 0.5, lowConfidence: -1, absoluteLow: -1 },
    });
  });

  test("query identical to TECHNICAL anchor → label is TECHNICAL", async () => {
    const result = await classify(sameAs(TECH_ANCHOR), TECH_ANCHOR);
    expect(result.label).toBe("TECHNICAL");
  });

  test("query identical to SUPPORT anchor → label is TECHNICAL", async () => {
    const result = await classify(sameAs(SUP_ANCHOR), SUP_ANCHOR);
    expect(result.label).toBe("TECHNICAL");
  });

  test("query identical to CONVERSATIONAL anchor → label is TECHNICAL", async () => {
    const result = await classify(sameAs(CONV_ANCHOR), CONV_ANCHOR);
    expect(result.label).toBe("TECHNICAL");
  });

  test("returns the full result shape", async () => {
    const result = await classify(sameAs(TECH_ANCHOR), TECH_ANCHOR);
    expect(result).toHaveProperty("label");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("scores");
    expect(result).toHaveProperty("lowConfidence");
    expect(result).toHaveProperty("usedNli");
    expect(result.scores).toHaveProperty("TECHNICAL");
    expect(result.scores).toHaveProperty("SUPPORT");
    expect(result.scores).toHaveProperty("CONVERSATIONAL");
  });

  test("confidence is the margin between winner and runner-up", async () => {
    const result = await classify(sameAs(TECH_ANCHOR), TECH_ANCHOR);
    const sorted = Object.values(result.scores).sort((a, b) => b - a);
    expect(result.confidence).toBeCloseTo(sorted[0] - sorted[1], 5);
  });

  test("accepts string input (embeds internally)", async () => {
    mockForced.set(TECH_ANCHOR, sameAs(TECH_ANCHOR));
    const result = await classify(TECH_ANCHOR);
    expect(result.label).toBe("TECHNICAL");
  });

  test("throws on unsupported input type", async () => {
    await expect(classify(42, "text")).rejects.toThrow(/must be Float32Array or string/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mode 2: no TECHNICAL anchors
// ─────────────────────────────────────────────────────────────────────────────

describe("buildClassifier — Mode 2 (no TECHNICAL anchors)", () => {
  let classify;
  const SUP_ANCHOR  = "sup-anchor-A";
  const CONV_ANCHOR = "conv-anchor-A";

  beforeEach(async () => {
    classify = await buildClassifier({
      classes: {
        SUPPORT:        { anchors: [SUP_ANCHOR],  description: "a help req" },
        CONVERSATIONAL: { anchors: [CONV_ANCHOR], description: "small talk" },
      },
      thresholds: { technical: 0.5, lowConfidence: -1, absoluteLow: -1 },
    });
  });

  test("query identical to SUPPORT → SUPPORT wins", async () => {
    const result = await classify(sameAs(SUP_ANCHOR), SUP_ANCHOR);
    expect(result.label).toBe("SUPPORT");
  });

  test("query identical to CONVERSATIONAL → CONVERSATIONAL wins", async () => {
    const result = await classify(sameAs(CONV_ANCHOR), CONV_ANCHOR);
    expect(result.label).toBe("CONVERSATIONAL");
  });

  test("query orthogonal to all anchors → TECHNICAL wins (Mode 2 absence)", async () => {
    // To make this assertion mechanical (not semantic), force ALL anchor
    // vectors and the query to be controlled values. We use a fresh
    // classifier built with single-anchor classes, then force each
    // anchor's vector to one basis direction and the query to another,
    // guaranteeing zero cosine between the query and both anchors.
    mockForced.set(SUP_ANCHOR,  new Float32Array([1, 0, 0, 0]));
    mockForced.set(CONV_ANCHOR, new Float32Array([0, 1, 0, 0]));

    const localClassify = await buildClassifier({
      classes: {
        SUPPORT:        { anchors: [SUP_ANCHOR],  description: "sup" },
        CONVERSATIONAL: { anchors: [CONV_ANCHOR], description: "conv" },
      },
      thresholds: { technical: 0.5, lowConfidence: -1, absoluteLow: -1 },
    });

    const queryVec = new Float32Array([0, 0, 1, 0]); // orthogonal to both
    const result = await localClassify(queryVec, "novel-query-text");
    expect(result.label).toBe("TECHNICAL");
    expect(result.scores.SUPPORT).toBeCloseTo(0, 5);
    expect(result.scores.CONVERSATIONAL).toBeCloseTo(0, 5);
  });

  test("TECHNICAL score in Mode 2 is threshold - max(others)", async () => {
    // Force vectors so the cosines are known exactly. SUPPORT anchor =
    // basis[0], CONVERSATIONAL anchor = basis[1]. Query = 0.6*basis[0] +
    // 0.8*basis[1] (L2-normalized, 0.6²+0.8² = 1). Then:
    //   cos(query, SUPPORT)        = 0.6
    //   cos(query, CONVERSATIONAL) = 0.8
    //   TECHNICAL = threshold(0.5) - max(0.6, 0.8) = -0.3
    mockForced.set(SUP_ANCHOR,  new Float32Array([1, 0, 0, 0]));
    mockForced.set(CONV_ANCHOR, new Float32Array([0, 1, 0, 0]));

    const localClassify = await buildClassifier({
      classes: {
        SUPPORT:        { anchors: [SUP_ANCHOR],  description: "sup" },
        CONVERSATIONAL: { anchors: [CONV_ANCHOR], description: "conv" },
      },
      thresholds: { technical: 0.5, lowConfidence: -1, absoluteLow: -1 },
    });

    const queryVec = new Float32Array([0.6, 0.8, 0, 0]);
    const result = await localClassify(queryVec, "x");
    const otherMax = Math.max(result.scores.SUPPORT, result.scores.CONVERSATIONAL);
    expect(result.scores.TECHNICAL).toBeCloseTo(0.5 - otherMax, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NLI fallback
// ─────────────────────────────────────────────────────────────────────────────

describe("buildClassifier — NLI fallback", () => {
  test("fires on thin margin (below lowConfidence)", async () => {
    // Set up anchors that all roughly equal — query is uniform, anchors
    // are uniform; max cosines will be near each other → thin margin.
    const classify = await buildClassifier({
      classes: {
        TECHNICAL:      { anchors: ["t"], description: "tech" },
        SUPPORT:        { anchors: ["s"], description: "sup" },
        CONVERSATIONAL: { anchors: ["c"], description: "conv" },
      },
      thresholds: { lowConfidence: 1.0, absoluteLow: -Infinity }, // force trigger via margin
    });

    mockClassify.mockResolvedValueOnce({
      labels: ["sup", "tech", "conv"],
      scores: [0.9, 0.05, 0.05],
    });

    const result = await classify(uniform(), "ambiguous query");
    expect(result.usedNli).toBe(true);
    expect(result.label).toBe("SUPPORT"); // NLI's "sup" → SUPPORT
    expect(mockClassify).toHaveBeenCalled();
  });

  test("fires on low absolute score (below absoluteLow)", async () => {
    const classify = await buildClassifier({
      classes: {
        TECHNICAL:      { anchors: ["t"], description: "tech" },
        SUPPORT:        { anchors: ["s"], description: "sup" },
        CONVERSATIONAL: { anchors: ["c"], description: "conv" },
      },
      thresholds: { lowConfidence: -Infinity, absoluteLow: 1.0 }, // force trigger via abs
    });

    mockClassify.mockResolvedValueOnce({
      labels: ["conv", "tech", "sup"],
      scores: [0.8, 0.15, 0.05],
    });

    const result = await classify(uniform(), "weak query");
    expect(result.usedNli).toBe(true);
    expect(result.label).toBe("CONVERSATIONAL");
  });

  test("does NOT fire when BGE is confident", async () => {
    const TECH = "tech-anchor";
    const classify = await buildClassifier({
      classes: {
        TECHNICAL:      { anchors: [TECH], description: "tech" },
        SUPPORT:        { anchors: ["s"], description: "sup" },
        CONVERSATIONAL: { anchors: ["c"], description: "conv" },
      },
      thresholds: { lowConfidence: 0.05, absoluteLow: 0.4 },
    });

    const result = await classify(sameAs(TECH), TECH);
    expect(result.usedNli).toBe(false);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  test("cannot run NLI without originalText (vector-only input)", async () => {
    const classify = await buildClassifier({
      classes: {
        TECHNICAL:      { anchors: ["t"], description: "tech" },
        SUPPORT:        { anchors: ["s"], description: "sup" },
        CONVERSATIONAL: { anchors: ["c"], description: "conv" },
      },
      thresholds: { lowConfidence: 1.0, absoluteLow: -Infinity }, // would normally trigger
    });

    // Pass only the vector, omit originalText.
    const result = await classify(uniform());
    expect(result.usedNli).toBe(false);
    expect(mockClassify).not.toHaveBeenCalled();
    // The BGE-derived lowConfidence flag stays true since NLI couldn't override.
    expect(result.lowConfidence).toBe(true);
  });

  test("NLI fallback maps description back to class label", async () => {
    const classify = await buildClassifier({
      classes: {
        TECHNICAL:      { anchors: ["t"], description: "tech-desc" },
        SUPPORT:        { anchors: ["s"], description: "sup-desc" },
        CONVERSATIONAL: { anchors: ["c"], description: "conv-desc" },
      },
      thresholds: { lowConfidence: 1.0, absoluteLow: -Infinity },
    });

    mockClassify.mockResolvedValueOnce({
      labels: ["sup-desc", "conv-desc", "tech-desc"],
      scores: [0.7, 0.2, 0.1],
    });

    const result = await classify(uniform(), "anything");
    expect(result.label).toBe("SUPPORT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

describe("buildClassifier — defaults", () => {
  // Semantic correctness of the default anchor sets ("hello" → CONVERSATIONAL,
  // "I need to talk to a person" → SUPPORT) is tested in the integration
  // file where real BGE/NLI models run. Unit tests here verify only that
  // the defaults are correctly wired into the classifier — they exist,
  // they're exposed, and they're used when the caller omits a class config.

  test("builds successfully when called with no arguments (Mode 2 + defaults)", async () => {
    // If defaults are missing or malformed, the build itself would throw.
    // A successful build proves the defaults are present and well-formed.
    const classify = await buildClassifier();
    expect(typeof classify).toBe("function");
  });

  test("DEFAULT constants exposed on the factory", () => {
    expect(buildClassifier.DEFAULT_SUPPORT).toBeDefined();
    expect(buildClassifier.DEFAULT_SUPPORT.anchors).toBeInstanceOf(Array);
    expect(buildClassifier.DEFAULT_SUPPORT.anchors.length).toBeGreaterThan(0);
    expect(buildClassifier.DEFAULT_SUPPORT.description).toEqual(expect.any(String));

    expect(buildClassifier.DEFAULT_CONVERSATIONAL).toBeDefined();
    expect(buildClassifier.DEFAULT_CONVERSATIONAL.anchors).toBeInstanceOf(Array);
    expect(buildClassifier.DEFAULT_CONVERSATIONAL.anchors.length).toBeGreaterThan(0);
    expect(buildClassifier.DEFAULT_CONVERSATIONAL.description).toEqual(expect.any(String));

    expect(buildClassifier.DEFAULT_TECHNICAL_DESCRIPTION).toEqual(expect.any(String));

    expect(buildClassifier.DEFAULT_THRESHOLDS).toBeDefined();
    expect(buildClassifier.DEFAULT_THRESHOLDS).toHaveProperty("technical");
    expect(buildClassifier.DEFAULT_THRESHOLDS).toHaveProperty("lowConfidence");
    expect(buildClassifier.DEFAULT_THRESHOLDS).toHaveProperty("absoluteLow");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dim mismatch
// ─────────────────────────────────────────────────────────────────────────────

describe("buildClassifier — dim mismatch", () => {
  test("throws when input vector dim != anchor dim", async () => {
    const classify = await buildClassifier({
      classes: {
        TECHNICAL:      { anchors: ["t"], description: "tech" },
        SUPPORT:        { anchors: ["s"], description: "sup" },
        CONVERSATIONAL: { anchors: ["c"], description: "conv" },
      },
    });

    const badVec = new Float32Array(8); // anchors are dim 4 from hashEmbed
    badVec.fill(0.35);
    await expect(classify(badVec, "anything")).rejects.toThrow(/encoder mismatch/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("buildClassifier — module export", () => {
  test("module is the factory function itself", () => {
    expect(typeof buildClassifier).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(buildClassifier)).toBe(true);
  });

  test("self-referential buildClassifier.buildClassifier property", () => {
    expect(buildClassifier.buildClassifier).toBe(buildClassifier);
  });
});