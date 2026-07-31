"use strict";

// Mock Document before requiring anything that uses it.
jest.mock("../../../../src/VectorStore/Document", () => {
  const mockToBuffer = jest.fn(() => Buffer.from("mock-vect"));
  const mockFromSpec = jest.fn(spec => ({ spec, toBuffer: mockToBuffer }));
  return {
    fromSpec: mockFromSpec,
    __mockToBuffer: mockToBuffer,
    __mockFromSpec: mockFromSpec,
  };
});

const Document = require("../../../../src/VectorStore/Document");
const run = require("../../../../src/actions/generate/binary");

const { __mockFromSpec, __mockToBuffer } = Document;

beforeEach(() => {
  __mockFromSpec.mockClear();
  __mockToBuffer.mockClear();
  __mockToBuffer.mockImplementation(() => Buffer.from("mock-vect"));
  __mockFromSpec.mockImplementation(spec => ({ spec, toBuffer: __mockToBuffer }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const makeMockVectorize = () => jest.fn(async (text) => new Float32Array([text.length]));

const sampleRowsJson = JSON.stringify([
  { question: "Q1", anchors: ["A1"], variants: ["V1"] },
]);

const SAMPLE_MD = `# Top Heading

A paragraph of body content here.

## Sub Heading

Another paragraph under the subheading.`;

const baseInput = (overrides = {}) => ({
  markdown:   SAMPLE_MD,
  documentId: "test|doc",
  vecDim:     1,
  vectorize:  makeMockVectorize(),
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — no augmentation
// ─────────────────────────────────────────────────────────────────────────────

describe("run — happy path (no augmentation)", () => {
  test("returns a Buffer when run without prompt/runLLM", async () => {
    const result = await run(baseInput());
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  test("Document.fromSpec called with correct documentId and vecDim", async () => {
    await run(baseInput({
      documentId: "biocides|water",
      vecDim: 384,
    }));
    const spec = __mockFromSpec.mock.calls[0][0];
    expect(spec.documentId).toBe("biocides|water");
    expect(spec.vecDim).toBe(384);
  });

  test("Document.fromSpec called with multiple sections", async () => {
    await run(baseInput());
    const spec = __mockFromSpec.mock.calls[0][0];
    expect(Array.isArray(spec.sections)).toBe(true);
    expect(spec.sections.length).toBeGreaterThan(0);
  });

  test("each section has resolved Float32Array vectors", async () => {
    await run(baseInput());
    const spec = __mockFromSpec.mock.calls[0][0];
    for (const s of spec.sections) {
      for (const v of s.vectors) {
        expect(v).toBeInstanceOf(Float32Array);
      }
    }
  });

  test("vectorize was called for breadcrumb + body chunks (no LLM augmentation)", async () => {
    const vectorize = makeMockVectorize();
    await run(baseInput({ vectorize }));
    expect(vectorize.mock.calls.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — with augmentation
// ─────────────────────────────────────────────────────────────────────────────

describe("run — happy path (with augmentation)", () => {
  test("Document.fromSpec receives extra vectors from LLM augmentation", async () => {
    // First run: no augmentation
    const vectorize1 = makeMockVectorize();
    await run(baseInput({ vectorize: vectorize1 }));
    const callsWithoutAug = vectorize1.mock.calls.length;

    // Second run: with augmentation
    const vectorize2 = makeMockVectorize();
    const runLLM = jest.fn(async () => sampleRowsJson);
    await run(baseInput({
      vectorize: vectorize2,
      runLLM,
      prompt:    "AUGMENT PROMPT",
      llmConfig: {},
    }));
    const callsWithAug = vectorize2.mock.calls.length;

    expect(callsWithAug).toBeGreaterThan(callsWithoutAug);
  });

  test("calls runLLM once per section", async () => {
    const runLLM = jest.fn(async () => sampleRowsJson);
    await run(baseInput({
      runLLM,
      prompt:    "AUGMENT PROMPT",
      llmConfig: {},
    }));
    const spec = __mockFromSpec.mock.calls[0][0];
    expect(runLLM).toHaveBeenCalledTimes(spec.sections.length);
  });

  test("LLM strings passed to vectorize", async () => {
    const vectorize = makeMockVectorize();
    const runLLM = jest.fn(async () => sampleRowsJson);
    await run(baseInput({
      vectorize,
      runLLM,
      prompt: "P",
      llmConfig: {},
    }));
    const calls = vectorize.mock.calls.map(c => c[0]);
    expect(calls).toContain("Q1");
    expect(calls).toContain("A1");
    expect(calls).toContain("V1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Augmentation skipped when prompt or runLLM missing
// ─────────────────────────────────────────────────────────────────────────────

describe("run — augmentation skipped conditions", () => {
  test("no prompt → augmentation skipped, runLLM never called", async () => {
    const runLLM = jest.fn(async () => sampleRowsJson);
    await run(baseInput({ runLLM, llmConfig: {} }));
    expect(runLLM).not.toHaveBeenCalled();
  });

  test("no runLLM → augmentation skipped", async () => {
    // Doesn't throw despite prompt being provided.
    const result = await run(baseInput({ prompt: "P", llmConfig: {} }));
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  test("both missing → augmentation skipped", async () => {
    const result = await run(baseInput());
    expect(Buffer.isBuffer(result)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// onSection callback
// ─────────────────────────────────────────────────────────────────────────────

describe("run — onSection callback", () => {
  test("fires per section in extract stage", async () => {
    const onSection = jest.fn();
    await run(baseInput({ onSection }));
    expect(onSection).toHaveBeenCalled();
  });

  test("callback receives index and info shape", async () => {
    const onSection = jest.fn();
    await run(baseInput({ onSection }));
    const [index, info] = onSection.mock.calls[0];
    expect(typeof index).toBe("number");
    expect(info).toHaveProperty("wordCount");
    expect(info).toHaveProperty("bucket");
    expect(info).toHaveProperty("bodyChunks");
    expect(info).toHaveProperty("range");
  });

  test("no callback provided: pipeline runs normally", async () => {
    await expect(run(baseInput())).resolves.toBeInstanceOf(Buffer);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unified onError callback
// ─────────────────────────────────────────────────────────────────────────────

describe("run — unified onError callback", () => {
  test("fires on augment LLM failure with stage='augment' and sectionIndex", async () => {
    const runLLM = jest.fn(async () => "not json garbage");
    const onError = jest.fn();
    await run(baseInput({
      runLLM,
      prompt: "P",
      llmConfig: {},
      maxRetries: 0,
      onError,
    }));
    expect(onError).toHaveBeenCalled();
    const args = onError.mock.calls[0][0];
    expect(args.stage).toBe("augment");
    expect(typeof args.sectionIndex).toBe("number");
    expect(args.cause).toBeInstanceOf(Error);
  });

  test("fires on encode vector failure with stage='encode'", async () => {
    // Make vectorize reject for one specific text to trigger encode-stage failure.
    const vectorize = jest.fn(async (text) => {
      if (text === "FAIL_ME") throw new Error("vector hiccup");
      return new Float32Array([text.length]);
    });
    // We need a section whose body content includes "FAIL_ME" (or breadcrumb).
    // The extract stage will call vectorize on breadcrumbs + body chunks.
    // Compose a markdown where a section body contains exactly "FAIL_ME".
    const md = "# H\n\nFAIL_ME";
    const onError = jest.fn();
    await run({
      markdown: md,
      documentId: "doc",
      vecDim: 1,
      vectorize,
      onError,
    });
    // At least one onError call with stage="encode"
    const encodeErrors = onError.mock.calls.filter(c => c[0].stage === "encode");
    expect(encodeErrors.length).toBeGreaterThan(0);
  });

  test("no callback: soft errors are silently tolerated", async () => {
    const runLLM = jest.fn(async () => "not json");
    const result = await run(baseInput({
      runLLM, prompt: "P", llmConfig: {}, maxRetries: 0,
    }));
    expect(Buffer.isBuffer(result)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error wrapping per stage
// ─────────────────────────────────────────────────────────────────────────────

describe("run — error wrapping", () => {
  test("extract failure: error has stage='extract', documentId, cause", async () => {
    try {
      await run(baseInput({ markdown: "" }));
      throw new Error("expected to throw");
    } catch (err) {
      expect(err.stage).toBe("extract");
      expect(err.documentId).toBe("test|doc");
      expect(err.cause).toBeInstanceOf(Error);
      expect(err.message).toMatch(/extract/);
    }
  });

  test("encode failure: error has stage='encode'", async () => {
    __mockFromSpec.mockImplementationOnce(() => {
      throw new Error("bad spec");
    });
    try {
      await run(baseInput());
      throw new Error("expected to throw");
    } catch (err) {
      expect(err.stage).toBe("encode");
      expect(err.documentId).toBe("test|doc");
      expect(err.cause.message).toBe("bad spec");
    }
  });

  test("extract failure: missing vectorize", async () => {
    try {
      await run({ markdown: "# X\n\nBody.", documentId: "d", vecDim: 1 });
    } catch (err) {
      expect(err.stage).toBe("extract");
      expect(err.cause.message).toMatch(/vectorize/);
    }
  });

  test("error message includes stage and documentId", async () => {
    __mockFromSpec.mockImplementationOnce(() => {
      throw new Error("test");
    });
    try {
      await run(baseInput({ documentId: "my-doc-id" }));
    } catch (err) {
      expect(err.message).toContain("encode");
      expect(err.message).toContain("my-doc-id");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run.batch
// ─────────────────────────────────────────────────────────────────────────────

describe("run.batch", () => {
  test("processes multiple inputs in parallel", async () => {
    const results = await run.batch([
      baseInput({ documentId: "a" }),
      baseInput({ documentId: "b" }),
      baseInput({ documentId: "c" }),
    ]);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
      expect(Buffer.isBuffer(r.value)).toBe(true);
    }
  });

  test("captures per-file failures without aborting siblings", async () => {
    const inputs = [
      baseInput({ documentId: "ok-1" }),
      baseInput({ documentId: "bad", markdown: "" }),  // will fail at extract
      baseInput({ documentId: "ok-2" }),
    ];
    const results = await run.batch(inputs);
    expect(results).toHaveLength(3);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(results[2].status).toBe("fulfilled");
  });

  test("rejected entries carry the structured error", async () => {
    const inputs = [baseInput({ documentId: "bad", markdown: "" })];
    const results = await run.batch(inputs);
    expect(results[0].status).toBe("rejected");
    expect(results[0].reason.stage).toBe("extract");
    expect(results[0].reason.documentId).toBe("bad");
  });

  test("empty input array returns empty result array", async () => {
    const results = await run.batch([]);
    expect(results).toEqual([]);
  });

  test("throws when inputs is not an array", async () => {
    await expect(run.batch("not array")).rejects.toThrow(/inputs must be an array/);
  });

  test("throws when no argument", async () => {
    await expect(run.batch()).rejects.toThrow(/inputs must be an array/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wrapError helper
// ─────────────────────────────────────────────────────────────────────────────

describe("wrapError", () => {
  test("attaches stage, documentId, cause", () => {
    const cause = new Error("original");
    const err = run.wrapError({ stage: "augment", documentId: "x", cause });
    expect(err.stage).toBe("augment");
    expect(err.documentId).toBe("x");
    expect(err.cause).toBe(cause);
  });

  test("copies attempts and errors from cause when present", () => {
    const cause = new Error("retry-exhausted");
    cause.attempts = 3;
    cause.errors = ["attempt 1: bad", "attempt 2: bad", "attempt 3: bad"];
    const err = run.wrapError({ stage: "augment", documentId: "x", cause });
    expect(err.attempts).toBe(3);
    expect(err.errors).toHaveLength(3);
  });

  test("message includes stage, documentId, and cause message", () => {
    const cause = new Error("underlying");
    const err = run.wrapError({ stage: "extract", documentId: "doc-1", cause });
    expect(err.message).toContain("extract");
    expect(err.message).toContain("doc-1");
    expect(err.message).toContain("underlying");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────────────

describe("run — module export", () => {
  test("module is the run function", () => {
    expect(typeof run).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(run)).toBe(true);
  });

  test("self-referential property", () => {
    expect(run.run).toBe(run);
  });

  test("has batch method", () => {
    expect(typeof run.batch).toBe("function");
  });

  test("has wrapError helper", () => {
    expect(typeof run.wrapError).toBe("function");
  });
});
