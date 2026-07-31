"use strict";

/**
 * @file answer.test.js
 * @brief Unit tests for the answer() extractive QA function.
 *
 * The pipeline wrapper is mocked at the module level.
 * answer() is re-required after mock registration so the module-level
 * singleton starts fresh for each describe block via jest.resetModules().
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mock the pipeline wrapper (CJS-to-ESM bridge for @xenova/transformers)
// ─────────────────────────────────────────────────────────────────────────────

const mockQAPipeline = jest.fn();

jest.mock("../../src/xenova/pipeline", () =>
  jest.fn(async (task) => {
    if (task === "question-answering") return mockQAPipeline;
    throw new Error(`Unexpected pipeline task: ${task}`);
  })
);


// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = require("../../src/xenova/config");

const makeQAResult = (overrides = {}) => ({
  answer: "42",
  score:  0.95,
  start:  10,
  end:    12,
  ...overrides,
});

// Fresh require after resetting modules — ensures module-level singleton
// is cleared between describe blocks that test lazy init.
let answer;
beforeAll(() => {
  answer = require("../../src/xenova/answer");
});

beforeEach(() => {
  jest.clearAllMocks();
  mockQAPipeline.mockResolvedValue(makeQAResult());
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic QA
// ─────────────────────────────────────────────────────────────────────────────

describe("answer — basic QA", () => {
  test("returns answer object with correct shape", async () => {
    const result = await answer("What is the answer?", "The answer is 42.", {
      questionAnswering: mockQAPipeline,
    });
    expect(result).toMatchObject({ answer: "42", score: 0.95, start: 10, end: 12 });
  });

  test("passes question and context to pipeline", async () => {
    await answer("What is pH?", "pH is a measure of acidity.", {
      questionAnswering: mockQAPipeline,
    });
    expect(mockQAPipeline).toHaveBeenCalledTimes(1);
    const [q, ctx] = mockQAPipeline.mock.calls[0];
    expect(q).toBe("What is pH?");
    expect(ctx).toBe("pH is a measure of acidity.");
  });

  test("normalizes question with NFC and trim", async () => {
    await answer("  What is pH?  ", "pH is a measure of acidity.", {
      questionAnswering: mockQAPipeline,
    });
    const [q] = mockQAPipeline.mock.calls[0];
    expect(q).toBe("What is pH?");
  });

  test("normalizes context with NFC and trim", async () => {
    await answer("What is pH?", "  pH is a measure of acidity.  ", {
      questionAnswering: mockQAPipeline,
    });
    const [, ctx] = mockQAPipeline.mock.calls[0];
    expect(ctx).toBe("pH is a measure of acidity.");
  });

  test("passes topk to pipeline", async () => {
    await answer("What?", "Context.", { questionAnswering: mockQAPipeline, topk: 3 });
    const [, , opts] = mockQAPipeline.mock.calls[0];
    expect(opts.topk).toBe(3);
  });

  test("passes extra options through to pipeline", async () => {
    await answer("What?", "Context.", {
      questionAnswering: mockQAPipeline,
      handle_impossible_answer: true,
    });
    const [, , opts] = mockQAPipeline.mock.calls[0];
    expect(opts.handle_impossible_answer).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lazy initialization
// ─────────────────────────────────────────────────────────────────────────────

describe("answer — lazy initialization", () => {
  test("initializes pipeline when no questionAnswering provided", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshAnswer = require("../../src/xenova/answer");
    mockQAPipeline.mockResolvedValue(makeQAResult());
    await freshAnswer("What?", "Context.");
    expect(pipeline).toHaveBeenCalledWith(
      "question-answering",
      CONFIG.questionAnsweringModel,
      expect.anything()
    );
  });

  test("reuses singleton on second call — pipeline init called once", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshAnswer = require("../../src/xenova/answer");
    mockQAPipeline.mockResolvedValue(makeQAResult());
    await freshAnswer("Q1?", "Context 1.");
    await freshAnswer("Q2?", "Context 2.");
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  test("provided questionAnswering skips pipeline init", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshAnswer = require("../../src/xenova/answer");
    await freshAnswer("What?", "Context.", { questionAnswering: mockQAPipeline });
    expect(pipeline).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createQuestionAnswering
// ─────────────────────────────────────────────────────────────────────────────

describe("answer.createQuestionAnswering", () => {
  test("exposed on answer function", () => {
    expect(typeof answer.createQuestionAnswering).toBe("function");
  });

  test("calls pipeline with question-answering task and provided model", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshAnswer = require("../../src/xenova/answer");
    await freshAnswer.createQuestionAnswering("custom/qa-model");
    expect(pipeline).toHaveBeenCalledWith("question-answering", "custom/qa-model", expect.anything());
  });

  test("falls back to CONFIG model when none provided", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshAnswer = require("../../src/xenova/answer");
    await freshAnswer.createQuestionAnswering();
    expect(pipeline).toHaveBeenCalledWith(
      "question-answering",
      CONFIG.questionAnsweringModel,
      expect.anything()
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("answer — module export", () => {
  test("module is frozen", () => {
    expect(Object.isFrozen(answer)).toBe(true);
  });

  test("answer.answer references same function", () => {
    expect(answer.answer).toBe(answer);
  });
});