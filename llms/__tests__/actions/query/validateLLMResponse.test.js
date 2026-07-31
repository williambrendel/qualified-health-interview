"use strict";

const validateLLMResponse = require("../../../src/actions/query/validateLLMResponse");
const { validateChunk, validateSource } = validateLLMResponse;

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A minimal valid response. Used as a base; merge with overrides to
 * test specific scenarios.
 */
const validResponse = () => ({
  answer: [
    {
      text: "Biofilm forms when microbes attach to surfaces.",
      source: { documentId: "biocides|water_chemistry", range: [3331, 3631] },
    },
    { text: " The matrix protects against disinfectants." },
  ],
  followUpQuestions: [
    "What temperature favors biofilm growth?",
    "How does biocide rotation help?",
  ],
});

const validChunk = (overrides = {}) => ({
  text: "default chunk text",
  source: { documentId: "doc|section", range: [100, 200] },
  ...overrides,
});

const validSource = (overrides = {}) => ({
  documentId: "doc|section",
  range: [100, 200],
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Top-level shape — valid cases
// ─────────────────────────────────────────────────────────────────────────────

describe("validateLLMResponse — valid responses", () => {
  test("minimal valid response passes", () => {
    const result = validateLLMResponse(validResponse());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("valid with one chunk, sourced", () => {
    const result = validateLLMResponse({
      answer: [{ text: "An answer.", source: validSource() }],
      followUpQuestions: ["A follow-up?"],
    });
    expect(result.valid).toBe(true);
  });

  test("valid with one chunk, unsourced (no source field)", () => {
    // Unsourced chunks are valid for connective text or framing.
    const result = validateLLMResponse({
      answer: [{ text: "Hello there!" }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(true);
  });

  test("valid with empty followUpQuestions array", () => {
    // Conversational replies and low-coverage answers may have no
    // follow-ups; this is acceptable.
    const result = validateLLMResponse({
      answer: [{ text: "Hello." }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(true);
  });

  test("valid with mix of sourced and unsourced chunks", () => {
    const result = validateLLMResponse({
      answer: [
        { text: "Biofilm forms when...", source: validSource() },
        { text: " Note: this also applies to..." },
        { text: " Efflux pumps work by...", source: validSource({ range: [400, 500] }) },
      ],
      followUpQuestions: ["?"],
    });
    expect(result.valid).toBe(true);
  });

  test("valid with extra unknown fields tolerated", () => {
    // The validator MUST NOT reject responses that contain fields
    // beyond what we asked for. The LLM may add diagnostic info,
    // reasoning, or new fields in future prompt revisions.
    const result = validateLLMResponse({
      answer: [{ text: "An answer." }],
      followUpQuestions: [],
      reasoning: "I picked this because...",
      confidence: 0.85,
    });
    expect(result.valid).toBe(true);
  });

  test("valid with range [0, 0] (zero-length section at start)", () => {
    // Edge case: a zero-length range starting at offset 0 is
    // technically valid for the type system. Documents might have
    // empty sections we still want to cite.
    const result = validateLLMResponse({
      answer: [{ text: "...", source: validSource({ range: [0, 0] }) }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(true);
  });

  test("explicit undefined source treated as no source (valid)", () => {
    // hasOwnProperty quirk: `{ text: '...', source: undefined }` —
    // the validator should treat this the same as omitting source.
    const result = validateLLMResponse({
      answer: [{ text: "An answer.", source: undefined }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Top-level shape — invalid cases
// ─────────────────────────────────────────────────────────────────────────────

describe("validateLLMResponse — top-level invalid", () => {
  test("null is rejected with single error", () => {
    const result = validateLLMResponse(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["response must be an object"]);
  });

  test("undefined is rejected", () => {
    const result = validateLLMResponse(undefined);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("response must be an object");
  });

  test("primitive (string) is rejected", () => {
    const result = validateLLMResponse("not an object");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("response must be an object");
  });

  test("primitive (number) is rejected", () => {
    const result = validateLLMResponse(42);
    expect(result.valid).toBe(false);
  });

  test("array at the top level is rejected (must be plain object)", () => {
    // An array `[{ text: '...' }]` is NOT a valid response. The
    // top-level must have both `answer` and `followUpQuestions` keys.
    const result = validateLLMResponse([{ text: "..." }]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("response must be an object");
  });

  test("empty object is rejected — answer and followUpQuestions both missing", () => {
    const result = validateLLMResponse({});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer must be an array");
    expect(result.errors).toContain("followUpQuestions must be an array");
    // Both errors should be reported, not short-circuited.
    expect(result.errors.length).toBe(2);
  });

  test("missing followUpQuestions is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("followUpQuestions must be an array");
  });

  test("missing answer is rejected", () => {
    const result = validateLLMResponse({
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer must be an array");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// answer field
// ─────────────────────────────────────────────────────────────────────────────

describe("validateLLMResponse — answer array", () => {
  /**
   * answer must be a non-empty array of chunks. Each chunk has
   * its own validation; this section covers the array-level
   * checks.
   */

  test("answer as a string is rejected", () => {
    // Old shape: answer was a string. New shape: array. If the LLM
    // produces the old shape, we want a clear error.
    const result = validateLLMResponse({
      answer: "A flat string answer.",
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer must be an array");
  });

  test("answer as an object is rejected", () => {
    const result = validateLLMResponse({
      answer: { text: "ok" },
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer must be an array");
  });

  test("answer as empty array is rejected", () => {
    // Even pure-conversational responses should produce at least
    // one chunk like "Hello! How can I help?". Empty array means
    // the LLM has nothing to say — useless, retry.
    const result = validateLLMResponse({
      answer: [],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer must contain at least one chunk");
  });

  test("answer with a null chunk fails on that chunk only", () => {
    const result = validateLLMResponse({
      answer: [validChunk(), null, validChunk()],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[1] must be an object");
    // Other chunks remain valid; only chunk [1] errors.
    expect(result.errors.filter(e => e.startsWith("answer["))).toEqual([
      "answer[1] must be an object",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chunk-level validation
// ─────────────────────────────────────────────────────────────────────────────

describe("validateLLMResponse — chunk validation", () => {
  /**
   * Each chunk: { text: string (non-empty), source?: { documentId, range } }.
   * source is optional but, when present, must be valid.
   */

  test("chunk with empty text is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "" }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].text must be a non-empty string");
  });

  test("chunk with whitespace-only text is rejected", () => {
    // A chunk with `text: "   "` has no content for the user; we
    // don't want LLMs filling slots with whitespace.
    const result = validateLLMResponse({
      answer: [{ text: "   \n\t  " }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].text must be a non-empty string");
  });

  test("chunk with text as number is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: 42 }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
  });

  test("chunk missing text field entirely is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ source: validSource() }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].text must be a non-empty string");
  });

  test("chunk source as null is rejected (not treated as absent)", () => {
    // `source: null` is an explicit attempt to set a source to
    // something invalid. Reject it. Only undefined / omitted is
    // treated as "no source".
    const result = validateLLMResponse({
      answer: [{ text: "ok", source: null }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].source must be an object");
  });

  test("chunk source as array is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok", source: [1, 2] }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].source must be an object");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Source validation
// ─────────────────────────────────────────────────────────────────────────────

describe("validateLLMResponse — source validation", () => {
  /**
   * source: { documentId: non-empty string, range: [int, int] with
   * end >= start }.
   */

  test("source with empty documentId is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok", source: { documentId: "", range: [0, 100] } }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].source.documentId must be a non-empty string");
  });

  test("source with missing documentId is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok", source: { range: [0, 100] } }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].source.documentId must be a non-empty string");
  });

  test("source with documentId as number is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok", source: { documentId: 42, range: [0, 100] } }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
  });

  test("source with missing range is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok", source: { documentId: "d" } }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].source.range must be a two-element array [start, end]");
  });

  test("source with range as string is rejected", () => {
    // The LLM might emit "0-100" or "[0, 100]" as a string by mistake.
    const result = validateLLMResponse({
      answer: [{ text: "ok", source: { documentId: "d", range: "0-100" } }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].source.range must be a two-element array [start, end]");
  });

  test("source with range of wrong length is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok", source: { documentId: "d", range: [0, 50, 100] } }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].source.range must be a two-element array [start, end]");
  });

  test("source with non-integer range values is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok", source: { documentId: "d", range: [10.5, 20.5] } }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].source.range[0] must be a non-negative integer (got 10.5)");
    expect(result.errors).toContain("answer[0].source.range[1] must be a non-negative integer (got 20.5)");
  });

  test("source with negative range start is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok", source: { documentId: "d", range: [-5, 100] } }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].source.range[0] must be a non-negative integer (got -5)");
  });

  test("source with reversed range (end < start) is rejected", () => {
    // Logical sanity check: a range must go forward. The LLM could
    // accidentally swap them; catch this rather than emit nonsense.
    const result = validateLLMResponse({
      answer: [{ text: "ok", source: { documentId: "d", range: [500, 100] } }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].source.range[1] (100) must be >= range[0] (500)");
  });

  test("source with range of strings is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok", source: { documentId: "d", range: ["0", "100"] } }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("answer[0].source.range[0] must be a non-negative integer (got 0)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// followUpQuestions validation
// ─────────────────────────────────────────────────────────────────────────────

describe("validateLLMResponse — followUpQuestions", () => {
  test("followUpQuestions as a string is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok" }],
      followUpQuestions: "single question?",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("followUpQuestions must be an array");
  });

  test("followUpQuestions as an object is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok" }],
      followUpQuestions: { q1: "?" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("followUpQuestions must be an array");
  });

  test("empty string in followUpQuestions is rejected with index in message", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok" }],
      followUpQuestions: ["valid?", "", "also valid?"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("followUpQuestions[1] must be a non-empty string");
  });

  test("whitespace-only string in followUpQuestions is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok" }],
      followUpQuestions: ["   "],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("followUpQuestions[0] must be a non-empty string");
  });

  test("non-string in followUpQuestions is rejected", () => {
    const result = validateLLMResponse({
      answer: [{ text: "ok" }],
      followUpQuestions: ["valid?", 42],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("followUpQuestions[1] must be a non-empty string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-error accumulation
// ─────────────────────────────────────────────────────────────────────────────

describe("validateLLMResponse — error accumulation", () => {
  /**
   * The validator collects ALL errors before returning. This lets
   * prompt iteration fix multiple issues per cycle instead of one
   * at a time. These tests pin that behavior.
   */

  test("collects multiple errors across different fields", () => {
    const result = validateLLMResponse({
      answer: [
        { text: "" },                            // text error
        { text: "ok", source: null },            // source error
        { text: "ok", source: { documentId: "d", range: "bad" } },  // range error
      ],
      followUpQuestions: ["", "valid"],          // followUp error
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
    // All four kinds present:
    expect(result.errors).toContain("answer[0].text must be a non-empty string");
    expect(result.errors).toContain("answer[1].source must be an object");
    expect(result.errors).toContain("answer[2].source.range must be a two-element array [start, end]");
    expect(result.errors).toContain("followUpQuestions[0] must be a non-empty string");
  });

  test("range type error and order error don't stack (order suppressed when types invalid)", () => {
    // If start or end aren't integers, we report THAT and skip the
    // ordering check — avoiding misleading "end < start" errors
    // stacked on top of "they're not numbers." Keeps output focused.
    const result = validateLLMResponse({
      answer: [{ text: "ok", source: { documentId: "d", range: ["100", 50] } }],
      followUpQuestions: [],
    });
    expect(result.valid).toBe(false);
    // The type error should fire on the string.
    expect(result.errors).toContain("answer[0].source.range[0] must be a non-negative integer (got 100)");
    // But the ordering error should NOT fire (would be misleading).
    expect(result.errors).not.toContain(expect.stringContaining("must be >= range[0]"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper exports
// ─────────────────────────────────────────────────────────────────────────────

describe("validateLLMResponse — helper exports", () => {
  test("validateChunk is exposed", () => {
    expect(typeof validateChunk).toBe("function");
  });

  test("validateChunk works in isolation", () => {
    const errors = validateChunk({ text: "ok", source: validSource() }, 0);
    expect(errors).toEqual([]);
  });

  test("validateChunk uses the index in error paths", () => {
    const errors = validateChunk({ text: "" }, 5);
    expect(errors).toContain("answer[5].text must be a non-empty string");
  });

  test("validateSource is exposed", () => {
    expect(typeof validateSource).toBe("function");
  });

  test("validateSource works in isolation", () => {
    const errors = validateSource(validSource(), "answer[0].source");
    expect(errors).toEqual([]);
  });

  test("validateSource uses the given path in errors", () => {
    const errors = validateSource({ documentId: "", range: [0, 100] }, "answer[3].source");
    expect(errors).toContain("answer[3].source.documentId must be a non-empty string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("validateLLMResponse — module export", () => {
  test("module is the function itself", () => {
    expect(typeof validateLLMResponse).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(validateLLMResponse)).toBe(true);
  });

  test("self-referential .validateLLMResponse property", () => {
    expect(validateLLMResponse.validateLLMResponse).toBe(validateLLMResponse);
  });

  test("result always has .valid and .errors fields", () => {
    const a = validateLLMResponse(null);
    const b = validateLLMResponse(validResponse());
    expect(a).toHaveProperty("valid");
    expect(a).toHaveProperty("errors");
    expect(b).toHaveProperty("valid");
    expect(b).toHaveProperty("errors");
    expect(Array.isArray(a.errors)).toBe(true);
    expect(Array.isArray(b.errors)).toBe(true);
  });

  test("never throws on truly garbage input", () => {
    expect(() => validateLLMResponse(null)).not.toThrow();
    expect(() => validateLLMResponse(undefined)).not.toThrow();
    expect(() => validateLLMResponse(false)).not.toThrow();
    expect(() => validateLLMResponse(0)).not.toThrow();
    expect(() => validateLLMResponse(NaN)).not.toThrow();
    expect(() => validateLLMResponse([])).not.toThrow();
    expect(() => validateLLMResponse({})).not.toThrow();
  });
});
