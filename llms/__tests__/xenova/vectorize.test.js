"use strict";

/**
 * @file vectorize.test.js
 * @brief Unit tests for vectorize(), defaultTextNormalization, and createExtractor.
 *
 * Key behaviors under test:
 * - Text normalization: punctuation stripped (hyphens preserved), whitespace collapsed
 * - normalizeText: true (default) / false / custom function
 * - normalizeVector / normalize alias forwarded to pipeline
 * - pooling option forwarded
 * - Falsy text coerced to ""
 * - Output is always Float32Array
 * - Lazy init singleton + provided extractor bypass
 * - createExtractor and defaultTextNormalization exposed on vectorize
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mock the pipeline wrapper (which bridges CJS → ESM for @xenova/transformers)
// ─────────────────────────────────────────────────────────────────────────────
//
// `vectorize.js` no longer requires `@xenova/transformers` directly — it
// goes through `./pipeline.js`, the dynamic-import wrapper. So the right
// mock target here is the wrapper. The mock receives the same (task,
// modelId) args the wrapper would, dispatches by task, and returns the
// appropriate fake pipeline instance.

const MOCK_EMBEDDING = new Float32Array([0.1, 0.2, 0.3, 0.4]);

const mockExtractorPipeline = jest.fn();

jest.mock("../../src/xenova/pipeline", () =>
  jest.fn(async (task) => {
    if (task === "feature-extraction") return mockExtractorPipeline;
    throw new Error(`Unexpected pipeline task: ${task}`);
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = require("../../src/xenova/config");

let vectorize;
let defaultTextNormalization;

beforeAll(() => {
  vectorize = require("../../src/xenova/vectorize");
  ({ defaultTextNormalization } = vectorize);
});

beforeEach(() => {
  jest.clearAllMocks();
  // Pipeline mock returns an object with .data property (matches Transformers.js tensor)
  mockExtractorPipeline.mockResolvedValue({ data: MOCK_EMBEDDING });
});

// ─────────────────────────────────────────────────────────────────────────────
// defaultTextNormalization
// ─────────────────────────────────────────────────────────────────────────────

describe("defaultTextNormalization", () => {
  test("strips punctuation, replacing with space then trimming", () => {
    // ? replaced with space → "What is water treatment " → trimmed → no trailing space
    expect(defaultTextNormalization("What is water treatment?"))
      .toBe("What is water treatment");
  });

  test("preserves hyphens", () => {
    expect(defaultTextNormalization("Legionella-prevention best practices."))
      .toBe("Legionella-prevention best practices");
  });

  test("collapses multiple spaces", () => {
    expect(defaultTextNormalization("water   treatment   definition"))
      .toBe("water treatment definition");
  });

  test("trims leading and trailing whitespace", () => {
    expect(defaultTextNormalization("  hello world  ")).toBe("hello world");
  });

  test("replaces punctuation with space, not empty string — adjacent words stay separate", () => {
    // "treatment.Plan" → "treatment Plan" not "treatmentPlan"
    expect(defaultTextNormalization("treatment.Plan")).toBe("treatment Plan");
  });

  test("em-dash replaced with space, then whitespace collapsed", () => {
    // "biofilm — resistance" → spaces around em-dash → collapsed to single spaces
    expect(defaultTextNormalization("biofilm — resistance"))
      .toBe("biofilm resistance");
  });

  test("empty string returns empty string", () => {
    expect(defaultTextNormalization("")).toBe("");
  });

  test("only punctuation returns empty string after trim", () => {
    expect(defaultTextNormalization(".,;!?")).toBe("");
  });

  test("hyphenated compound preserved intact", () => {
    expect(defaultTextNormalization("bio-film control")).toBe("bio-film control");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// vectorize — output shape
// ─────────────────────────────────────────────────────────────────────────────

describe("vectorize — output shape", () => {
  test("returns a Float32Array", async () => {
    const result = await vectorize("water treatment", { extractor: mockExtractorPipeline });
    expect(result).toBeInstanceOf(Float32Array);
  });

  test("Float32Array contents match pipeline data within float32 precision", async () => {
    const result = await vectorize("water treatment", { extractor: mockExtractorPipeline });
    expect(result[0]).toBeCloseTo(0.1, 5);
    expect(result[1]).toBeCloseTo(0.2, 5);
    expect(result[2]).toBeCloseTo(0.3, 5);
    expect(result[3]).toBeCloseTo(0.4, 5);
  });

  test("returns Float32Array even when pipeline returns plain array", async () => {
    mockExtractorPipeline.mockResolvedValue({ data: [0.5, 0.6] });
    const result = await vectorize("text", { extractor: mockExtractorPipeline });
    expect(result).toBeInstanceOf(Float32Array);
    expect(result[0]).toBeCloseTo(0.5, 5);
    expect(result[1]).toBeCloseTo(0.6, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// vectorize — text normalization
// ─────────────────────────────────────────────────────────────────────────────

describe("vectorize — text normalization", () => {
  test("normalizeText:true (default) strips punctuation before embedding", async () => {
    await vectorize("What is pH?", { extractor: mockExtractorPipeline });
    const passedText = mockExtractorPipeline.mock.calls[0][0];
    expect(passedText).not.toContain("?");
    expect(passedText).toContain("pH");
  });

  test("normalizeText:false passes raw text to pipeline", async () => {
    await vectorize("What is pH?", {
      extractor: mockExtractorPipeline,
      normalizeText: false,
    });
    const passedText = mockExtractorPipeline.mock.calls[0][0];
    expect(passedText).toBe("What is pH?");
  });

  test("normalizeText:custom function applied to text", async () => {
    const custom = (t) => t.toUpperCase();
    await vectorize("hello world", {
      extractor: mockExtractorPipeline,
      normalizeText: custom,
    });
    expect(mockExtractorPipeline.mock.calls[0][0]).toBe("HELLO WORLD");
  });

  test("falsy text coerced to empty string", async () => {
    await vectorize(null, { extractor: mockExtractorPipeline });
    expect(mockExtractorPipeline.mock.calls[0][0]).toBe("");
  });

  test("undefined text coerced to empty string", async () => {
    await vectorize(undefined, { extractor: mockExtractorPipeline });
    expect(mockExtractorPipeline.mock.calls[0][0]).toBe("");
  });

  test("number text coerced then normalized", async () => {
    // falsy 0 → "" after coerce, then normalized
    await vectorize(0, { extractor: mockExtractorPipeline });
    expect(mockExtractorPipeline.mock.calls[0][0]).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// vectorize — pipeline options forwarding
// ─────────────────────────────────────────────────────────────────────────────

describe("vectorize — pipeline options", () => {
  test("default pooling is 'mean'", async () => {
    await vectorize("text", { extractor: mockExtractorPipeline });
    const opts = mockExtractorPipeline.mock.calls[0][1];
    expect(opts.pooling).toBe("mean");
  });

  test("custom pooling forwarded", async () => {
    await vectorize("text", { extractor: mockExtractorPipeline, pooling: "cls" });
    expect(mockExtractorPipeline.mock.calls[0][1].pooling).toBe("cls");
  });

  test("default normalize (normalizeVector) is true", async () => {
    await vectorize("text", { extractor: mockExtractorPipeline });
    const opts = mockExtractorPipeline.mock.calls[0][1];
    expect(opts.normalize).toBe(true);
  });

  test("normalizeVector:false → normalize:false forwarded to pipeline", async () => {
    await vectorize("text", { extractor: mockExtractorPipeline, normalizeVector: false });
    expect(mockExtractorPipeline.mock.calls[0][1].normalize).toBe(false);
  });

  test("extractor not forwarded in pipeline options", async () => {
    await vectorize("text", { extractor: mockExtractorPipeline });
    const opts = mockExtractorPipeline.mock.calls[0][1];
    expect(opts.extractor).toBeUndefined();
  });

  test("normalizeText not forwarded to pipeline", async () => {
    await vectorize("text", { extractor: mockExtractorPipeline, normalizeText: false });
    const opts = mockExtractorPipeline.mock.calls[0][1];
    expect(opts.normalizeText).toBeUndefined();
  });

  test("featureExtractionModel not forwarded to pipeline", async () => {
    await vectorize("text", {
      extractor: mockExtractorPipeline,
      featureExtractionModel: "some/model",
    });
    expect(mockExtractorPipeline.mock.calls[0][1].featureExtractionModel).toBeUndefined();
  });

  test("extra options forwarded via spread", async () => {
    await vectorize("text", { extractor: mockExtractorPipeline, batch_size: 8 });
    expect(mockExtractorPipeline.mock.calls[0][1].batch_size).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// vectorize — lazy initialization
// ─────────────────────────────────────────────────────────────────────────────

describe("vectorize — lazy initialization", () => {
  test("initializes pipeline when no extractor provided", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshVectorize = require("../../src/xenova/vectorize");
    mockExtractorPipeline.mockResolvedValue({ data: MOCK_EMBEDDING });
    await freshVectorize("text");
    expect(pipeline).toHaveBeenCalledWith(
      "feature-extraction",
      CONFIG.featureExtractionModel,
      expect.anything()
    );
  });

  test("reuses singleton on second call", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshVectorize = require("../../src/xenova/vectorize");
    mockExtractorPipeline.mockResolvedValue({ data: MOCK_EMBEDDING });
    await freshVectorize("text 1");
    await freshVectorize("text 2");
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  test("provided extractor skips pipeline init", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshVectorize = require("../../src/xenova/vectorize");
    await freshVectorize("text", { extractor: mockExtractorPipeline });
    expect(pipeline).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createExtractor
// ─────────────────────────────────────────────────────────────────────────────

describe("vectorize.createExtractor", () => {
  test("exposed on vectorize function", () => {
    expect(typeof vectorize.createExtractor).toBe("function");
  });

  test("calls pipeline with feature-extraction task and provided model", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshVectorize = require("../../src/xenova/vectorize");
    await freshVectorize.createExtractor("custom/embedding-model");
    expect(pipeline).toHaveBeenCalledWith("feature-extraction", "custom/embedding-model", expect.anything());
  });

  test("falls back to CONFIG model when none provided", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshVectorize = require("../../src/xenova/vectorize");
    await freshVectorize.createExtractor();
    expect(pipeline).toHaveBeenCalledWith(
      "feature-extraction",
      CONFIG.featureExtractionModel,
      expect.anything()
    );
  });

  test("returns the pipeline instance", async () => {
    const instance = await vectorize.createExtractor("any/model");
    expect(instance).toBe(mockExtractorPipeline);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// defaultTextNormalization exposed on vectorize
// ─────────────────────────────────────────────────────────────────────────────

describe("vectorize.defaultTextNormalization", () => {
  test("exposed on vectorize function", () => {
    expect(typeof vectorize.defaultTextNormalization).toBe("function");
  });

  test("produces same result as module-level function", () => {
    const text = "Biofilm — resistance?";
    expect(vectorize.defaultTextNormalization(text))
      .toBe(defaultTextNormalization(text));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("vectorize — module export", () => {
  test("module is frozen", () => {
    expect(Object.isFrozen(vectorize)).toBe(true);
  });

  test("vectorize.vectorize references same function", () => {
    expect(vectorize.vectorize).toBe(vectorize);
  });
});