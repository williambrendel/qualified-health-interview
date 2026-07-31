"use strict";

const classifyMarkdown = require("../../../../src/actions/generate/markdown/classifyMarkdown");
const {
  stripJsonFences,
  parseJsonSafely,
  buildValidator,
  formatUserMessage,
} = classifyMarkdown;

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const mockRunLLM = (...responses) => {
  let call = 0;
  const fn = jest.fn(async () => {
    const idx = Math.min(call, responses.length - 1);
    const r = responses[idx];
    call++;
    if (r instanceof Error) throw r;
    return r;
  });
  fn.callCount = () => call;
  return fn;
};

const SAMPLE_THEMES = {
  "biocides-and-chemical-treatment": {
    description: "Chemical treatment programs and biocide selection",
    examples: ["Chlorine dosing", "Biocide rotation"],
  },
  "biological-control-and-prevention": {
    description: "Microbial growth control, biofilms, algae",
    examples: ["Biofilm prevention", "Algae control"],
  },
  "legionella-specific-control-and-prevention": {
    description: "Legionella-specific risk management and compliance",
    examples: ["ASHRAE 188 plans", "Legionella monitoring"],
  },
};

const validResponse = JSON.stringify({
  theme: "biocides-and-chemical-treatment",
  confidence: 0.92,
  rationale: "Document discusses chlorine dosing strategies for cooling towers.",
});

const baseOptions = (overrides = {}) => ({
  content:   "# Chlorine Dosing for Cooling Towers\n\n## Executive Summary\n\nContent.",
  themes:    SAMPLE_THEMES,
  prompt:    "CLASSIFY PROMPT",
  runLLM:    mockRunLLM(validResponse),
  llmConfig: { model: "test-model" },
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// No-themes mode
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyMarkdown — no-themes mode", () => {
  test("returns theme=null when themes is undefined", async () => {
    const result = await classifyMarkdown(baseOptions({ themes: undefined }));
    expect(result.theme).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.rationale).toMatch(/no themes provided/);
  });

  test("returns theme=null when themes is empty object", async () => {
    const result = await classifyMarkdown(baseOptions({ themes: {} }));
    expect(result.theme).toBeNull();
  });

  test("returns theme=null when themes is null", async () => {
    const result = await classifyMarkdown(baseOptions({ themes: null }));
    expect(result.theme).toBeNull();
  });

  test("does NOT call LLM in no-themes mode", async () => {
    const runLLM = mockRunLLM(validResponse);
    await classifyMarkdown(baseOptions({ themes: undefined, runLLM }));
    expect(runLLM).not.toHaveBeenCalled();
  });

  test("does not require prompt in no-themes mode", async () => {
    // prompt is required only when themes is non-empty
    const result = await classifyMarkdown(baseOptions({
      themes: undefined, prompt: undefined,
    }));
    expect(result.theme).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — themes provided
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyMarkdown — happy path with themes", () => {
  test("returns parsed classification on first success", async () => {
    const result = await classifyMarkdown(baseOptions());
    expect(result.theme).toBe("biocides-and-chemical-treatment");
    expect(result.confidence).toBe(0.92);
    expect(result.rationale).toMatch(/chlorine dosing/i);
  });

  test("includes themes + content in the user message to LLM", async () => {
    const runLLM = mockRunLLM(validResponse);
    await classifyMarkdown(baseOptions({ runLLM }));
    const [config, userMsg] = runLLM.mock.calls[0];
    expect(userMsg).toContain("Available themes:");
    expect(userMsg).toContain("biocides-and-chemical-treatment");
    expect(userMsg).toContain("Chemical treatment programs");
    expect(userMsg).toContain("Document to classify:");
    expect(userMsg).toContain("Chlorine Dosing");
  });

  test("passes config (with system prompt) and user message to LLM", async () => {
    const runLLM = mockRunLLM(validResponse);
    await classifyMarkdown(baseOptions({
      runLLM,
      prompt: "MY PROMPT",
      llmConfig: { model: "claude-haiku" },
    }));
    expect(runLLM).toHaveBeenCalledWith(
      { model: "claude-haiku", system: "MY PROMPT" },
      expect.stringContaining("Available themes"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON parsing + fence stripping
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyMarkdown — JSON handling", () => {
  test("parses response wrapped in ```json fences", async () => {
    const wrapped = "```json\n" + validResponse + "\n```";
    const result = await classifyMarkdown(baseOptions({
      runLLM: mockRunLLM(wrapped),
    }));
    expect(result.theme).toBe("biocides-and-chemical-treatment");
  });

  test("parses response wrapped in plain ``` fences", async () => {
    const wrapped = "```\n" + validResponse + "\n```";
    const result = await classifyMarkdown(baseOptions({
      runLLM: mockRunLLM(wrapped),
    }));
    expect(result.theme).toBe("biocides-and-chemical-treatment");
  });

  test("retries on malformed JSON", async () => {
    const runLLM = mockRunLLM(
      "Not JSON at all, just text",
      validResponse,
    );
    const result = await classifyMarkdown(baseOptions({ runLLM }));
    expect(result.theme).toBe("biocides-and-chemical-treatment");
    expect(runLLM.callCount()).toBe(2);
  });

  test("retries on JSON with missing theme field", async () => {
    const bad = JSON.stringify({ confidence: 0.9, rationale: "x" });
    const runLLM = mockRunLLM(bad, validResponse);
    const result = await classifyMarkdown(baseOptions({ runLLM }));
    expect(result.theme).toBe("biocides-and-chemical-treatment");
  });

  test("retries on JSON with missing confidence", async () => {
    const bad = JSON.stringify({
      theme: "biocides-and-chemical-treatment",
      rationale: "x",
    });
    const runLLM = mockRunLLM(bad, validResponse);
    const result = await classifyMarkdown(baseOptions({ runLLM }));
    expect(result.theme).toBe("biocides-and-chemical-treatment");
  });

  test("retries on confidence out of range", async () => {
    const bad = JSON.stringify({
      theme: "biocides-and-chemical-treatment",
      confidence: 1.5,
      rationale: "x",
    });
    const runLLM = mockRunLLM(bad, validResponse);
    const result = await classifyMarkdown(baseOptions({ runLLM }));
    expect(result.theme).toBe("biocides-and-chemical-treatment");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Theme validation
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyMarkdown — theme validation", () => {
  test("retries when LLM picks a theme not in the list", async () => {
    const inventedTheme = JSON.stringify({
      theme: "made-up-theme-name",
      confidence: 0.9,
      rationale: "I invented this.",
    });
    const runLLM = mockRunLLM(inventedTheme, validResponse);
    const result = await classifyMarkdown(baseOptions({ runLLM }));
    expect(result.theme).toBe("biocides-and-chemical-treatment");
    expect(runLLM.callCount()).toBe(2);
  });

  test("retries on subtle theme variations (typos)", async () => {
    const typo = JSON.stringify({
      theme: "biocides-and-chemical-treatments",  // trailing s
      confidence: 0.9,
      rationale: "Misspelled.",
    });
    const runLLM = mockRunLLM(typo, validResponse);
    const result = await classifyMarkdown(baseOptions({ runLLM }));
    expect(result.theme).toBe("biocides-and-chemical-treatment");
  });

  test("throws on exhaustion if theme never matches", async () => {
    const bad = JSON.stringify({
      theme: "made-up",
      confidence: 0.5,
      rationale: "Wrong.",
    });
    const runLLM = mockRunLLM(bad, bad, bad);
    await expect(classifyMarkdown(baseOptions({ runLLM, maxRetries: 2 })))
      .rejects.toThrow(/not in the provided theme list/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fallback on exhaustion
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyMarkdown — fallback", () => {
  test("returns fallback on retry exhaustion when provided", async () => {
    const runLLM = mockRunLLM("garbage", "still garbage", "more garbage");
    const fallback = {
      theme: "biological-control-and-prevention",
      confidence: 0.3,
      rationale: "fallback classification due to LLM failure",
    };
    const result = await classifyMarkdown(baseOptions({
      runLLM, maxRetries: 2, fallback,
    }));
    expect(result).toEqual(fallback);
  });

  test("preserves fallback shape exactly", async () => {
    const runLLM = mockRunLLM("garbage");
    const fallback = {
      theme: null,
      confidence: null,
      rationale: "classification failed",
    };
    const result = await classifyMarkdown(baseOptions({
      runLLM, maxRetries: 0, fallback,
    }));
    expect(result.theme).toBeNull();
    expect(result.confidence).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Transport errors
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyMarkdown — transport errors", () => {
  test("retries when runLLM throws", async () => {
    const runLLM = mockRunLLM(new Error("network blip"), validResponse);
    const result = await classifyMarkdown(baseOptions({ runLLM }));
    expect(result.theme).toBe("biocides-and-chemical-treatment");
    expect(runLLM.callCount()).toBe(2);
  });

  test("throws on exhaustion if all attempts throw", async () => {
    const runLLM = mockRunLLM(
      new Error("a"),
      new Error("b"),
      new Error("c"),
    );
    await expect(classifyMarkdown(baseOptions({ runLLM, maxRetries: 2 })))
      .rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyMarkdown — input validation", () => {
  test("throws when content is missing", async () => {
    await expect(classifyMarkdown(baseOptions({ content: undefined })))
      .rejects.toThrow(/content must be a non-empty string/);
  });

  test("throws when content is empty", async () => {
    await expect(classifyMarkdown(baseOptions({ content: "" })))
      .rejects.toThrow(/content must be a non-empty string/);
  });

  test("throws when themes provided but prompt missing", async () => {
    await expect(classifyMarkdown(baseOptions({ prompt: undefined })))
      .rejects.toThrow(/prompt must be a non-empty string/);
  });

  test("does NOT throw on missing prompt when themes is empty", async () => {
    const result = await classifyMarkdown(baseOptions({
      themes: {}, prompt: undefined,
    }));
    expect(result.theme).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stripJsonFences helper
// ─────────────────────────────────────────────────────────────────────────────

describe("stripJsonFences", () => {
  test("strips ```json fences", () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("strips ```JSON fences (case variant)", () => {
    expect(stripJsonFences('```JSON\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("strips plain ``` fences", () => {
    expect(stripJsonFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("leaves unfenced JSON unchanged", () => {
    expect(stripJsonFences('{"a":1}')).toBe('{"a":1}');
  });

  test("trims leading/trailing whitespace", () => {
    expect(stripJsonFences('  \n{"a":1}\n  ')).toBe('{"a":1}');
  });

  test("returns non-string inputs unchanged", () => {
    expect(stripJsonFences(null)).toBeNull();
    expect(stripJsonFences(42)).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseJsonSafely helper
// ─────────────────────────────────────────────────────────────────────────────

describe("parseJsonSafely", () => {
  test("parses valid JSON", () => {
    expect(parseJsonSafely('{"x":1}')).toEqual({ x: 1 });
  });

  test("parses fenced JSON", () => {
    expect(parseJsonSafely('```json\n{"x":1}\n```')).toEqual({ x: 1 });
  });

  test("returns null on malformed JSON", () => {
    expect(parseJsonSafely("not json")).toBeNull();
    expect(parseJsonSafely("{x:1}")).toBeNull();
  });

  test("returns null on non-string input", () => {
    expect(parseJsonSafely(null)).toBeNull();
    expect(parseJsonSafely(42)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildValidator helper
// ─────────────────────────────────────────────────────────────────────────────

describe("buildValidator", () => {
  const validate = buildValidator(SAMPLE_THEMES);

  test("passes valid response", () => {
    const r = validate(JSON.stringify({
      theme: "biocides-and-chemical-treatment",
      confidence: 0.9,
      rationale: "good.",
    }));
    expect(r.valid).toBe(true);
  });

  test("fails on non-JSON", () => {
    const r = validate("not json");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/not valid JSON/);
  });

  test("fails when theme not in list", () => {
    const r = validate(JSON.stringify({
      theme: "made-up",
      confidence: 0.9,
      rationale: "x",
    }));
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/not in the provided theme list/);
  });

  test("fails when confidence out of range", () => {
    const r = validate(JSON.stringify({
      theme: "biocides-and-chemical-treatment",
      confidence: 2,
      rationale: "x",
    }));
    expect(r.valid).toBe(false);
  });

  test("fails when confidence is negative", () => {
    const r = validate(JSON.stringify({
      theme: "biocides-and-chemical-treatment",
      confidence: -0.5,
      rationale: "x",
    }));
    expect(r.valid).toBe(false);
  });

  test("fails when rationale is empty", () => {
    const r = validate(JSON.stringify({
      theme: "biocides-and-chemical-treatment",
      confidence: 0.9,
      rationale: "",
    }));
    expect(r.valid).toBe(false);
  });

  test("accumulates multiple errors", () => {
    const r = validate(JSON.stringify({
      theme: 42,
      confidence: "high",
      // no rationale
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatUserMessage helper
// ─────────────────────────────────────────────────────────────────────────────

describe("formatUserMessage", () => {
  test("includes all theme names", () => {
    const msg = formatUserMessage(SAMPLE_THEMES, "doc content");
    expect(msg).toContain("biocides-and-chemical-treatment");
    expect(msg).toContain("biological-control-and-prevention");
    expect(msg).toContain("legionella-specific-control-and-prevention");
  });

  test("includes theme descriptions", () => {
    const msg = formatUserMessage(SAMPLE_THEMES, "doc");
    expect(msg).toContain("Chemical treatment programs");
  });

  test("includes examples when present", () => {
    const msg = formatUserMessage(SAMPLE_THEMES, "doc");
    expect(msg).toContain("Chlorine dosing");
  });

  test("includes the document content", () => {
    const msg = formatUserMessage(SAMPLE_THEMES, "DOCUMENT BODY");
    expect(msg).toContain("DOCUMENT BODY");
    expect(msg).toContain("Document to classify:");
  });

  test("handles themes without examples", () => {
    const themesNoExamples = {
      "theme-a": { description: "A theme without examples" },
    };
    const msg = formatUserMessage(themesNoExamples, "doc");
    expect(msg).toContain("theme-a");
    expect(msg).toContain("A theme without examples");
    expect(msg).not.toContain("Examples:");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyMarkdown — module export", () => {
  test("module is the function", () => {
    expect(typeof classifyMarkdown).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(classifyMarkdown)).toBe(true);
  });

  test("self-referential property", () => {
    expect(classifyMarkdown.classifyMarkdown).toBe(classifyMarkdown);
  });

  test("exposes helpers", () => {
    expect(typeof classifyMarkdown.stripJsonFences).toBe("function");
    expect(typeof classifyMarkdown.parseJsonSafely).toBe("function");
    expect(typeof classifyMarkdown.buildValidator).toBe("function");
    expect(typeof classifyMarkdown.formatUserMessage).toBe("function");
  });
});