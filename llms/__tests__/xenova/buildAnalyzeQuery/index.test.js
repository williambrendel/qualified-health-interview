"use strict";

/**
 * @file index.test.js
 * @brief Unit tests for the buildAnalyzeQuery orchestrator.
 *
 * Mocks all direct dependencies so tests verify dispatch logic
 * without exercising any model. Tests cover the new pipeline:
 *
 *   collapseRepeatedPunctuation → detectFrustration → peelGreeting →
 *   isMultiPart → greedySplit → classify
 *
 * Behavior covered:
 *
 *   - Greeting-only fast path (cleaned query empty, segments: [])
 *   - Single-intent path (cleaned query has content, !isMultiPart)
 *   - Multi-part with successful greedy split
 *   - Multi-part with failed greedy split (needsLLMSplit: true)
 *   - Return shape: query, greeting, frustration top-level fields
 *   - Factory passes options through to buildClassifier
 *   - queryVec reuse only when cleaned === raw
 *   - Module export shape
 */

const DIM = 4;

const mockEmbedQuery = jest.fn(async (text) => {
  const v = new Float32Array(DIM);
  for (let i = 0; i < text.length; i++) v[i % DIM] += text.charCodeAt(i);
  return v;
});

const mockIsMultiPart                 = jest.fn();
const mockGreedySplit                 = jest.fn();
const mockClassifier                  = jest.fn();
const mockBuildClassifier             = jest.fn(async () => mockClassifier);
const mockDetectFrustration           = jest.fn();
const mockPeelGreeting                = jest.fn();
const mockCollapseRepeatedPunctuation = jest.fn();

jest.mock("../../../src/xenova/embedQuery",                                () => mockEmbedQuery);
jest.mock("../../../src/xenova/buildAnalyzeQuery/isMultiPart",             () => mockIsMultiPart);
jest.mock("../../../src/xenova/buildAnalyzeQuery/greedySplit",             () => mockGreedySplit);
jest.mock("../../../src/xenova/buildAnalyzeQuery/buildClassifier",         () => mockBuildClassifier);
jest.mock("../../../src/xenova/buildAnalyzeQuery/detectFrustration",       () => mockDetectFrustration);
jest.mock("../../../src/xenova/buildAnalyzeQuery/peelGreeting",            () => mockPeelGreeting);
jest.mock("../../../src/xenova/buildAnalyzeQuery/collapseRepeatedPunctuation",
  () => mockCollapseRepeatedPunctuation);

const buildAnalyzeQuery = require("../../../src/xenova/buildAnalyzeQuery");

/**
 * Neutral defaults for the three new preprocessing mocks. Each test
 * overrides as needed.
 */
const setNeutralPreprocessing = () => {
  // collapse: identity by default.
  mockCollapseRepeatedPunctuation.mockImplementation((s) => s);
  // frustration: zeros.
  mockDetectFrustration.mockReturnValue({
    score: 0, shouting: false, allCaps: false,
    repeatedPunctCount: 0, urgentKeywords: [], profanity: false,
  });
  // greeting peel: no greeting, query unchanged.
  mockPeelGreeting.mockImplementation((q) => ({ greeting: false, query: q }));
};

beforeEach(() => {
  jest.clearAllMocks();
  setNeutralPreprocessing();
  mockClassifier.mockResolvedValue({
    label: "TECHNICAL",
    confidence: 0.5,
    scores: { TECHNICAL: 0.7, SUPPORT: 0.2, CONVERSATIONAL: 0.1 },
    lowConfidence: false,
    usedNli: false,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Greeting-only fast path
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAnalyzeQuery — greeting-only fast path", () => {
  beforeEach(() => {
    // Peel reports greeting + empty cleaned query.
    mockPeelGreeting.mockReturnValue({ greeting: true, query: "" });
  });

  test("segments is an empty array", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("hello");
    expect(result.segments).toEqual([]);
  });

  test("greeting flag is true", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("hello");
    expect(result.greeting).toBe(true);
  });

  test("query field is empty string", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("hello");
    expect(result.query).toBe("");
  });

  test("multiPart, splitOk, needsLLMSplit are all false", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("hello");
    expect(result.multiPart).toBe(false);
    expect(result.splitOk).toBe(false);
    expect(result.needsLLMSplit).toBe(false);
  });

  test("isMultiPart and greedySplit are NOT called", async () => {
    const analyze = await buildAnalyzeQuery();
    await analyze("hello");
    expect(mockIsMultiPart).not.toHaveBeenCalled();
    expect(mockGreedySplit).not.toHaveBeenCalled();
  });

  test("classifier is NOT called (no content to classify)", async () => {
    const analyze = await buildAnalyzeQuery();
    await analyze("hello");
    expect(mockClassifier).not.toHaveBeenCalled();
  });

  test("embedQuery is NOT called", async () => {
    const analyze = await buildAnalyzeQuery();
    await analyze("hello");
    expect(mockEmbedQuery).not.toHaveBeenCalled();
  });

  test("frustration object is still present", async () => {
    mockDetectFrustration.mockReturnValue({
      score: 0.5, shouting: true, allCaps: true,
      repeatedPunctCount: 1, urgentKeywords: [], profanity: false,
    });
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("HELLO!!!");
    expect(result.frustration.score).toBe(0.5);
    expect(result.frustration.shouting).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Single-intent path (with content)
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAnalyzeQuery — single-intent path", () => {
  beforeEach(() => {
    mockIsMultiPart.mockReturnValue(false);
  });

  test("returns one segment with the cleaned query", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("how do I prevent scale?", new Float32Array(DIM));
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toBe("how do I prevent scale?");
  });

  test("query field reflects cleaned input", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("how do I prevent scale?", new Float32Array(DIM));
    expect(result.query).toBe("how do I prevent scale?");
  });

  test("multiPart, splitOk, needsLLMSplit are false", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("how do I prevent scale?", new Float32Array(DIM));
    expect(result.multiPart).toBe(false);
    expect(result.splitOk).toBe(false);
    expect(result.needsLLMSplit).toBe(false);
  });

  test("reuses caller's queryVec when cleaned === raw", async () => {
    const callerVec = new Float32Array(DIM);
    callerVec.fill(0.5);
    const analyze = await buildAnalyzeQuery();
    // collapse returns identity, peel returns identity → cleaned === raw
    await analyze("query text", callerVec);
    expect(mockEmbedQuery).not.toHaveBeenCalled();
    expect(mockClassifier).toHaveBeenCalledWith(callerVec, "query text");
  });

  test("does NOT reuse caller's queryVec when cleaned differs from raw", async () => {
    // Simulate punctuation collapse changing the string.
    mockCollapseRepeatedPunctuation.mockReturnValue("query text");
    mockPeelGreeting.mockReturnValue({ greeting: false, query: "query text" });
    const callerVec = new Float32Array(DIM);
    callerVec.fill(0.5);
    const analyze = await buildAnalyzeQuery();
    await analyze("query text!!!", callerVec);
    // cleaned ("query text") differs from raw ("query text!!!") →
    // re-embed.
    expect(mockEmbedQuery).toHaveBeenCalledWith("query text");
  });

  test("embeds when caller does not provide queryVec", async () => {
    const analyze = await buildAnalyzeQuery();
    await analyze("query text");
    expect(mockEmbedQuery).toHaveBeenCalledWith("query text");
  });

  test("classification result is attached to the segment", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("query text", new Float32Array(DIM));
    expect(result.segments[0].classification).toEqual({
      label: "TECHNICAL",
      confidence: 0.5,
      scores: { TECHNICAL: 0.7, SUPPORT: 0.2, CONVERSATIONAL: 0.1 },
      lowConfidence: false,
      usedNli: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-part path — successful split
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAnalyzeQuery — multi-part with successful split", () => {
  beforeEach(() => {
    mockIsMultiPart.mockReturnValue(true);
    mockGreedySplit.mockReturnValue(["piece one", "piece two"]);
  });

  test("returns N segments matching the greedy split", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("piece one. piece two.", new Float32Array(DIM));
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].text).toBe("piece one");
    expect(result.segments[1].text).toBe("piece two");
  });

  test("multiPart:true, splitOk:true, needsLLMSplit:false", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("piece one. piece two.", new Float32Array(DIM));
    expect(result.multiPart).toBe(true);
    expect(result.splitOk).toBe(true);
    expect(result.needsLLMSplit).toBe(false);
  });

  test("each piece is embedded fresh", async () => {
    const callerVec = new Float32Array(DIM);
    callerVec.fill(0.5);
    const analyze = await buildAnalyzeQuery();
    await analyze("piece one. piece two.", callerVec);
    expect(mockEmbedQuery).toHaveBeenCalledWith("piece one");
    expect(mockEmbedQuery).toHaveBeenCalledWith("piece two");
  });

  test("classifier called once per piece", async () => {
    const analyze = await buildAnalyzeQuery();
    await analyze("piece one. piece two.", new Float32Array(DIM));
    expect(mockClassifier).toHaveBeenCalledTimes(2);
  });

  test("each segment gets its own classification", async () => {
    mockClassifier
      .mockResolvedValueOnce({
        label: "CONVERSATIONAL", confidence: 0.6,
        scores: { TECHNICAL: 0.1, SUPPORT: 0.1, CONVERSATIONAL: 0.7 },
        lowConfidence: false, usedNli: false,
      })
      .mockResolvedValueOnce({
        label: "TECHNICAL", confidence: 0.5,
        scores: { TECHNICAL: 0.8, SUPPORT: 0.1, CONVERSATIONAL: 0.1 },
        lowConfidence: false, usedNli: false,
      });
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("piece one. piece two.", new Float32Array(DIM));
    expect(result.segments[0].classification.label).toBe("CONVERSATIONAL");
    expect(result.segments[1].classification.label).toBe("TECHNICAL");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-part path — failed split
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAnalyzeQuery — multi-part with failed greedy split", () => {
  beforeEach(() => {
    mockIsMultiPart.mockReturnValue(true);
    mockGreedySplit.mockReturnValue(["whole query"]);
  });

  test("returns one segment with the whole cleaned query", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("whole query", new Float32Array(DIM));
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toBe("whole query");
  });

  test("multiPart:true, splitOk:false, needsLLMSplit:TRUE", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("whole query", new Float32Array(DIM));
    expect(result.multiPart).toBe(true);
    expect(result.splitOk).toBe(false);
    expect(result.needsLLMSplit).toBe(true);
  });

  test("classifier called on the whole cleaned query", async () => {
    const analyze = await buildAnalyzeQuery();
    await analyze("whole query", new Float32Array(DIM));
    expect(mockClassifier).toHaveBeenCalledTimes(1);
    expect(mockClassifier).toHaveBeenCalledWith(expect.any(Float32Array), "whole query");
  });

  test("reuses caller's queryVec when cleaned === raw", async () => {
    const callerVec = new Float32Array(DIM);
    callerVec.fill(0.5);
    const analyze = await buildAnalyzeQuery();
    await analyze("whole query", callerVec);
    expect(mockEmbedQuery).not.toHaveBeenCalled();
    expect(mockClassifier).toHaveBeenCalledWith(callerVec, "whole query");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Greeting + content (greeting flag true, segments populated)
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAnalyzeQuery — greeting plus content", () => {
  beforeEach(() => {
    // Peel reports greeting AND cleaned content.
    mockPeelGreeting.mockImplementation((q) => ({
      greeting: true,
      query:    "what is pH?",
    }));
    mockIsMultiPart.mockReturnValue(false);
  });

  test("greeting flag is true", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("hello, what is pH?");
    expect(result.greeting).toBe(true);
  });

  test("query field reflects the post-strip content", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("hello, what is pH?");
    expect(result.query).toBe("what is pH?");
  });

  test("segments contain only the cleaned content (no greeting segment)", async () => {
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("hello, what is pH?");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].text).toBe("what is pH?");
  });

  test("classifier called on cleaned content, not raw", async () => {
    const analyze = await buildAnalyzeQuery();
    await analyze("hello, what is pH?");
    expect(mockClassifier).toHaveBeenCalledWith(expect.any(Float32Array), "what is pH?");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frustration plumbing
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAnalyzeQuery — frustration plumbing", () => {
  test("frustration object is attached to the result", async () => {
    mockIsMultiPart.mockReturnValue(false);
    const frustration = {
      score: 0.7, shouting: true, allCaps: true,
      repeatedPunctCount: 2, urgentKeywords: ["broken"], profanity: false,
    };
    mockDetectFrustration.mockReturnValue(frustration);
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("THIS IS BROKEN!!!");
    expect(result.frustration).toEqual(frustration);
  });

  test("detectFrustration called on the trimmed RAW input (not collapsed)", async () => {
    mockIsMultiPart.mockReturnValue(false);
    // Setup: collapse changes "!!!" → "!", peel removes greeting.
    mockCollapseRepeatedPunctuation.mockReturnValue("query text!");
    mockPeelGreeting.mockReturnValue({ greeting: false, query: "query text!" });
    const analyze = await buildAnalyzeQuery();
    await analyze("query text!!!");
    // The raw, trimmed input (with !!!) — not the collapsed form.
    expect(mockDetectFrustration).toHaveBeenCalledWith("query text!!!");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline order verification
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAnalyzeQuery — pipeline order", () => {
  test("preprocessing runs in order: frustration → collapse → peel", async () => {
    mockIsMultiPart.mockReturnValue(false);
    const callOrder = [];
    mockDetectFrustration.mockImplementation((s) => {
      callOrder.push(["frustration", s]);
      return { score: 0, shouting: false, allCaps: false,
               repeatedPunctCount: 0, urgentKeywords: [], profanity: false };
    });
    mockCollapseRepeatedPunctuation.mockImplementation((s) => {
      callOrder.push(["collapse", s]);
      return s;
    });
    mockPeelGreeting.mockImplementation((s) => {
      callOrder.push(["peel", s]);
      return { greeting: false, query: s };
    });

    const analyze = await buildAnalyzeQuery();
    await analyze("hello world");

    expect(callOrder[0][0]).toBe("frustration");
    expect(callOrder[1][0]).toBe("collapse");
    expect(callOrder[2][0]).toBe("peel");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Factory passthrough
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAnalyzeQuery — factory passthrough", () => {
  test("passes options to buildClassifier", async () => {
    const options = {
      classes: { TECHNICAL: { anchors: ["abc"], description: "tech" } },
      thresholds: { technical: 0.6 },
    };
    await buildAnalyzeQuery(options);
    // After spell-engine destructure, buildClassifier sees the same options
    // minus the spellEngine field. With no spellEngine in input, shape is
    // preserved by value (Jest uses deep equality on toHaveBeenCalledWith).
    expect(mockBuildClassifier).toHaveBeenCalledWith(options);
  });

  test("works with no options (passes empty options through)", async () => {
    await buildAnalyzeQuery();
    // The factory destructures from `{} ` when called with no args, so
    // buildClassifier receives an empty object — NOT undefined. The
    // classifier accepts {} the same way it accepts no args; both produce
    // a Mode 2 classifier with no TECHNICAL anchors.
    expect(mockBuildClassifier).toHaveBeenCalledWith({});
  });

  test("spellEngine is stripped from options passed to buildClassifier", async () => {
    // The analyzer destructures spellEngine out of options before
    // delegating to buildClassifier. The classifier shouldn't see
    // (or care about) the spell engine.
    const spellEngine = { correct: jest.fn((s) => s) };
    const options = {
      spellEngine,
      classes: { TECHNICAL: { anchors: ["abc"], description: "tech" } },
    };
    await buildAnalyzeQuery(options);
    expect(mockBuildClassifier).toHaveBeenCalledWith({
      classes: { TECHNICAL: { anchors: ["abc"], description: "tech" } },
    });
    expect(mockBuildClassifier).not.toHaveBeenCalledWith(
      expect.objectContaining({ spellEngine: expect.anything() })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spell engine wiring
// ─────────────────────────────────────────────────────────────────────────────
//
// The analyzer accepts an optional `spellEngine` with a `correct(text) →
// text` method. When provided, the engine runs on the raw input AFTER
// frustration detection and BEFORE greeting peel. The corrected form is
// what gets embedded, classified, and surfaced as the `corrected` output
// field. When no engine is provided, the analyzer passes the raw input
// through untouched and `corrected === raw`.

describe("buildAnalyzeQuery — spell engine wiring", () => {
  test("when no spellEngine is provided, corrected equals raw input (trimmed)", async () => {
    mockIsMultiPart.mockReturnValue(false);
    const analyze = await buildAnalyzeQuery();
    const result = await analyze("  what is pH  ");
    expect(result.corrected).toBe("what is pH");
  });

  test("when spellEngine is provided, corrected reflects engine output", async () => {
    const spellEngine = {
      correct: jest.fn((s) => s.replace(/wont/gi, "won't")),
    };
    mockIsMultiPart.mockReturnValue(false);
    const analyze = await buildAnalyzeQuery({ spellEngine });
    const result = await analyze("biofilm WONT go away");
    expect(spellEngine.correct).toHaveBeenCalledWith("biofilm WONT go away");
    expect(result.corrected).toBe("biofilm won't go away");
  });

  test("spellEngine runs AFTER trim", async () => {
    // Caller may submit raw input with stray whitespace. The analyzer
    // trims first, then hands a clean trimmed string to the engine.
    // Verifies that the engine doesn't see leading/trailing whitespace.
    const spellEngine = { correct: jest.fn((s) => s) };
    mockIsMultiPart.mockReturnValue(false);
    const analyze = await buildAnalyzeQuery({ spellEngine });
    await analyze("   biofilm question   ");
    expect(spellEngine.correct).toHaveBeenCalledWith("biofilm question");
  });

  test("spellEngine runs BEFORE peelGreeting", async () => {
    // A typo'd greeting like 'helo' should be correctable to 'hello'
    // first, then peelGreeting sees the corrected form. We verify the
    // call order by checking what input peelGreeting receives.
    const spellEngine = {
      correct: jest.fn((s) => s.replace(/^helo\b/, "hello")),
    };
    mockIsMultiPart.mockReturnValue(false);
    mockPeelGreeting.mockReturnValue({ greeting: true, query: "test query" });
    const analyze = await buildAnalyzeQuery({ spellEngine });
    await analyze("helo, test query");
    // peelGreeting should have seen the spell-corrected form, NOT the raw.
    expect(mockPeelGreeting).toHaveBeenCalledWith(
      expect.stringContaining("hello"),
    );
  });

  test("frustration detection runs on raw input, NOT on corrected", async () => {
    // The whole point of detecting frustration BEFORE correction is to
    // capture signals (ALL CAPS, !!!, "wont") that correction would
    // erase. We verify detectFrustration receives the original.
    const spellEngine = {
      correct: jest.fn((s) =>
        s.toLowerCase().replace(/!+/g, "!").replace(/wont/g, "won't"),
      ),
    };
    mockIsMultiPart.mockReturnValue(false);
    const analyze = await buildAnalyzeQuery({ spellEngine });
    await analyze("THIS WONT WORK!!!");
    expect(mockDetectFrustration).toHaveBeenCalledWith("THIS WONT WORK!!!");
  });

  test("corrected is what gets embedded and classified (not raw)", async () => {
    // Downstream embedding and classification should see the spell-
    // corrected text. The user's typos shouldn't propagate to retrieval.
    const spellEngine = {
      correct: jest.fn(() => "the cleaned text"),
    };
    mockIsMultiPart.mockReturnValue(false);
    mockPeelGreeting.mockImplementation((q) => ({ greeting: false, query: q }));
    const analyze = await buildAnalyzeQuery({ spellEngine });
    await analyze("teh cleened txt");
    expect(mockEmbedQuery).toHaveBeenCalledWith("the cleaned text");
    expect(mockClassifier).toHaveBeenCalledWith(
      expect.any(Float32Array),
      "the cleaned text",
    );
  });

  test("queryVec reuse considers spell correction", async () => {
    // canReuse requires cleaned === raw. With spell correction that
    // changes the string, cleaned no longer equals raw, so the analyzer
    // must re-embed the corrected form rather than reusing the caller's
    // pre-computed vector (which was for the raw form).
    const spellEngine = {
      correct: jest.fn((s) => s.replace(/teh/g, "the")),
    };
    mockIsMultiPart.mockReturnValue(false);
    const analyze = await buildAnalyzeQuery({ spellEngine });
    const callersPrecomputedVec = new Float32Array(DIM);
    await analyze("teh biofilm", callersPrecomputedVec);
    // Should NOT reuse the caller's vec because correction changed the text.
    expect(mockEmbedQuery).toHaveBeenCalledWith("the biofilm");
  });

  test("queryVec reuse still works when spellEngine is a no-op", async () => {
    // If the spell engine returns its input unchanged AND no other
    // transforms fired (no peel, no collapse-effective change), cleaned
    // === raw and the caller's vec is reusable.
    const spellEngine = { correct: jest.fn((s) => s) };
    mockIsMultiPart.mockReturnValue(false);
    mockCollapseRepeatedPunctuation.mockImplementation((s) => s);
    mockPeelGreeting.mockImplementation((q) => ({ greeting: false, query: q }));
    const analyze = await buildAnalyzeQuery({ spellEngine });
    const callersPrecomputedVec = new Float32Array(DIM);
    callersPrecomputedVec[0] = 42;
    const result = await analyze("biofilm question", callersPrecomputedVec);
    expect(mockEmbedQuery).not.toHaveBeenCalled();
    expect(result.segments[0].vec).toBe(callersPrecomputedVec);
  });

  test("corrected is present even on greeting-only fast path", async () => {
    // The greeting-only fast path returns early with empty segments,
    // but `corrected` is still surfaced — the dispatcher may want to
    // echo "you said: <corrected>" even when the response is a
    // pure greeting reply.
    const spellEngine = {
      correct: jest.fn(() => "hello"),
    };
    mockPeelGreeting.mockReturnValue({ greeting: true, query: "" });
    const analyze = await buildAnalyzeQuery({ spellEngine });
    const result = await analyze("hellp");
    expect(result.segments).toEqual([]);
    expect(result.query).toBe("");
    expect(result.corrected).toBe("hello");
    expect(result.greeting).toBe(true);
  });

  test("corrected is present on multi-segment results", async () => {
    // When the query splits into multiple segments, `corrected` is
    // still a single whole-query field on the top-level result —
    // not per-segment. Verifies the property exists and matches the
    // engine's output for the whole input.
    const spellEngine = {
      correct: jest.fn((s) => s.replace(/wnat/g, "want")),
    };
    mockIsMultiPart.mockReturnValue(true);
    mockGreedySplit.mockReturnValue(["what is pH", "i wnat to know more"]);
    const analyze = await buildAnalyzeQuery({ spellEngine });
    const result = await analyze("what is pH and i wnat to know more");
    expect(result.corrected).toBe("what is pH and i want to know more");
    expect(result.segments).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAnalyzeQuery — module export", () => {
  test("module is the factory function itself", () => {
    expect(typeof buildAnalyzeQuery).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(buildAnalyzeQuery)).toBe(true);
  });

  test("self-referential buildAnalyzeQuery.buildAnalyzeQuery property", () => {
    expect(buildAnalyzeQuery.buildAnalyzeQuery).toBe(buildAnalyzeQuery);
  });
});