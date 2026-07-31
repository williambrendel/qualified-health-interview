"use strict";

const augmentSections = require("../../../../src/actions/generate/binary/augmentSections");
const {
  stripJsonFences,
  parseRowsSafely,
  validateRowsResponse,
  extractRowTexts,
  formatUserMessage,
  noopLimit,
} = augmentSections;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const sampleRows = [
  {
    descriptors: [],
    angle: "What",
    question: "What is biofilm in cooling towers?",
    variants: ["What is the slime layer?", "What is the bacterial layer?"],
    anchors: ["biofilm cooling tower", "slime layer", "bacterial film"],
  },
  {
    descriptors: [],
    angle: "How",
    question: "How does biofilm form?",
    variants: ["How does slime grow?"],
    anchors: ["biofilm formation", "biofilm growth"],
  },
];

const sampleRowsJson = JSON.stringify(sampleRows);

const makeMockVectorize = () => jest.fn(async (text) => new Float32Array([text.length]));

const makeSection = (overrides = {}) => {
  const { initialVecs = ["BREADCRUMB-VEC", "BODY-VEC"], ...rest } = overrides;
  return {
    range:       [0, 100],
    breadcrumbs: "Topic",
    content:     "Sample content body.",
    vecs:        initialVecs.map(v => Promise.resolve(v)),
    ...rest,
  };
};

const baseOptions = (overrides = {}) => ({
  sections:  [makeSection()],
  vectorize: makeMockVectorize(),
  prompt:    "AUGMENT PROMPT",
  runLLM:    jest.fn(async () => sampleRowsJson),
  llmConfig: { model: "test-model" },
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("augmentSections — happy path", () => {
  test("pushes vectorize Promises to section.vecs", async () => {
    const sections = [makeSection({ initialVecs: ["X"] })];
    const vectorize = makeMockVectorize();
    const beforeLength = sections[0].vecs.length;
    await augmentSections(baseOptions({ sections, vectorize }));
    expect(sections[0].vecs.length).toBeGreaterThan(beforeLength);
  });

  test("calls vectorize on question + anchors + variants per row", async () => {
    const sections = [makeSection({ initialVecs: [] })];
    const vectorize = makeMockVectorize();
    await augmentSections(baseOptions({ sections, vectorize }));
    // Row 0: 1 q + 3 anchors + 2 variants = 6
    // Row 1: 1 q + 2 anchors + 1 variant  = 4
    expect(vectorize).toHaveBeenCalledTimes(10);
  });

  test("vectorize call order: question first, then anchors, then variants per row", async () => {
    const sections = [makeSection({ initialVecs: [] })];
    const vectorize = makeMockVectorize();
    await augmentSections(baseOptions({ sections, vectorize }));
    const calls = vectorize.mock.calls.map(c => c[0]);
    expect(calls[0]).toBe("What is biofilm in cooling towers?");
    expect(calls[1]).toBe("biofilm cooling tower");
    expect(calls[2]).toBe("slime layer");
    expect(calls[3]).toBe("bacterial film");
    expect(calls[4]).toBe("What is the slime layer?");
    expect(calls[5]).toBe("What is the bacterial layer?");
    expect(calls[6]).toBe("How does biofilm form?");
    expect(calls[7]).toBe("biofilm formation");
    expect(calls[8]).toBe("biofilm growth");
    expect(calls[9]).toBe("How does slime grow?");
  });

  test("number of pushed vecs equals number of vectorize calls", async () => {
    const sections = [makeSection({ initialVecs: ["a", "b"] })];
    const vectorize = makeMockVectorize();
    await augmentSections(baseOptions({ sections, vectorize }));
    const added = sections[0].vecs.length - 2;
    expect(added).toBe(vectorize.mock.calls.length);
  });

  test("vecs entries are Promises", async () => {
    const sections = [makeSection({ initialVecs: [] })];
    await augmentSections(baseOptions({ sections }));
    for (const v of sections[0].vecs) {
      expect(v).toBeInstanceOf(Promise);
    }
  });

  test("multiple sections processed independently", async () => {
    const sections = [
      makeSection({ breadcrumbs: "A", initialVecs: ["a"] }),
      makeSection({ breadcrumbs: "B", initialVecs: ["b"] }),
      makeSection({ breadcrumbs: "C", initialVecs: ["c"] }),
    ];
    await augmentSections(baseOptions({ sections }));
    for (const s of sections) {
      expect(s.vecs.length).toBeGreaterThan(1);
    }
  });

  test("returns the same sections array", async () => {
    const sections = [makeSection()];
    const result = await augmentSections(baseOptions({ sections }));
    expect(result).toBe(sections);
  });

  test("calls runLLM once per section", async () => {
    const runLLM = jest.fn(async () => sampleRowsJson);
    const sections = [makeSection(), makeSection(), makeSection()];
    await augmentSections(baseOptions({ sections, runLLM }));
    expect(runLLM).toHaveBeenCalledTimes(3);
  });

  test("passes llmConfig with system prompt and user message positionally to runLLM", async () => {
    const runLLM = jest.fn(async () => sampleRowsJson);
    await augmentSections(baseOptions({
      runLLM,
      prompt: "MY PROMPT",
      llmConfig: { model: "claude-haiku" },
    }));
    const [config, userMsg] = runLLM.mock.calls[0];
    expect(config.model).toBe("claude-haiku");
    expect(config.system).toBe("MY PROMPT");
    expect(typeof userMsg).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// User message formatting
// ─────────────────────────────────────────────────────────────────────────────

describe("augmentSections — user message format", () => {
  test("includes breadcrumbs and content", async () => {
    const runLLM = jest.fn(async () => sampleRowsJson);
    const section = makeSection({
      breadcrumbs: "Topic, Sub",
      content: "BODY CONTENT HERE",
    });
    await augmentSections(baseOptions({ sections: [section], runLLM }));
    const userMsg = runLLM.mock.calls[0][1];
    expect(userMsg).toContain("BODY CONTENT HERE");
    expect(userMsg).toContain("Topic > Sub");
    expect(userMsg).toContain("section content:");
  });

  test("omits breadcrumb header line when breadcrumbs is empty", async () => {
    const runLLM = jest.fn(async () => sampleRowsJson);
    const section = makeSection({
      breadcrumbs: "",
      content: "BODY ONLY",
    });
    await augmentSections(baseOptions({ sections: [section], runLLM }));
    const userMsg = runLLM.mock.calls[0][1];
    expect(userMsg).toBe("BODY ONLY");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-section failure tolerance
// ─────────────────────────────────────────────────────────────────────────────

describe("augmentSections — per-section failure tolerance", () => {
  test("section keeps original vecs when LLM fails after retries", async () => {
    const runLLM = jest.fn(async () => "not json garbage");
    const sections = [makeSection({ initialVecs: ["original-vec"] })];
    const onSectionError = jest.fn();
    const vectorize = makeMockVectorize();
    await augmentSections(baseOptions({
      sections, vectorize, runLLM, onSectionError, maxRetries: 1,
    }));
    expect(sections[0].vecs.length).toBe(1);
    expect(vectorize).not.toHaveBeenCalled();
    expect(onSectionError).toHaveBeenCalledTimes(1);
  });

  test("good and bad sections coexist", async () => {
    const runLLM = jest.fn(async (config, prompt) => {
      if (prompt.includes("GOOD")) return sampleRowsJson;
      return "not json";
    });
    const sections = [
      makeSection({ content: "GOOD CONTENT", initialVecs: ["a"] }),
      makeSection({ content: "BAD CONTENT",  initialVecs: ["b"] }),
      makeSection({ content: "GOOD CONTENT", initialVecs: ["c"] }),
    ];
    const errors = [];
    await augmentSections(baseOptions({
      sections,
      runLLM,
      maxRetries: 0,
      onSectionError: (i, err) => errors.push({ i, err }),
    }));
    expect(sections[0].vecs.length).toBeGreaterThan(1);
    expect(sections[1].vecs.length).toBe(1);
    expect(sections[2].vecs.length).toBeGreaterThan(1);
    expect(errors.length).toBe(1);
    expect(errors[0].i).toBe(1);
  });

  test("onSectionError callback receives index and error", async () => {
    const runLLM = jest.fn(async () => "not json");
    const sections = [makeSection({ initialVecs: ["x"] })];
    const onSectionError = jest.fn();
    await augmentSections(baseOptions({
      sections, runLLM, onSectionError, maxRetries: 0,
    }));
    expect(onSectionError).toHaveBeenCalledTimes(1);
    expect(onSectionError.mock.calls[0][0]).toBe(0);
    expect(onSectionError.mock.calls[0][1]).toBeInstanceOf(Error);
  });

  test("no callback provided: failures are silently tolerated", async () => {
    const runLLM = jest.fn(async () => "not json");
    const sections = [makeSection({ initialVecs: ["x"] })];
    await expect(augmentSections(baseOptions({
      sections, runLLM, maxRetries: 0,
    }))).resolves.toBeDefined();
    expect(sections[0].vecs.length).toBe(1);
  });

  test("runLLM throws: callback fires, section unchanged", async () => {
    const runLLM = jest.fn(async () => { throw new Error("transport"); });
    const sections = [makeSection({ initialVecs: ["original"] })];
    const onSectionError = jest.fn();
    await augmentSections(baseOptions({
      sections, runLLM, onSectionError, maxRetries: 0,
    }));
    expect(sections[0].vecs.length).toBe(1);
    expect(onSectionError).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON fence stripping + parsing
// ─────────────────────────────────────────────────────────────────────────────

describe("augmentSections — JSON handling", () => {
  test("strips ```json wrapping before parsing", async () => {
    const wrapped = "```json\n" + sampleRowsJson + "\n```";
    const runLLM = jest.fn(async () => wrapped);
    const sections = [makeSection({ initialVecs: [] })];
    await augmentSections(baseOptions({ sections, runLLM }));
    expect(sections[0].vecs.length).toBeGreaterThan(0);
  });

  test("strips plain ``` wrapping", async () => {
    const wrapped = "```\n" + sampleRowsJson + "\n```";
    const runLLM = jest.fn(async () => wrapped);
    const sections = [makeSection({ initialVecs: [] })];
    await augmentSections(baseOptions({ sections, runLLM }));
    expect(sections[0].vecs.length).toBeGreaterThan(0);
  });

  test("retries on malformed JSON", async () => {
    let call = 0;
    const runLLM = jest.fn(async () => {
      call++;
      return call === 1 ? "not json" : sampleRowsJson;
    });
    const sections = [makeSection({ initialVecs: [] })];
    await augmentSections(baseOptions({ sections, runLLM, maxRetries: 2 }));
    expect(sections[0].vecs.length).toBeGreaterThan(0);
    expect(runLLM).toHaveBeenCalledTimes(2);
  });

  test("retries when response is JSON but not an array", async () => {
    let call = 0;
    const runLLM = jest.fn(async () => {
      call++;
      return call === 1 ? '{"foo": "bar"}' : sampleRowsJson;
    });
    const sections = [makeSection({ initialVecs: [] })];
    await augmentSections(baseOptions({ sections, runLLM, maxRetries: 2 }));
    expect(runLLM).toHaveBeenCalledTimes(2);
  });

  test("rows without question are skipped silently", async () => {
    const mixedRows = JSON.stringify([
      { question: "OK row", anchors: ["a1"], variants: ["v1"] },
      { anchors: ["should not appear"] },
      { question: "", anchors: ["empty question skipped"] },
      { question: "Another OK", anchors: ["a2"] },
    ]);
    const runLLM = jest.fn(async () => mixedRows);
    const sections = [makeSection({ initialVecs: [] })];
    const vectorize = makeMockVectorize();
    await augmentSections(baseOptions({ sections, vectorize, runLLM }));
    const calls = vectorize.mock.calls.map(c => c[0]);
    expect(calls).toContain("OK row");
    expect(calls).toContain("Another OK");
    expect(calls).not.toContain("should not appear");
    expect(calls).not.toContain("empty question skipped");
  });

  test("non-string anchor/variant entries are silently dropped", async () => {
    const malformedRows = JSON.stringify([
      {
        question: "Real question",
        anchors:  ["good anchor", 42, null, undefined, ""],
        variants: ["good variant", true, {}],
      },
    ]);
    const runLLM = jest.fn(async () => malformedRows);
    const sections = [makeSection({ initialVecs: [] })];
    const vectorize = makeMockVectorize();
    await augmentSections(baseOptions({ sections, vectorize, runLLM }));
    const calls = vectorize.mock.calls.map(c => c[0]);
    expect(calls).toContain("Real question");
    expect(calls).toContain("good anchor");
    expect(calls).toContain("good variant");
    expect(calls).not.toContain(42);
  });

  test("missing anchors/variants arrays handled", async () => {
    const minimalRows = JSON.stringify([{ question: "Just a question" }]);
    const runLLM = jest.fn(async () => minimalRows);
    const sections = [makeSection({ initialVecs: [] })];
    const vectorize = makeMockVectorize();
    await augmentSections(baseOptions({ sections, vectorize, runLLM }));
    expect(vectorize).toHaveBeenCalledTimes(1);
    expect(vectorize.mock.calls[0][0]).toBe("Just a question");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency limit
// ─────────────────────────────────────────────────────────────────────────────

describe("augmentSections — concurrency limit", () => {
  test("calls go through the provided limit function", async () => {
    const limit = jest.fn(fn => fn());
    const sections = [makeSection(), makeSection(), makeSection()];
    await augmentSections(baseOptions({ sections, limit }));
    expect(limit).toHaveBeenCalledTimes(3);
  });

  test("works without a limit (noop default)", async () => {
    const sections = [makeSection({ initialVecs: [] })];
    await augmentSections(baseOptions({ sections }));
    expect(sections[0].vecs.length).toBeGreaterThan(0);
  });

  test("limit can serialize calls (verify in-flight bound)", async () => {
    let inFlight = 0;
    let peak = 0;
    const serialLimit = async (fn) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await fn();
      } finally {
        inFlight--;
      }
    };
    const runLLM = jest.fn(async () => {
      await new Promise(r => setTimeout(r, 5));
      return sampleRowsJson;
    });
    const sections = Array.from({ length: 5 }, () => makeSection({ initialVecs: [] }));
    await augmentSections(baseOptions({ sections, runLLM, limit: serialLimit }));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(sections.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe("augmentSections — input validation", () => {
  test("throws when sections is not an array", async () => {
    await expect(augmentSections(baseOptions({ sections: "not array" })))
      .rejects.toThrow(/sections must be an array/);
  });

  test("throws when vectorize is missing", async () => {
    await expect(augmentSections(baseOptions({ vectorize: undefined })))
      .rejects.toThrow(/vectorize must be a function/);
  });

  test("throws when vectorize is not a function", async () => {
    await expect(augmentSections(baseOptions({ vectorize: "nope" })))
      .rejects.toThrow(/vectorize must be a function/);
  });

  test("throws when prompt is missing", async () => {
    await expect(augmentSections(baseOptions({ prompt: undefined })))
      .rejects.toThrow(/prompt must be a non-empty string/);
  });

  test("throws when prompt is empty", async () => {
    await expect(augmentSections(baseOptions({ prompt: "" })))
      .rejects.toThrow(/prompt must be a non-empty string/);
  });

  test("throws when runLLM is missing", async () => {
    await expect(augmentSections(baseOptions({ runLLM: undefined })))
      .rejects.toThrow(/runLLM must be a function/);
  });

  test("throws when limit is not a function", async () => {
    await expect(augmentSections(baseOptions({ limit: "not function" })))
      .rejects.toThrow(/limit must be a function/);
  });

  test("empty sections array succeeds without error", async () => {
    const runLLM = jest.fn(async () => sampleRowsJson);
    const result = await augmentSections(baseOptions({ sections: [], runLLM }));
    expect(result).toEqual([]);
    expect(runLLM).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (unchanged from c-2)
// ─────────────────────────────────────────────────────────────────────────────

describe("stripJsonFences", () => {
  test("strips ```json wrapper", () => {
    expect(stripJsonFences('```json\n[1,2,3]\n```')).toBe('[1,2,3]');
  });

  test("strips plain ``` wrapper", () => {
    expect(stripJsonFences('```\n[1,2,3]\n```')).toBe('[1,2,3]');
  });

  test("unfenced input is returned trimmed", () => {
    expect(stripJsonFences('  [1,2,3]  ')).toBe('[1,2,3]');
  });

  test("non-string input returned as-is", () => {
    expect(stripJsonFences(null)).toBeNull();
    expect(stripJsonFences(42)).toBe(42);
  });
});

describe("parseRowsSafely", () => {
  test("parses valid JSON array", () => {
    expect(parseRowsSafely('[{"q":1}]')).toEqual([{ q: 1 }]);
  });

  test("returns null on non-array JSON", () => {
    expect(parseRowsSafely('{"x":1}')).toBeNull();
  });

  test("returns null on malformed JSON", () => {
    expect(parseRowsSafely('not json')).toBeNull();
  });

  test("handles fenced JSON", () => {
    expect(parseRowsSafely('```json\n[1,2]\n```')).toEqual([1, 2]);
  });

  test("returns null on non-string input", () => {
    expect(parseRowsSafely(null)).toBeNull();
    expect(parseRowsSafely(42)).toBeNull();
  });
});

describe("validateRowsResponse", () => {
  test("valid JSON array passes", () => {
    expect(validateRowsResponse('[]')).toEqual({ valid: true });
  });

  test("non-array JSON fails", () => {
    const r = validateRowsResponse('{"x":1}');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/JSON array/);
  });

  test("malformed JSON fails", () => {
    const r = validateRowsResponse('not json');
    expect(r.valid).toBe(false);
  });
});

describe("extractRowTexts", () => {
  test("question + anchors + variants in correct order", () => {
    const rows = [{ question: "Q1", anchors: ["A1", "A2"], variants: ["V1", "V2"] }];
    expect(extractRowTexts(rows)).toEqual(["Q1", "A1", "A2", "V1", "V2"]);
  });

  test("skips rows with missing question", () => {
    const rows = [{ question: "Real" }, { anchors: ["should skip"] }];
    expect(extractRowTexts(rows)).toEqual(["Real"]);
  });

  test("skips rows with empty question", () => {
    const rows = [{ question: "", anchors: ["nope"] }, { question: "OK" }];
    expect(extractRowTexts(rows)).toEqual(["OK"]);
  });

  test("handles missing anchors/variants arrays", () => {
    expect(extractRowTexts([{ question: "Q" }])).toEqual(["Q"]);
  });

  test("filters non-string anchors and variants", () => {
    const rows = [{
      question: "Q",
      anchors:  ["good", 42, null, ""],
      variants: ["v", undefined, {}],
    }];
    expect(extractRowTexts(rows)).toEqual(["Q", "good", "v"]);
  });

  test("multiple rows concatenated in order", () => {
    const rows = [
      { question: "Q1" },
      { question: "Q2", anchors: ["A2"] },
    ];
    expect(extractRowTexts(rows)).toEqual(["Q1", "Q2", "A2"]);
  });

  test("empty rows array returns empty", () => {
    expect(extractRowTexts([])).toEqual([]);
  });
});

describe("formatUserMessage", () => {
  test("includes breadcrumb header line when breadcrumbs present", () => {
    const msg = formatUserMessage({ breadcrumbs: "A, B, C", content: "BODY" });
    expect(msg).toContain("section header breadcrumbs: A > B > C");
    expect(msg).toContain("section content:");
    expect(msg).toContain("BODY");
  });

  test("omits header line when breadcrumbs is empty", () => {
    expect(formatUserMessage({ breadcrumbs: "", content: "BODY" })).toBe("BODY");
  });

  test("handles missing breadcrumbs property", () => {
    expect(formatUserMessage({ content: "BODY" })).toBe("BODY");
  });

  test("handles missing content property", () => {
    expect(formatUserMessage({ breadcrumbs: "A" })).toContain("A");
  });
});

describe("noopLimit", () => {
  test("calls and returns the thunk's result", async () => {
    const result = await noopLimit(async () => 42);
    expect(result).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────────────

describe("augmentSections — module export", () => {
  test("module is the function", () => {
    expect(typeof augmentSections).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(augmentSections)).toBe(true);
  });

  test("self-referential property", () => {
    expect(augmentSections.augmentSections).toBe(augmentSections);
  });

  test("exposes helpers", () => {
    expect(typeof augmentSections.stripJsonFences).toBe("function");
    expect(typeof augmentSections.parseRowsSafely).toBe("function");
    expect(typeof augmentSections.validateRowsResponse).toBe("function");
    expect(typeof augmentSections.extractRowTexts).toBe("function");
    expect(typeof augmentSections.formatUserMessage).toBe("function");
    expect(typeof augmentSections.noopLimit).toBe("function");
  });
});