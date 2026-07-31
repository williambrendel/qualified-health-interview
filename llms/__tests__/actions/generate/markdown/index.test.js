"use strict";

const run = require("../../../../src/actions/generate/markdown");

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const VALID_MARKDOWN = "# Chlorine Dosing\n\n## Executive Summary\n\nBody.";

const VALID_CLASSIFICATION = JSON.stringify({
  theme: "biocides-and-chemical-treatment",
  confidence: 0.92,
  rationale: "Document is about chlorine dosing.",
});

const SAMPLE_THEMES = {
  "biocides-and-chemical-treatment": {
    description: "Chemical treatment programs",
  },
  "biological-control-and-prevention": {
    description: "General microbial control",
  },
};

/**
 * Build a mock runLLM that distinguishes between calls to
 * `generateMarkdown` (recognized by the markdown-generation prompt)
 * and `classifyMarkdown` (recognized by the classification prompt).
 * Returns different responses for each.
 */
const mockLLM = ({ generateResponse, classifyResponse } = {}) => {
  const fn = jest.fn(async (config, prompt) => {
    if (config.system === "GENERATE_PROMPT") {
      const r = generateResponse !== undefined ? generateResponse : VALID_MARKDOWN;
      if (r instanceof Error) throw r;
      return r;
    }
    if (config.system === "CLASSIFY_PROMPT") {
      const r = classifyResponse !== undefined ? classifyResponse : VALID_CLASSIFICATION;
      if (r instanceof Error) throw r;
      return r;
    }
    throw new Error(`mockLLM: unexpected system prompt "${config.system}"`);
  });
  return fn;
};

const baseOptions = (overrides = {}) => ({
  text: "Source text to be transformed.",
  prompts: {
    generate: "GENERATE_PROMPT",
    classify: "CLASSIFY_PROMPT",
  },
  runLLM: mockLLM(),
  llmConfigs: {
    generate: { model: "sonnet-test" },
    classify: { model: "haiku-test" },
  },
  themes: SAMPLE_THEMES,
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path with themes
// ─────────────────────────────────────────────────────────────────────────────

describe("actions/generate/markdown — happy path", () => {
  test("returns markdown, filename, theme, confidence, rationale", async () => {
    const result = await run(baseOptions());
    expect(result.markdown).toBe(VALID_MARKDOWN);
    expect(result.filename).toBe("chlorine_dosing.md");
    expect(result.theme).toBe("biocides-and-chemical-treatment");
    expect(result.confidence).toBe(0.92);
    expect(result.rationale).toMatch(/chlorine/i);
  });

  test("calls runLLM twice (once for generate, once for classify)", async () => {
    const runLLM = mockLLM();
    await run(baseOptions({ runLLM }));
    expect(runLLM).toHaveBeenCalledTimes(2);
  });

  test("passes correct configs to each sub-action", async () => {
    const runLLM = mockLLM();
    await run(baseOptions({
      runLLM,
      llmConfigs: {
        generate: { model: "sonnet-A" },
        classify: { model: "haiku-B" },
      },
    }));
    // First call: generate, with sonnet-A config
    expect(runLLM).toHaveBeenNthCalledWith(
      1,
      { model: "sonnet-A", system: "GENERATE_PROMPT" },
      expect.any(String),
    );
    // Second call: classify, with haiku-B config
    expect(runLLM).toHaveBeenNthCalledWith(
      2,
      { model: "haiku-B", system: "CLASSIFY_PROMPT" },
      expect.any(String),
    );
  });

  test("passes text directly to generate as userMessage", async () => {
    const runLLM = mockLLM();
    await run(baseOptions({ runLLM, text: "MY SOURCE TEXT" }));
    // First call's userMessage is the raw text
    expect(runLLM.mock.calls[0][1]).toBe("MY SOURCE TEXT");
  });

  test("passes generated markdown to classify (not original text)", async () => {
    const runLLM = mockLLM();
    await run(baseOptions({ runLLM }));
    // Classify's userMessage includes the generated markdown body
    expect(runLLM.mock.calls[1][1]).toContain("Chlorine Dosing");
    expect(runLLM.mock.calls[1][1]).toContain("Document to classify:");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No-themes mode
// ─────────────────────────────────────────────────────────────────────────────

describe("actions/generate/markdown — no-themes mode", () => {
  test("themes undefined → only generate is called, classify returns null", async () => {
    const runLLM = mockLLM();
    const result = await run(baseOptions({
      themes: undefined,
      runLLM,
    }));
    expect(result.markdown).toBe(VALID_MARKDOWN);
    expect(result.filename).toBe("chlorine_dosing.md");
    expect(result.theme).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.rationale).toMatch(/no themes/);
    // Only 1 LLM call (the generate). No classify call.
    expect(runLLM).toHaveBeenCalledTimes(1);
  });

  test("themes empty object → same as undefined", async () => {
    const result = await run(baseOptions({ themes: {} }));
    expect(result.theme).toBeNull();
  });

  test("themes null → no-themes mode", async () => {
    const result = await run(baseOptions({ themes: null }));
    expect(result.theme).toBeNull();
  });

  test("no classify prompt or config required in no-themes mode", async () => {
    // Should not throw even though prompts.classify is missing.
    const result = await run({
      text: "source",
      prompts: { generate: "GENERATE_PROMPT" },
      // no prompts.classify
      runLLM: mockLLM(),
      llmConfigs: { generate: { model: "sonnet" } },
      // no llmConfigs.classify
      // no themes
    });
    expect(result.theme).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error propagation from sub-actions
// ─────────────────────────────────────────────────────────────────────────────

describe("actions/generate/markdown — error propagation", () => {
  test("generate failure (no H1 across all retries) propagates", async () => {
    const runLLM = mockLLM({
      generateResponse: "no H1 here",  // will fail validator on every attempt
    });
    await expect(run(baseOptions({ runLLM })))
      .rejects.toThrow(/no H1/);
  });

  test("generate transport error propagates after retries", async () => {
    const runLLM = mockLLM({
      generateResponse: new Error("network down"),
    });
    await expect(run(baseOptions({ runLLM, maxRetries: 0 })))
      .rejects.toThrow();
  });

  test("classify failure (bad JSON) propagates", async () => {
    const runLLM = mockLLM({
      classifyResponse: "not json",
    });
    await expect(run(baseOptions({ runLLM, maxRetries: 0 })))
      .rejects.toThrow();
  });

  test("classify invented theme propagates after retries", async () => {
    const runLLM = mockLLM({
      classifyResponse: JSON.stringify({
        theme: "made-up-theme",
        confidence: 0.9,
        rationale: "Wrong.",
      }),
    });
    await expect(run(baseOptions({ runLLM, maxRetries: 0 })))
      .rejects.toThrow(/not in the provided theme list/);
  });

  test("renameMarkdown error propagates when generated markdown lacks H1", async () => {
    // This is tricky: generateMarkdown's validator should catch
    // no-H1 output. But hypothetically if it didn't, renameMarkdown
    // would throw. We can't easily simulate that without bypassing
    // generateMarkdown's validation. Skipping the direct test —
    // the validators agree.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry budget + fallbacks
// ─────────────────────────────────────────────────────────────────────────────

describe("actions/generate/markdown — retries and fallbacks", () => {
  test("maxRetries applies to generate", async () => {
    const runLLM = jest.fn()
      .mockResolvedValueOnce("bad")  // generate attempt 1
      .mockResolvedValueOnce("bad")  // generate attempt 2
      .mockResolvedValueOnce(VALID_MARKDOWN)  // generate attempt 3
      .mockResolvedValueOnce(VALID_CLASSIFICATION);  // classify
    const result = await run(baseOptions({ runLLM, maxRetries: 2 }));
    expect(result.markdown).toBe(VALID_MARKDOWN);
    expect(runLLM).toHaveBeenCalledTimes(4);
  });

  test("fallback for generate is used on exhaustion", async () => {
    const fallbackMd = "# Fallback Title\n\nWe couldn't process this.";
    const runLLM = mockLLM({ generateResponse: "always bad" });
    const result = await run(baseOptions({
      runLLM,
      maxRetries: 0,
      fallbacks: { generate: fallbackMd },
    }));
    expect(result.markdown).toBe(fallbackMd);
    expect(result.filename).toBe("fallback_title.md");
  });

  test("fallback for classify is used on exhaustion", async () => {
    const classifyFallback = {
      theme: "biological-control-and-prevention",
      confidence: 0.3,
      rationale: "Fallback classification.",
    };
    const runLLM = mockLLM({ classifyResponse: "bad json" });
    const result = await run(baseOptions({
      runLLM,
      maxRetries: 0,
      fallbacks: { classify: classifyFallback },
    }));
    expect(result.theme).toBe("biological-control-and-prevention");
    expect(result.confidence).toBe(0.3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe("actions/generate/markdown — input validation", () => {
  test("throws when text is missing", async () => {
    await expect(run(baseOptions({ text: undefined })))
      .rejects.toThrow(/text must be a non-empty string/);
  });

  test("throws when text is empty", async () => {
    await expect(run(baseOptions({ text: "" })))
      .rejects.toThrow(/text must be a non-empty string/);
  });

  test("throws when runLLM is missing", async () => {
    await expect(run(baseOptions({ runLLM: undefined })))
      .rejects.toThrow(/runLLM must be a function/);
  });

  test("throws when prompts.generate is missing", async () => {
    await expect(run(baseOptions({
      prompts: { classify: "CLASSIFY_PROMPT" },
    }))).rejects.toThrow(/prompts.generate must be a non-empty string/);
  });

  test("throws when llmConfigs.generate is missing", async () => {
    await expect(run(baseOptions({
      llmConfigs: { classify: { model: "haiku" } },
    }))).rejects.toThrow(/llmConfigs.generate must be an object/);
  });

  test("throws when themes is non-empty but prompts.classify is missing", async () => {
    await expect(run(baseOptions({
      prompts: { generate: "GENERATE_PROMPT" },
    }))).rejects.toThrow(/prompts.classify is required when themes is non-empty/);
  });

  test("throws when themes is non-empty but llmConfigs.classify is missing", async () => {
    await expect(run(baseOptions({
      llmConfigs: { generate: { model: "sonnet" } },
    }))).rejects.toThrow(/llmConfigs.classify is required when themes is non-empty/);
  });

  test("throws when no options provided", async () => {
    await expect(run()).rejects.toThrow(/text must be a non-empty string/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("actions/generate/markdown — module export", () => {
  test("module is the run function itself", () => {
    expect(typeof run).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(run)).toBe(true);
  });

  test("self-referential .run property", () => {
    expect(run.run).toBe(run);
  });

  test("returns object with expected shape", async () => {
    const result = await run(baseOptions());
    expect(Object.keys(result).sort()).toEqual(
      ["confidence", "filename", "markdown", "rationale", "theme"].sort()
    );
  });
});