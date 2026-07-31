"use strict";

/**
 * @file summarize.test.js
 * @brief Unit tests for the summarize() abstractive summarization function.
 *
 * The pipeline wrapper is mocked at the module level.
 * The pipeline mock returns [{summary_text}] matching the real pipeline shape.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mock the pipeline wrapper (CJS-to-ESM bridge for @xenova/transformers)
// ─────────────────────────────────────────────────────────────────────────────

const mockSummarizerPipeline = jest.fn();

jest.mock("../../src/xenova/pipeline", () =>
  jest.fn(async (task) => {
    if (task === "summarization") return mockSummarizerPipeline;
    throw new Error(`Unexpected pipeline task: ${task}`);
  })
);


// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = require("../../src/xenova/config");

const makeSummaryResult = (text = "This is a summary.") => [{ summary_text: text }];

let summarize;
beforeAll(() => {
  summarize = require("../../src/xenova/summarize");
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSummarizerPipeline.mockResolvedValue(makeSummaryResult());
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic summarization
// ─────────────────────────────────────────────────────────────────────────────

describe("summarize — basic", () => {
  test("returns summary_text string", async () => {
    const result = await summarize("Long text about biofilms.", {
      summarizer: mockSummarizerPipeline,
    });
    expect(typeof result).toBe("string");
    expect(result).toBe("This is a summary.");
  });

  test("passes text directly to pipeline", async () => {
    const text = "Biofilms resist treatment through multiple mechanisms.";
    await summarize(text, { summarizer: mockSummarizerPipeline });
    expect(mockSummarizerPipeline.mock.calls[0][0]).toBe(text);
  });

  test("returns summary_text from first result", async () => {
    mockSummarizerPipeline.mockResolvedValue([{ summary_text: "Custom summary." }]);
    const result = await summarize("Input text.", { summarizer: mockSummarizerPipeline });
    expect(result).toBe("Custom summary.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Default options
// ─────────────────────────────────────────────────────────────────────────────

describe("summarize — default options", () => {
  test("default max_length is 200", async () => {
    await summarize("text", { summarizer: mockSummarizerPipeline });
    const opts = mockSummarizerPipeline.mock.calls[0][1];
    expect(opts.max_length).toBe(200);
  });

  test("default max_new_tokens equals max_length (200)", async () => {
    await summarize("text", { summarizer: mockSummarizerPipeline });
    const opts = mockSummarizerPipeline.mock.calls[0][1];
    expect(opts.max_new_tokens).toBe(200);
  });

  test("default min_length is 20", async () => {
    await summarize("text", { summarizer: mockSummarizerPipeline });
    const opts = mockSummarizerPipeline.mock.calls[0][1];
    expect(opts.min_length).toBe(20);
  });

  test("default do_sample is false", async () => {
    await summarize("text", { summarizer: mockSummarizerPipeline });
    const opts = mockSummarizerPipeline.mock.calls[0][1];
    expect(opts.do_sample).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Custom options
// ─────────────────────────────────────────────────────────────────────────────

describe("summarize — custom options", () => {
  test("custom max_length forwarded as both max_length and max_new_tokens", async () => {
    await summarize("text", { summarizer: mockSummarizerPipeline, max_length: 50 });
    const opts = mockSummarizerPipeline.mock.calls[0][1];
    expect(opts.max_length).toBe(50);
    expect(opts.max_new_tokens).toBe(50);
  });

  test("custom max_new_tokens overrides max_length default", async () => {
    await summarize("text", { summarizer: mockSummarizerPipeline, max_new_tokens: 75 });
    const opts = mockSummarizerPipeline.mock.calls[0][1];
    expect(opts.max_new_tokens).toBe(75);
  });

  test("custom min_length forwarded", async () => {
    await summarize("text", { summarizer: mockSummarizerPipeline, min_length: 5 });
    const opts = mockSummarizerPipeline.mock.calls[0][1];
    expect(opts.min_length).toBe(5);
  });

  test("do_sample:true forwarded", async () => {
    await summarize("text", { summarizer: mockSummarizerPipeline, do_sample: true });
    const opts = mockSummarizerPipeline.mock.calls[0][1];
    expect(opts.do_sample).toBe(true);
  });

  test("extra options passed through via spread", async () => {
    await summarize("text", { summarizer: mockSummarizerPipeline, truncation: true });
    const opts = mockSummarizerPipeline.mock.calls[0][1];
    expect(opts.truncation).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lazy initialization
// ─────────────────────────────────────────────────────────────────────────────

describe("summarize — lazy initialization", () => {
  test("initializes pipeline when no summarizer provided", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshSummarize = require("../../src/xenova/summarize");
    mockSummarizerPipeline.mockResolvedValue(makeSummaryResult());
    await freshSummarize("text");
    expect(pipeline).toHaveBeenCalledWith("summarization", CONFIG.summarizationModel, expect.anything());
  });

  test("reuses singleton on second call", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshSummarize = require("../../src/xenova/summarize");
    mockSummarizerPipeline.mockResolvedValue(makeSummaryResult());
    await freshSummarize("text 1");
    await freshSummarize("text 2");
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  test("provided summarizer skips pipeline init", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshSummarize = require("../../src/xenova/summarize");
    await freshSummarize("text", { summarizer: mockSummarizerPipeline });
    expect(pipeline).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createSummarizer
// ─────────────────────────────────────────────────────────────────────────────

describe("summarize.createSummarizer", () => {
  test("exposed on summarize function", () => {
    expect(typeof summarize.createSummarizer).toBe("function");
  });

  test("calls pipeline with summarization task and provided model", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshSummarize = require("../../src/xenova/summarize");
    await freshSummarize.createSummarizer("custom/summarizer");
    expect(pipeline).toHaveBeenCalledWith("summarization", "custom/summarizer", expect.anything());
  });

  test("falls back to CONFIG model when none provided", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshSummarize = require("../../src/xenova/summarize");
    await freshSummarize.createSummarizer();
    expect(pipeline).toHaveBeenCalledWith("summarization", CONFIG.summarizationModel, expect.anything());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("summarize — module export", () => {
  test("module is frozen", () => {
    expect(Object.isFrozen(summarize)).toBe(true);
  });

  test("summarize.summarize references same function", () => {
    expect(summarize.summarize).toBe(summarize);
  });
});