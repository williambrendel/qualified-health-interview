"use strict";

const generateMarkdown = require("../../../../src/actions/generate/markdown/generateMarkdown");
const {
  validateMarkdown,
  stripCodeFences,
} = generateMarkdown;

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const mockRunLLM = (...responses) => {
  let call = 0;
  const fn = jest.fn(async (config, prompt) => {
    const idx = Math.min(call, responses.length - 1);
    const r = responses[idx];
    call++;
    if (r instanceof Error) throw r;
    return r;
  });
  fn.callCount = () => call;
  return fn;
};

const baseOptions = (overrides = {}) => ({
  text:      "Source text to be transformed into markdown",
  prompt:    "GENERATE MARKDOWN PROMPT",
  runLLM:    mockRunLLM("# A Title\n\n## Executive Summary\nContent."),
  llmConfig: { model: "test-model" },
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("generateMarkdown — happy path", () => {
  test("returns LLM's markdown on successful first attempt", async () => {
    const md = "# How Biofilm Resists Treatment\n\n## Executive Summary\n\nBiofilms have layers.";
    const result = await generateMarkdown(baseOptions({
      runLLM: mockRunLLM(md),
    }));
    expect(result).toBe(md);
  });

  test("passes config (with system) and text positionally to runLLM", async () => {
    const runLLM = mockRunLLM("# OK\n\nbody");
    await generateMarkdown(baseOptions({
      runLLM,
      text: "user text",
      prompt: "sys prompt",
      llmConfig: { model: "m" },
    }));
    expect(runLLM).toHaveBeenCalledWith(
      { model: "m", system: "sys prompt" },
      "user text",
    );
  });

  test("calls runLLM exactly once on first-success", async () => {
    const runLLM = mockRunLLM("# OK\n\nbody");
    await generateMarkdown(baseOptions({ runLLM }));
    expect(runLLM.callCount()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry on bad content
// ─────────────────────────────────────────────────────────────────────────────

describe("generateMarkdown — retry on validator failure", () => {
  test("retries when first response has no H1", async () => {
    const runLLM = mockRunLLM(
      "Just some paragraph without a heading.",
      "# Good Title\n\nBody.",
    );
    const result = await generateMarkdown(baseOptions({ runLLM }));
    expect(result).toBe("# Good Title\n\nBody.");
    expect(runLLM.callCount()).toBe(2);
  });

  test("retries when first response is empty", async () => {
    const runLLM = mockRunLLM("", "# OK\n\nbody");
    const result = await generateMarkdown(baseOptions({ runLLM }));
    expect(result).toBe("# OK\n\nbody");
    expect(runLLM.callCount()).toBe(2);
  });

  test("retries when first response is only whitespace", async () => {
    // Note: stripCodeFences trims, so "   " becomes "" which validator rejects.
    const runLLM = mockRunLLM("   \n\n   ", "# OK\n\nbody");
    const result = await generateMarkdown(baseOptions({ runLLM }));
    expect(result).toBe("# OK\n\nbody");
  });

  test("retries up to maxRetries times", async () => {
    const runLLM = mockRunLLM("bad", "bad", "# good\n\nbody");
    const result = await generateMarkdown(baseOptions({ runLLM, maxRetries: 2 }));
    expect(result).toBe("# good\n\nbody");
    expect(runLLM.callCount()).toBe(3);
  });

  test("throws when retries are exhausted", async () => {
    const runLLM = mockRunLLM("bad", "bad", "bad");
    await expect(generateMarkdown(baseOptions({ runLLM, maxRetries: 2 })))
      .rejects.toThrow(/no H1 heading/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry on transport errors
// ─────────────────────────────────────────────────────────────────────────────

describe("generateMarkdown — retry on transport error", () => {
  test("retries when runLLM throws", async () => {
    const runLLM = mockRunLLM(new Error("network blip"), "# OK\n\nbody");
    const result = await generateMarkdown(baseOptions({ runLLM }));
    expect(result).toBe("# OK\n\nbody");
    expect(runLLM.callCount()).toBe(2);
  });

  test("error metadata included on exhaustion", async () => {
    const runLLM = mockRunLLM(new Error("a"), new Error("b"), new Error("c"));
    try {
      await generateMarkdown(baseOptions({ runLLM, maxRetries: 2 }));
    } catch (err) {
      expect(err.attempts).toBe(3);
      expect(Array.isArray(err.errors)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Code-fence stripping
// ─────────────────────────────────────────────────────────────────────────────

describe("generateMarkdown — code-fence stripping", () => {
  test("strips ```markdown fences", async () => {
    const wrapped = "```markdown\n# Title\n\nbody\n```";
    const result = await generateMarkdown(baseOptions({
      runLLM: mockRunLLM(wrapped),
    }));
    expect(result).toBe("# Title\n\nbody");
  });

  test("strips ```md fences", async () => {
    const wrapped = "```md\n# Title\n\nbody\n```";
    const result = await generateMarkdown(baseOptions({
      runLLM: mockRunLLM(wrapped),
    }));
    expect(result).toBe("# Title\n\nbody");
  });

  test("strips plain ``` fences", async () => {
    const wrapped = "```\n# Title\n\nbody\n```";
    const result = await generateMarkdown(baseOptions({
      runLLM: mockRunLLM(wrapped),
    }));
    expect(result).toBe("# Title\n\nbody");
  });

  test("preserves unfenced output", async () => {
    const unfenced = "# Title\n\nbody";
    const result = await generateMarkdown(baseOptions({
      runLLM: mockRunLLM(unfenced),
    }));
    expect(result).toBe("# Title\n\nbody");
  });

  test("preserves code fences inside the content", async () => {
    // Only the outer wrap is stripped; inner code blocks stay.
    const withInner = "```markdown\n# Title\n\n```python\nprint(1)\n```\n\nMore.\n```";
    const result = await generateMarkdown(baseOptions({
      runLLM: mockRunLLM(withInner),
    }));
    // After stripping outer fences, the inner python block remains.
    expect(result).toContain("```python");
    expect(result).toContain("print(1)");
    expect(result.startsWith("# Title")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fallback
// ─────────────────────────────────────────────────────────────────────────────

describe("generateMarkdown — fallback", () => {
  test("returns fallback on exhaustion", async () => {
    const runLLM = mockRunLLM("bad", "bad", "bad");
    const result = await generateMarkdown(baseOptions({
      runLLM, maxRetries: 2,
      fallback: "# Fallback Title\n\nWe couldn't process this.",
    }));
    expect(result).toBe("# Fallback Title\n\nWe couldn't process this.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe("generateMarkdown — input validation", () => {
  test("throws when text is missing", async () => {
    await expect(generateMarkdown(baseOptions({ text: undefined })))
      .rejects.toThrow(/text must be a non-empty string/);
  });

  test("throws when text is empty string", async () => {
    await expect(generateMarkdown(baseOptions({ text: "" })))
      .rejects.toThrow(/text must be a non-empty string/);
  });

  test("throws when prompt is missing", async () => {
    await expect(generateMarkdown(baseOptions({ prompt: undefined })))
      .rejects.toThrow(/prompt must be a non-empty string/);
  });

  test("throws when prompt is empty", async () => {
    await expect(generateMarkdown(baseOptions({ prompt: "" })))
      .rejects.toThrow(/prompt must be a non-empty string/);
  });

  test("throws when no options provided", async () => {
    await expect(generateMarkdown()).rejects.toThrow(/text must be a non-empty string/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("validateMarkdown", () => {
  test("valid markdown with H1 passes", () => {
    expect(validateMarkdown("# Title\n\nBody")).toEqual({ valid: true });
  });

  test("empty string fails", () => {
    const r = validateMarkdown("");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/empty/);
  });

  test("non-string fails", () => {
    const r = validateMarkdown(42);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/empty or non-string/);
  });

  test("string without H1 fails", () => {
    const r = validateMarkdown("Just a paragraph.");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/no H1/);
  });

  test("H2 doesn't count as H1", () => {
    const r = validateMarkdown("## Only Subheading\n\nBody");
    expect(r.valid).toBe(false);
  });

  test("H1 anywhere in document passes", () => {
    // Leading whitespace/blank lines are OK as long as H1 exists somewhere.
    expect(validateMarkdown("\n\n# Title\n\nBody")).toEqual({ valid: true });
  });
});

describe("stripCodeFences", () => {
  test("strips ```markdown wrapper", () => {
    expect(stripCodeFences("```markdown\n# X\n\nbody\n```")).toBe("# X\n\nbody");
  });

  test("strips ```md wrapper", () => {
    expect(stripCodeFences("```md\n# X\n```")).toBe("# X");
  });

  test("strips bare ``` wrapper", () => {
    expect(stripCodeFences("```\n# X\n```")).toBe("# X");
  });

  test("leaves unfenced content unchanged (after trim)", () => {
    expect(stripCodeFences("# X\n\nbody")).toBe("# X\n\nbody");
  });

  test("trims leading/trailing whitespace", () => {
    expect(stripCodeFences("   \n# X\n\nbody\n   ")).toBe("# X\n\nbody");
  });

  test("does not strip mid-content fences", () => {
    // No opening fence on first line → don't strip anything.
    const input = "# Title\n\n```python\nprint(1)\n```\n\nmore";
    expect(stripCodeFences(input)).toBe(input);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────────────

describe("generateMarkdown — module export", () => {
  test("module is the function", () => {
    expect(typeof generateMarkdown).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(generateMarkdown)).toBe(true);
  });

  test("self-referential property", () => {
    expect(generateMarkdown.generateMarkdown).toBe(generateMarkdown);
  });

  test("exposes validateMarkdown and stripCodeFences", () => {
    expect(typeof generateMarkdown.validateMarkdown).toBe("function");
    expect(typeof generateMarkdown.stripCodeFences).toBe("function");
  });
});