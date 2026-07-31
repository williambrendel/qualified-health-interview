"use strict";

/**
 * @file synthesize.test.js
 * @brief Unit tests for the synthesize() generative text2text function.
 *
 * The pipeline wrapper is mocked at module level.
 * Pipeline mock returns [{generated_text}] matching the real pipeline shape.
 * synthesize() returns result[0].generated_text — a string.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mock the pipeline wrapper (CJS-to-ESM bridge for @xenova/transformers)
// ─────────────────────────────────────────────────────────────────────────────

const mockSynthesizerPipeline = jest.fn();

jest.mock("../../src/xenova/pipeline", () =>
  jest.fn(async (task) => {
    if (task === "text2text-generation") return mockSynthesizerPipeline;
    throw new Error(`Unexpected pipeline task: ${task}`);
  })
);


// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = require("../../src/xenova/config");

const makeGenerationResult = (text = "Generated answer.") => [{ generated_text: text }];

let synthesize;
beforeAll(() => {
  synthesize = require("../../src/xenova/synthesize");
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSynthesizerPipeline.mockResolvedValue(makeGenerationResult());
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic generation
// ─────────────────────────────────────────────────────────────────────────────

describe("synthesize — basic", () => {
  test("returns generated_text string", async () => {
    const result = await synthesize("Explain biofilms.", {
      synthesizer: mockSynthesizerPipeline,
    });
    expect(typeof result).toBe("string");
    expect(result).toBe("Generated answer.");
  });

  test("passes prompt to pipeline", async () => {
    const prompt = "Summarize: Biofilms are complex.";
    await synthesize(prompt, { synthesizer: mockSynthesizerPipeline });
    expect(mockSynthesizerPipeline.mock.calls[0][0]).toBe(prompt);
  });

  test("returns first result generated_text", async () => {
    mockSynthesizerPipeline.mockResolvedValue([{ generated_text: "Custom output." }]);
    const result = await synthesize("prompt", { synthesizer: mockSynthesizerPipeline });
    expect(result).toBe("Custom output.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Default options
// ─────────────────────────────────────────────────────────────────────────────

describe("synthesize — default options", () => {
  const getOpts = async () => {
    await synthesize("prompt", { synthesizer: mockSynthesizerPipeline });
    return mockSynthesizerPipeline.mock.calls[0][1];
  };

  test("default min_length is 0", async () => {
    expect((await getOpts()).min_length).toBe(0);
  });

  test("default max_length / max_new_tokens is 200", async () => {
    const opts = await getOpts();
    expect(opts.max_length).toBe(200);
    expect(opts.max_new_tokens).toBe(200);
  });

  test("default temperature is 0.3", async () => {
    expect((await getOpts()).temperature).toBe(0.3);
  });

  test("default do_sample is true", async () => {
    expect((await getOpts()).do_sample).toBe(true);
  });

  test("default repetition_penalty is 1.2", async () => {
    expect((await getOpts()).repetition_penalty).toBe(1.2);
  });

  test("default length_penalty is 1", async () => {
    expect((await getOpts()).length_penalty).toBe(1);
  });

  test("default num_beams is 5", async () => {
    expect((await getOpts()).num_beams).toBe(5);
  });

  test("default no_repeat_ngram_size is 3", async () => {
    expect((await getOpts()).no_repeat_ngram_size).toBe(3);
  });

  test("default early_stopping is true", async () => {
    expect((await getOpts()).early_stopping).toBe(true);
  });

  test("default stopping_criteria is null", async () => {
    expect((await getOpts()).stopping_criteria).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Custom options
// ─────────────────────────────────────────────────────────────────────────────

describe("synthesize — custom options", () => {
  test("custom max_length forwarded as both max_length and max_new_tokens", async () => {
    await synthesize("prompt", { synthesizer: mockSynthesizerPipeline, max_length: 100 });
    const opts = mockSynthesizerPipeline.mock.calls[0][1];
    expect(opts.max_length).toBe(100);
    expect(opts.max_new_tokens).toBe(100);
  });

  test("custom max_new_tokens overrides default", async () => {
    await synthesize("prompt", { synthesizer: mockSynthesizerPipeline, max_new_tokens: 50 });
    const opts = mockSynthesizerPipeline.mock.calls[0][1];
    expect(opts.max_new_tokens).toBe(50);
  });

  test("custom temperature forwarded", async () => {
    await synthesize("prompt", { synthesizer: mockSynthesizerPipeline, temperature: 0.7 });
    expect(mockSynthesizerPipeline.mock.calls[0][1].temperature).toBe(0.7);
  });

  test("custom num_beams forwarded", async () => {
    await synthesize("prompt", { synthesizer: mockSynthesizerPipeline, num_beams: 1 });
    expect(mockSynthesizerPipeline.mock.calls[0][1].num_beams).toBe(1);
  });

  test("stopping_criteria forwarded when provided", async () => {
    const criteria = [() => false];
    await synthesize("prompt", { synthesizer: mockSynthesizerPipeline, stopping_criteria: criteria });
    expect(mockSynthesizerPipeline.mock.calls[0][1].stopping_criteria).toBe(criteria);
  });

  test("extra options passed through via spread", async () => {
    await synthesize("prompt", { synthesizer: mockSynthesizerPipeline, forced_eos_token_id: 1 });
    expect(mockSynthesizerPipeline.mock.calls[0][1].forced_eos_token_id).toBe(1);
  });

  test("synthesizer and text2textModel not forwarded to pipeline call", async () => {
    await synthesize("prompt", {
      synthesizer: mockSynthesizerPipeline,
      text2textModel: "some/model",
    });
    const opts = mockSynthesizerPipeline.mock.calls[0][1];
    expect(opts.synthesizer).toBeUndefined();
    expect(opts.text2textModel).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lazy initialization
// ─────────────────────────────────────────────────────────────────────────────

describe("synthesize — lazy initialization", () => {
  test("initializes pipeline when no synthesizer provided", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshSynthesize = require("../../src/xenova/synthesize");
    mockSynthesizerPipeline.mockResolvedValue(makeGenerationResult());
    await freshSynthesize("prompt", { synthesizer: undefined });
    expect(pipeline).toHaveBeenCalledWith("text2text-generation", CONFIG.text2textModel, expect.anything());
  });

  test("reuses singleton on second call", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshSynthesize = require("../../src/xenova/synthesize");
    mockSynthesizerPipeline.mockResolvedValue(makeGenerationResult());
    await freshSynthesize("prompt 1", { synthesizer: undefined });
    await freshSynthesize("prompt 2", { synthesizer: undefined });
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  test("provided synthesizer skips pipeline init", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshSynthesize = require("../../src/xenova/synthesize");
    await freshSynthesize("prompt", { synthesizer: mockSynthesizerPipeline });
    expect(pipeline).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createSynthesizer
// ─────────────────────────────────────────────────────────────────────────────

describe("synthesize.createSynthesizer", () => {
  test("exposed on synthesize function", () => {
    expect(typeof synthesize.createSynthesizer).toBe("function");
  });

  test("calls pipeline with text2text-generation task and provided model", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshSynthesize = require("../../src/xenova/synthesize");
    await freshSynthesize.createSynthesizer("custom/t5-model");
    expect(pipeline).toHaveBeenCalledWith("text2text-generation", "custom/t5-model", expect.anything());
  });

  test("falls back to CONFIG model when none provided", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshSynthesize = require("../../src/xenova/synthesize");
    await freshSynthesize.createSynthesizer();
    expect(pipeline).toHaveBeenCalledWith("text2text-generation", CONFIG.text2textModel, expect.anything());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("synthesize — module export", () => {
  test("module is frozen", () => {
    expect(Object.isFrozen(synthesize)).toBe(true);
  });

  test("synthesize.synthesize references same function", () => {
    expect(synthesize.synthesize).toBe(synthesize);
  });
});