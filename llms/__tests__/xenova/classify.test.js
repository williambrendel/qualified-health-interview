"use strict";

/**
 * @file classify.test.js
 * @brief Unit tests for classify() and createClassifier.
 *
 * Key behaviors under test:
 * - Output shape: { labels, scores } parallel arrays sorted descending
 * - hypothesisTemplate forwarded as `hypothesis_template`
 * - multiLabel forwarded as `multi_label`
 * - Falsy text coerced to ""
 * - Default hypothesis template and multiLabel applied
 * - Lazy init singleton + provided classifier bypass
 * - classifier/zeroShotClassificationModel options NOT forwarded to pipeline
 * - Extra options forwarded via spread
 * - createClassifier exposed on classify
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mock the pipeline wrapper (which bridges CJS → ESM for @xenova/transformers)
// ─────────────────────────────────────────────────────────────────────────────
//
// `classify.js` no longer requires `@xenova/transformers` directly — it
// goes through `./pipeline.js`, the dynamic-import wrapper. So the right
// mock target here is the wrapper. The mock receives the same (task,
// modelId) args the wrapper would, dispatches by task, and returns the
// appropriate fake pipeline instance.

const MOCK_RESULT = {
  sequence: "Hello there",
  labels:   ["a greeting",     "a support request", "a technical question"],
  scores:   [0.92, 0.05, 0.03],
};

const mockClassifierPipeline = jest.fn();

jest.mock("../../src/xenova/pipeline", () =>
  jest.fn(async (task) => {
    if (task === "zero-shot-classification") return mockClassifierPipeline;
    throw new Error(`Unexpected pipeline task: ${task}`);
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = require("../../src/xenova/config");

let classify;

beforeAll(() => {
  classify = require("../../src/xenova/classify");
});

beforeEach(() => {
  jest.clearAllMocks();
  mockClassifierPipeline.mockResolvedValue(MOCK_RESULT);
});

// ─────────────────────────────────────────────────────────────────────────────
// classify — output shape
// ─────────────────────────────────────────────────────────────────────────────

describe("classify — output shape", () => {
  test("returns { labels, scores }", async () => {
    const result = await classify("Hello", ["a greeting", "a support request", "a technical question"], {
      classifier: mockClassifierPipeline,
    });
    expect(result).toHaveProperty("labels");
    expect(result).toHaveProperty("scores");
  });

  test("labels and scores are parallel arrays sorted descending by score", async () => {
    const result = await classify("Hello", ["a greeting", "a support request", "a technical question"], {
      classifier: mockClassifierPipeline,
    });
    expect(result.labels).toEqual(["a greeting", "a support request", "a technical question"]);
    expect(result.scores).toEqual([0.92, 0.05, 0.03]);
    expect(result.labels.length).toBe(result.scores.length);
  });

  test("does not include the pipeline's `sequence` field", async () => {
    const result = await classify("Hello", ["a greeting"], {
      classifier: mockClassifierPipeline,
    });
    expect(result).not.toHaveProperty("sequence");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classify — input coercion
// ─────────────────────────────────────────────────────────────────────────────

describe("classify — input coercion", () => {
  test("falsy text coerced to empty string", async () => {
    await classify(null, ["x", "y"], { classifier: mockClassifierPipeline });
    expect(mockClassifierPipeline.mock.calls[0][0]).toBe("");
  });

  test("undefined text coerced to empty string", async () => {
    await classify(undefined, ["x", "y"], { classifier: mockClassifierPipeline });
    expect(mockClassifierPipeline.mock.calls[0][0]).toBe("");
  });

  test("number text coerced (falsy 0 → empty string)", async () => {
    await classify(0, ["x", "y"], { classifier: mockClassifierPipeline });
    expect(mockClassifierPipeline.mock.calls[0][0]).toBe("");
  });

  test("string text passed through unchanged", async () => {
    await classify("hello there", ["greeting"], { classifier: mockClassifierPipeline });
    expect(mockClassifierPipeline.mock.calls[0][0]).toBe("hello there");
  });

  test("labels passed through unchanged", async () => {
    await classify("text", ["a", "b", "c"], { classifier: mockClassifierPipeline });
    expect(mockClassifierPipeline.mock.calls[0][1]).toEqual(["a", "b", "c"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classify — pipeline options forwarding
// ─────────────────────────────────────────────────────────────────────────────

describe("classify — pipeline options", () => {
  test("default hypothesisTemplate forwarded as hypothesis_template", async () => {
    await classify("text", ["x"], { classifier: mockClassifierPipeline });
    const opts = mockClassifierPipeline.mock.calls[0][2];
    expect(opts.hypothesis_template).toBe("This text is about {}");
  });

  test("custom hypothesisTemplate forwarded as hypothesis_template", async () => {
    await classify("text", ["x"], {
      classifier:         mockClassifierPipeline,
      hypothesisTemplate: "This example expresses {}",
    });
    const opts = mockClassifierPipeline.mock.calls[0][2];
    expect(opts.hypothesis_template).toBe("This example expresses {}");
  });

  test("default multiLabel:false forwarded as multi_label:false", async () => {
    await classify("text", ["x"], { classifier: mockClassifierPipeline });
    const opts = mockClassifierPipeline.mock.calls[0][2];
    expect(opts.multi_label).toBe(false);
  });

  test("multiLabel:true forwarded as multi_label:true", async () => {
    await classify("text", ["x"], { classifier: mockClassifierPipeline, multiLabel: true });
    const opts = mockClassifierPipeline.mock.calls[0][2];
    expect(opts.multi_label).toBe(true);
  });

  test("classifier not forwarded in pipeline options", async () => {
    await classify("text", ["x"], { classifier: mockClassifierPipeline });
    const opts = mockClassifierPipeline.mock.calls[0][2];
    expect(opts.classifier).toBeUndefined();
  });

  test("hypothesisTemplate not forwarded literally (only as hypothesis_template)", async () => {
    await classify("text", ["x"], { classifier: mockClassifierPipeline });
    const opts = mockClassifierPipeline.mock.calls[0][2];
    expect(opts.hypothesisTemplate).toBeUndefined();
  });

  test("multiLabel not forwarded literally (only as multi_label)", async () => {
    await classify("text", ["x"], { classifier: mockClassifierPipeline });
    const opts = mockClassifierPipeline.mock.calls[0][2];
    expect(opts.multiLabel).toBeUndefined();
  });

  test("zeroShotClassificationModel not forwarded to pipeline", async () => {
    await classify("text", ["x"], {
      classifier:                  mockClassifierPipeline,
      zeroShotClassificationModel: "some/model",
    });
    const opts = mockClassifierPipeline.mock.calls[0][2];
    expect(opts.zeroShotClassificationModel).toBeUndefined();
  });

  test("extra options forwarded via spread", async () => {
    await classify("text", ["x"], {
      classifier: mockClassifierPipeline,
      batch_size: 4,
    });
    const opts = mockClassifierPipeline.mock.calls[0][2];
    expect(opts.batch_size).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classify — lazy initialization
// ─────────────────────────────────────────────────────────────────────────────

describe("classify — lazy initialization", () => {
  test("initializes pipeline when no classifier provided", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshClassify = require("../../src/xenova/classify");
    mockClassifierPipeline.mockResolvedValue(MOCK_RESULT);
    await freshClassify("text", ["x", "y"]);
    expect(pipeline).toHaveBeenCalledWith(
      "zero-shot-classification",
      CONFIG.zeroShotClassificationModel,
      expect.anything()
    );
  });

  test("reuses singleton on second call", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshClassify = require("../../src/xenova/classify");
    mockClassifierPipeline.mockResolvedValue(MOCK_RESULT);
    await freshClassify("text 1", ["x"]);
    await freshClassify("text 2", ["y"]);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  test("provided classifier skips pipeline init", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshClassify = require("../../src/xenova/classify");
    await freshClassify("text", ["x"], { classifier: mockClassifierPipeline });
    expect(pipeline).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createClassifier
// ─────────────────────────────────────────────────────────────────────────────

describe("classify.createClassifier", () => {
  test("exposed on classify function", () => {
    expect(typeof classify.createClassifier).toBe("function");
  });

  test("calls pipeline with zero-shot-classification task and provided model", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshClassify = require("../../src/xenova/classify");
    await freshClassify.createClassifier("custom/nli-model");
    expect(pipeline).toHaveBeenCalledWith("zero-shot-classification", "custom/nli-model", expect.anything());
  });

  test("falls back to CONFIG model when none provided", async () => {
    jest.resetModules();
    const pipeline = require("../../src/xenova/pipeline");
    const freshClassify = require("../../src/xenova/classify");
    await freshClassify.createClassifier();
    expect(pipeline).toHaveBeenCalledWith(
      "zero-shot-classification",
      CONFIG.zeroShotClassificationModel,
      expect.anything()
    );
  });

  test("returns the pipeline instance", async () => {
    const instance = await classify.createClassifier("any/model");
    expect(instance).toBe(mockClassifierPipeline);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("classify — module export", () => {
  test("module is frozen", () => {
    expect(Object.isFrozen(classify)).toBe(true);
  });

  test("classify.classify references same function", () => {
    expect(classify.classify).toBe(classify);
  });
});