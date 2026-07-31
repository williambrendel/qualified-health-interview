"use strict";

/**
 * @file prewarm.test.js
 * @brief Tests for the umbrella prewarm() and each module's prewarm().
 *
 * The pipeline wrapper is mocked at module level. Each xenova/*.js
 * module's prewarm is exercised through the umbrella, then directly.
 *
 * Important: jest.resetModules() is used heavily because the modules
 * carry their own singleton state (modelPromise). Tests that exercise
 * lazy loading need a fresh module state; tests that exercise injected
 * pipelines also need a fresh state to avoid cross-test pollution.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mock the pipeline wrapper
// ─────────────────────────────────────────────────────────────────────────────

// Single mock pipeline used across all tasks. Each xenova module asks
// pipeline() for a different task; we route by task name to a per-task
// mock so we can verify the right task was requested.

const mockExtractor   = jest.fn();
const mockClassifier  = jest.fn();
const mockQA          = jest.fn();
const mockSummarizer  = jest.fn();
const mockSynthesizer = jest.fn();

jest.mock("../../src/xenova/pipeline", () =>
  jest.fn(async (task) => {
    switch (task) {
      case "feature-extraction":       return mockExtractor;
      case "zero-shot-classification": return mockClassifier;
      case "question-answering":       return mockQA;
      case "summarization":            return mockSummarizer;
      case "text2text-generation":     return mockSynthesizer;
      default:
        throw new Error(`Unexpected pipeline task: ${task}`);
    }
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Per-module prewarm() tests
// ─────────────────────────────────────────────────────────────────────────────

describe("vectorize.prewarm", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("loads default model when called with no args", async () => {
    const pipeline  = require("../../src/xenova/pipeline");
    const vectorize = require("../../src/xenova/vectorize");
    const result = await vectorize.prewarm();
    expect(pipeline).toHaveBeenCalledWith("feature-extraction", expect.any(String), expect.anything());
    expect(result).toBe(mockExtractor);
  });

  test("loads override model when featureExtractionModel provided", async () => {
    const pipeline  = require("../../src/xenova/pipeline");
    const vectorize = require("../../src/xenova/vectorize");
    await vectorize.prewarm({ featureExtractionModel: "custom/model" });
    expect(pipeline).toHaveBeenCalledWith("feature-extraction", "custom/model", expect.anything());
  });

  test("uses pre-instantiated extractor without loading", async () => {
    const pipeline  = require("../../src/xenova/pipeline");
    const vectorize = require("../../src/xenova/vectorize");
    const custom = jest.fn();
    const result = await vectorize.prewarm({ extractor: custom });
    expect(pipeline).not.toHaveBeenCalled();
    expect(result).toBe(custom);
  });

  test("subsequent calls reuse singleton — pipeline init called once", async () => {
    const pipeline  = require("../../src/xenova/pipeline");
    const vectorize = require("../../src/xenova/vectorize");
    await vectorize.prewarm();
    await vectorize.prewarm();
    await vectorize.prewarm();
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  test("concurrent first-calls share a single in-flight load", async () => {
    const pipeline  = require("../../src/xenova/pipeline");
    const vectorize = require("../../src/xenova/vectorize");
    await Promise.all([vectorize.prewarm(), vectorize.prewarm(), vectorize.prewarm()]);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });
});

describe("classify.prewarm", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("loads default model when called with no args", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const classify = require("../../src/xenova/classify");
    const result = await classify.prewarm();
    expect(pipeline).toHaveBeenCalledWith("zero-shot-classification", expect.any(String), expect.anything());
    expect(result).toBe(mockClassifier);
  });

  test("uses pre-instantiated classifier without loading", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const classify = require("../../src/xenova/classify");
    const custom = jest.fn();
    const result = await classify.prewarm({ classifier: custom });
    expect(pipeline).not.toHaveBeenCalled();
    expect(result).toBe(custom);
  });

  test("override model via zeroShotClassificationModel option", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const classify = require("../../src/xenova/classify");
    await classify.prewarm({ zeroShotClassificationModel: "custom/nli" });
    expect(pipeline).toHaveBeenCalledWith("zero-shot-classification", "custom/nli", expect.anything());
  });
});

describe("answer.prewarm", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("loads default model", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const answer = require("../../src/xenova/answer");
    const result = await answer.prewarm();
    expect(pipeline).toHaveBeenCalledWith("question-answering", expect.any(String), expect.anything());
    expect(result).toBe(mockQA);
  });

  test("uses pre-instantiated questionAnswering", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const answer = require("../../src/xenova/answer");
    const custom = jest.fn();
    await answer.prewarm({ questionAnswering: custom });
    expect(pipeline).not.toHaveBeenCalled();
  });
});

describe("summarize.prewarm", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("loads default model", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const summarize = require("../../src/xenova/summarize");
    const result = await summarize.prewarm();
    expect(pipeline).toHaveBeenCalledWith("summarization", expect.any(String), expect.anything());
    expect(result).toBe(mockSummarizer);
  });

  test("uses pre-instantiated summarizer", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const summarize = require("../../src/xenova/summarize");
    const custom = jest.fn();
    await summarize.prewarm({ summarizer: custom });
    expect(pipeline).not.toHaveBeenCalled();
  });
});

describe("synthesize.prewarm", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("loads default model", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const synthesize = require("../../src/xenova/synthesize");
    const result = await synthesize.prewarm();
    expect(pipeline).toHaveBeenCalledWith("text2text-generation", expect.any(String), expect.anything());
    expect(result).toBe(mockSynthesizer);
  });

  test("uses pre-instantiated synthesizer", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const synthesize = require("../../src/xenova/synthesize");
    const custom = jest.fn();
    await synthesize.prewarm({ synthesizer: custom });
    expect(pipeline).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Umbrella prewarm() — default behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("prewarm umbrella — defaults", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("with no args, warms all five models in parallel", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const prewarm  = require("../../src/xenova/prewarm");
    const report = await prewarm();

    // All five tasks should have been requested. We don't care about
    // call order — Promise.all means they can interleave.
    const tasks = pipeline.mock.calls.map(c => c[0]);
    expect(tasks).toEqual(expect.arrayContaining([
      "feature-extraction",
      "zero-shot-classification",
      "question-answering",
      "summarization",
      "text2text-generation",
    ]));
    expect(pipeline).toHaveBeenCalledTimes(5);

    // Report should have all five keys with non-null values.
    expect(report).toEqual({
      features:   mockExtractor,
      classify:   mockClassifier,
      answer:     mockQA,
      summarize:  mockSummarizer,
      synthesize: mockSynthesizer,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Umbrella prewarm() — selective options
// ─────────────────────────────────────────────────────────────────────────────

describe("prewarm umbrella — selective options", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("only requested capabilities are loaded", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const prewarm  = require("../../src/xenova/prewarm");
    const report = await prewarm({
      features: true,
      classify: true,
      // answer, summarize, synthesize intentionally omitted
    });
    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(report.features).toBe(mockExtractor);
    expect(report.classify).toBe(mockClassifier);
    expect(report.answer).toBeNull();
    expect(report.summarize).toBeNull();
    expect(report.synthesize).toBeNull();
  });

  test("false-y values skip loading", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const prewarm  = require("../../src/xenova/prewarm");
    const report = await prewarm({
      features:   true,
      classify:   false,
      answer:     null,
      summarize:  undefined,
      synthesize: 0,
    });
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(report.features).toBe(mockExtractor);
    expect(report.classify).toBeNull();
    expect(report.answer).toBeNull();
    expect(report.summarize).toBeNull();
    expect(report.synthesize).toBeNull();
  });

  test("object values are forwarded to underlying prewarm as options", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const prewarm  = require("../../src/xenova/prewarm");
    await prewarm({
      features: { featureExtractionModel: "custom/embedding" },
      classify: { zeroShotClassificationModel: "custom/nli" },
    });
    expect(pipeline).toHaveBeenCalledWith("feature-extraction",       "custom/embedding", expect.anything());
    expect(pipeline).toHaveBeenCalledWith("zero-shot-classification", "custom/nli",       expect.anything());
  });

  test("pre-instantiated pipelines bypass loading entirely", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const prewarm  = require("../../src/xenova/prewarm");
    const customExtractor  = jest.fn();
    const customClassifier = jest.fn();
    const report = await prewarm({
      features: { extractor:  customExtractor },
      classify: { classifier: customClassifier },
    });
    expect(pipeline).not.toHaveBeenCalled();
    expect(report.features).toBe(customExtractor);
    expect(report.classify).toBe(customClassifier);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Umbrella prewarm() — idempotence
// ─────────────────────────────────────────────────────────────────────────────

describe("prewarm umbrella — idempotence", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("calling twice does not double-load", async () => {
    const pipeline = require("../../src/xenova/pipeline");
    const prewarm  = require("../../src/xenova/prewarm");
    await prewarm();
    await prewarm();
    expect(pipeline).toHaveBeenCalledTimes(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("prewarm — module export", () => {
  test("module is frozen", () => {
    const prewarm = require("../../src/xenova/prewarm");
    expect(Object.isFrozen(prewarm)).toBe(true);
  });

  test("prewarm.prewarm references same function", () => {
    const prewarm = require("../../src/xenova/prewarm");
    expect(prewarm.prewarm).toBe(prewarm);
  });
});
