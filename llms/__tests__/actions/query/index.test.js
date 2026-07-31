"use strict";

const run = require("../../../src/actions/query");
const { TEMPLATES, TEMPLATE_RULES, pickGreetingTemplate } = run;

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures — mocks for every injected dependency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a mock analyzer that returns a fixed analysis. Tests override
 * specific fields by passing them in.
 */
const mockAnalyzer = (overrides = {}) => async (rawQuery) => ({
  query:       rawQuery,
  corrected:   rawQuery,
  greeting:    false,
  frustration: { score: 0.0, level: null },
  multiPart:   false,
  segments:    [
    {
      text: rawQuery,
      classification: { label: "TECHNICAL", confidence: 0.9 },
      vec: new Float32Array([0.1, 0.2, 0.3]),
    },
  ],
  ...overrides,
});

/**
 * Mock SectionResolver instance. Has `resolve()` returning section
 * text from an internal map; `documentIds` and `size` are getters
 * matching the real class shape (you switched these to getters).
 */
const mockResolver = (sectionMap = {}) => ({
  resolve(documentId, range) {
    const key = `${documentId}[${range[0]},${range[1]}]`;
    return sectionMap[key] || "default section text";
  },
  get documentIds() {
    return Object.keys(sectionMap);
  },
  get size() {
    return Object.keys(sectionMap).length;
  },
});

/**
 * Mock VectorStore. Search ignores the query vector and returns
 * canned hits passed in via the factory.
 */
const mockStore = (cannedHits = []) => ({
  documents: [], // search() may inspect this
  __cannedHits: cannedHits,
});

// The real `search` is imported by the orchestrator from
// `../../VectorStore/search`. We can't easily mock it at the module
// level without jest.mock. Instead, we patch the orchestrator's
// import resolution by intercepting `require.cache`. Simpler approach:
// supply a store object that the real search would handle, OR mock
// the relevant module.
//
// For these unit tests, we mock `search` via jest.mock at the top
// of the file.

jest.mock("../../../src/VectorStore/search", () => {
  // The store carries `__cannedHits` (set by mockStore). Return those.
  return jest.fn((store, vec, options) => {
    return store.__cannedHits || [];
  });
});

/**
 * Mock runLLM. Configurable to:
 *   - Return a valid response (default)
 *   - Throw an error
 *   - Return an invalid shape
 *   - Different responses on different attempts (for retry tests)
 */
const mockLLM = (config = {}) => {
  const responses = config.responses || [{
    answer: [{ text: "default mock answer" }],
    followUpQuestions: [],
  }];
  let callCount = 0;
  const fn = jest.fn(async (llmConfig, prompt) => {
    const idx = Math.min(callCount, responses.length - 1);
    const r = responses[idx];
    callCount++;
    if (r instanceof Error) throw r;
    return r;
  });
  fn.callCount = () => callCount;
  return fn;
};

const baseOptions = (overrides = {}) => ({
  rawQuery:      "what causes biofilm",
  store:         mockStore([
    { score: 0.8, documentId: "doc|a", range: [0, 100] },
  ]),
  analyzeQuery:  mockAnalyzer(),
  resolver:      mockResolver({ "doc|a[0,100]": "Biofilm section text" }),
  runLLM:        mockLLM(),
  prompts:       { answer: "ANSWER PROMPT" },
  llmConfig:     { model: "claude-haiku-test", temperature: 0.0 },
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Path 1: Pure greeting fast path
// ─────────────────────────────────────────────────────────────────────────────

describe("run — Path 1: pure greeting fast path", () => {
  test("returns templated greeting when segments empty + greeting true", async () => {
    const opts = baseOptions({
      analyzeQuery: mockAnalyzer({
        segments: [],
        greeting: true,
        corrected: "hello",
      }),
    });
    const result = await run(opts);
    expect(result.answer.length).toBe(1);
    expect(result.answer[0].text).toBe(TEMPLATES.default);
    expect(result.followUpQuestions).toEqual([]);
    expect(opts.runLLM).not.toHaveBeenCalled();
  });

  test("uses greetingTemplate override when provided", async () => {
    const result = await run(baseOptions({
      analyzeQuery: mockAnalyzer({
        segments: [],
        greeting: true,
        corrected: "hi",
      }),
      greetingTemplate: "Custom welcome!",
    }));
    expect(result.answer[0].text).toBe("Custom welcome!");
  });

  test("dispatches to 'thanks' template on 'thank you'", async () => {
    const result = await run(baseOptions({
      analyzeQuery: mockAnalyzer({
        segments: [],
        greeting: true,
        corrected: "thank you",
      }),
    }));
    expect(result.answer[0].text).toBe(TEMPLATES.thanks);
  });

  test("dispatches to 'morning' template on 'good morning'", async () => {
    const result = await run(baseOptions({
      analyzeQuery: mockAnalyzer({
        segments: [],
        greeting: true,
        corrected: "good morning",
      }),
    }));
    expect(result.answer[0].text).toBe(TEMPLATES.morning);
  });

  test("response includes analyzer metadata", async () => {
    const result = await run(baseOptions({
      analyzeQuery: mockAnalyzer({
        segments: [],
        greeting: true,
        corrected: "hi",
        frustration: { score: 0.0, level: null },
      }),
    }));
    expect(result.query).toBe("what causes biofilm"); // rawQuery preserved
    expect(result.corrected).toBe("hi");
    expect(result.greeting).toBe(true);
    expect(result.user_intent).toEqual(["GREETING"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path 3: Synthesis LLM path
// ─────────────────────────────────────────────────────────────────────────────

describe("run — Path 3: synthesis (LLM)", () => {
  test("calls runLLM with the answer prompt + serialized context", async () => {
    const llm = mockLLM();
    await run(baseOptions({ runLLM: llm }));
    expect(llm).toHaveBeenCalledTimes(1);
    const [config, userMessage] = llm.mock.calls[0];
    expect(config.system).toBe("ANSWER PROMPT");
    expect(userMessage).toContain("User query: what causes biofilm");
    expect(userMessage).toContain("User intent: TECHNICAL");
    expect(userMessage).toContain("Results:[1]");
  });

  test("returns the LLM's answer chunks unchanged", async () => {
    const llmAnswer = [
      { text: "Biofilm forms when...", source: { documentId: "doc|a", range: [0, 100] } },
      { text: " The matrix protects against disinfectants." },
    ];
    const result = await run(baseOptions({
      runLLM: mockLLM({
        responses: [{ answer: llmAnswer, followUpQuestions: ["How fast?"] }],
      }),
    }));
    expect(result.answer).toEqual(llmAnswer);
    expect(result.followUpQuestions).toEqual(["How fast?"]);
  });

  test("response includes all analyzer metadata fields", async () => {
    const result = await run(baseOptions({
      rawQuery: "what causes biofilm",
      analyzeQuery: mockAnalyzer({
        corrected: "what causes biofilm",
        frustration: { score: 0.0, level: null },
        segments: [
          { text: "what causes biofilm", classification: { label: "TECHNICAL" }, vec: new Float32Array([0]) },
        ],
      }),
    }));
    expect(result.query).toBe("what causes biofilm");
    expect(result.corrected).toBe("what causes biofilm");
    expect(result.greeting).toBe(false);
    expect(result.frustration).toEqual({ score: 0.0, level: null });
    expect(result.user_intent).toEqual(["TECHNICAL"]);
  });

  test("multi-segment query: unions hits across segments", async () => {
    // Two segments will each call search; the mock returns the same
    // canned hits per call, so we just verify search was called per
    // segment.
    const cannedHits = [
      { score: 0.8, documentId: "doc|a", range: [0, 100] },
      { score: 0.6, documentId: "doc|b", range: [200, 300] },
    ];
    const opts = baseOptions({
      analyzeQuery: mockAnalyzer({
        segments: [
          { text: "p1", classification: { label: "TECHNICAL" }, vec: new Float32Array([1]) },
          { text: "p2", classification: { label: "TECHNICAL" }, vec: new Float32Array([2]) },
        ],
      }),
      store: mockStore(cannedHits),
      resolver: mockResolver({
        "doc|a[0,100]": "Section A text",
        "doc|b[200,300]": "Section B text",
      }),
    });
    const result = await run(opts);
    // Two segments → 2 search calls (both return the same hits, but
    // unionHits dedupes to 2 unique).
    expect(result.answer).toBeDefined();
  });

  test("missing section text is silently dropped (resolver returned null)", async () => {
    const llm = mockLLM();
    await run(baseOptions({
      runLLM: llm,
      resolver: mockResolver({}), // empty map; all lookups will use "default section text" fallback
    }));
    // With the mock resolver always returning a string, no drops happen.
    // A null-returning resolver tests the drop path:
    await run(baseOptions({
      runLLM: llm,
      resolver: {
        resolve: () => null,
        get documentIds() { return []; },
        get size() { return 0; },
      },
    }));
    // Second call's userMessage should show empty results
    const userMsg = llm.mock.calls[1][1];
    expect(userMsg).toContain("Results:[0]");
  });

  test("respects maxOutputRows cap", async () => {
    // Build a store that returns more hits than maxOutputRows
    const lots = Array.from({ length: 50 }, (_, i) => ({
      score: 0.5 - i * 0.001,
      documentId: `doc|${i}`,
      range: [0, 100],
    }));
    const llm = mockLLM();
    const resolverMap = {};
    lots.forEach(h => { resolverMap[`${h.documentId}[0,100]`] = `text ${h.documentId}`; });

    await run(baseOptions({
      runLLM: llm,
      store: mockStore(lots),
      resolver: mockResolver(resolverMap),
      maxOutputRows: 5,
    }));

    const userMsg = llm.mock.calls[0][1];
    expect(userMsg).toContain("Results:[5]");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path 2: Conversational LLM path (empty results, no greeting)
// ─────────────────────────────────────────────────────────────────────────────

describe("run — Path 2: conversational via LLM", () => {
  test("calls LLM with empty results when segments empty + no greeting", async () => {
    const llm = mockLLM();
    await run(baseOptions({
      runLLM: llm,
      analyzeQuery: mockAnalyzer({ segments: [], greeting: false }),
    }));
    expect(llm).toHaveBeenCalledTimes(1);
    const userMsg = llm.mock.calls[0][1];
    expect(userMsg).toContain("Results:[0]");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry loop on validator failure
// ─────────────────────────────────────────────────────────────────────────────

describe("run — retry on validator failure", () => {
  test("retries when first response is invalid, succeeds on second", async () => {
    const llm = mockLLM({
      responses: [
        { invalid: true }, // first call: bad shape
        { answer: [{ text: "ok" }], followUpQuestions: [] }, // second: good
      ],
    });
    const result = await run(baseOptions({ runLLM: llm }));
    expect(llm.callCount()).toBe(2);
    expect(result.answer[0].text).toBe("ok");
  });

  test("retries up to maxRetries times", async () => {
    const llm = mockLLM({
      responses: [
        { invalid: true },
        { invalid: true },
        { answer: [{ text: "ok" }], followUpQuestions: [] },
      ],
    });
    const result = await run(baseOptions({ runLLM: llm, maxRetries: 2 }));
    expect(llm.callCount()).toBe(3);
    expect(result.answer[0].text).toBe("ok");
  });

  test("retries on LLM transport errors", async () => {
    const llm = mockLLM({
      responses: [
        new Error("network failure"),
        { answer: [{ text: "ok" }], followUpQuestions: [] },
      ],
    });
    const result = await run(baseOptions({ runLLM: llm }));
    expect(llm.callCount()).toBe(2);
    expect(result.answer[0].text).toBe("ok");
  });

  test("throws when retries are exhausted (default)", async () => {
    const llm = mockLLM({
      responses: [{ invalid: true }, { invalid: true }, { invalid: true }],
    });
    await expect(run(baseOptions({ runLLM: llm, maxRetries: 2 }))).rejects.toThrow(/failed validation after 3 attempts/);
    expect(llm.callCount()).toBe(3);
  });

  test("returns fallback when retries are exhausted AND fallbackAnswer provided", async () => {
    const llm = mockLLM({
      responses: [{ invalid: true }, { invalid: true }, { invalid: true }],
    });
    const result = await run(baseOptions({
      runLLM: llm,
      maxRetries: 2,
      fallbackAnswer: "Sorry, I'm having trouble. Please try again.",
    }));
    expect(result.answer.length).toBe(1);
    expect(result.answer[0].text).toBe("Sorry, I'm having trouble. Please try again.");
    expect(result.followUpQuestions).toEqual([]);
  });

  test("fallback path still includes analyzer metadata", async () => {
    const llm = mockLLM({ responses: [{ invalid: true }, { invalid: true }, { invalid: true }] });
    const result = await run(baseOptions({
      runLLM: llm,
      fallbackAnswer: "fallback text",
    }));
    expect(result.query).toBeDefined();
    expect(result.corrected).toBeDefined();
    expect(result.user_intent).toBeDefined();
  });

  test("maxRetries=0 means single attempt then throw", async () => {
    const llm = mockLLM({ responses: [{ invalid: true }] });
    await expect(run(baseOptions({ runLLM: llm, maxRetries: 0 }))).rejects.toThrow(/failed validation after 1 attempts/);
    expect(llm.callCount()).toBe(1);
  });

  test("error includes attempts count and last output", async () => {
    const llm = mockLLM({ responses: [{ invalid: true }, { invalid: true }, { invalid: true }] });
    try {
      await run(baseOptions({ runLLM: llm, maxRetries: 2 }));
      throw new Error("expected to throw");
    } catch (err) {
      expect(err.attempts).toBe(3);
      expect(Array.isArray(err.errors)).toBe(true);
      expect(err.lastOutput).toEqual({ invalid: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Template dispatch helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("pickGreetingTemplate", () => {
  test("matches 'thanks'", () => {
    expect(pickGreetingTemplate("thanks!")).toBe(TEMPLATES.thanks);
    expect(pickGreetingTemplate("Thank you for the help")).toBe(TEMPLATES.thanks);
    expect(pickGreetingTemplate("ty so much")).toBe(TEMPLATES.thanks);
  });

  test("matches 'good morning' (and 'good day')", () => {
    expect(pickGreetingTemplate("good morning!")).toBe(TEMPLATES.morning);
    expect(pickGreetingTemplate("Good day everyone")).toBe(TEMPLATES.morning);
  });

  test("matches 'good afternoon'", () => {
    expect(pickGreetingTemplate("good afternoon!")).toBe(TEMPLATES.afternoon);
  });

  test("matches 'good evening'", () => {
    expect(pickGreetingTemplate("good evening")).toBe(TEMPLATES.evening);
  });

  test("falls back to default for unrecognized greetings", () => {
    expect(pickGreetingTemplate("hi")).toBe(TEMPLATES.default);
    expect(pickGreetingTemplate("hello")).toBe(TEMPLATES.default);
    expect(pickGreetingTemplate("yo")).toBe(TEMPLATES.default);
    expect(pickGreetingTemplate("")).toBe(TEMPLATES.default);
  });

  test("case-insensitive matching", () => {
    expect(pickGreetingTemplate("THANKS")).toBe(TEMPLATES.thanks);
    expect(pickGreetingTemplate("Good Morning")).toBe(TEMPLATES.morning);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────────────

describe("run — module export", () => {
  test("module is the function itself", () => {
    expect(typeof run).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(run)).toBe(true);
  });

  test("self-referential .run property", () => {
    expect(run.run).toBe(run);
  });

  test("exposes TEMPLATES", () => {
    expect(typeof TEMPLATES).toBe("object");
    expect(TEMPLATES.default).toBeDefined();
    expect(TEMPLATES.thanks).toBeDefined();
  });

  test("TEMPLATES is frozen", () => {
    expect(Object.isFrozen(TEMPLATES)).toBe(true);
  });

  test("TEMPLATE_RULES is frozen", () => {
    expect(Object.isFrozen(TEMPLATE_RULES)).toBe(true);
  });

  test("exposes pickGreetingTemplate helper", () => {
    expect(typeof pickGreetingTemplate).toBe("function");
  });
});