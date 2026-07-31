"use strict";

/**
 * @file run.test.js
 * @brief Unit tests for the run() orchestrator.
 *
 * The Anthropic SDK is mocked at the module level so no real API calls are
 * made. All tests verify the orchestration logic: config normalization,
 * conversation building, caching header injection, response envelope shape,
 * stats population, and error paths.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mock Anthropic SDK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal mock API response shape mirroring the real Anthropic SDK response.
 */
const makeMockApiResponse = (overrides = {}) => ({
  content:    [{ type: "text", text: "Mock answer." }],
  stop_reason: "end_turn",
  usage: {
    input_tokens:                100,
    output_tokens:               50,
    cache_read_input_tokens:     0,
    cache_creation_input_tokens: 0,
  },
  ...overrides,
});

/** The mock messages.create function — replaced per test via mockResolvedValue. */
const mockCreate = jest.fn();

jest.mock("@anthropic-ai/sdk", () => ({
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Imports (after mock registration)
// ─────────────────────────────────────────────────────────────────────────────

const run          = require("../../src/claude/run");
const Response     = require("../../src/Response");
const Conversation = require("../../src/Conversation");
const Content      = require("../../src/Content");
const Stats        = require("../../src/Stats");
const { StatsItem }  = Stats;
const { Turn }       = Conversation;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const makeConfig = (overrides = {}) => ({
  apiKey:      "sk-test-key",
  model:       "claude-sonnet-4-6",
  max_tokens:  1024,
  temperature: 0.5,
  ...overrides,
});

let consoleErrorSpy;

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  mockCreate.mockResolvedValue(makeMockApiResponse());
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Error paths
// ─────────────────────────────────────────────────────────────────────────────

describe("run — error paths", () => {
  test("missing apiKey — throws with clear message", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(run(makeConfig({ apiKey: undefined }), "Hello"))
      .rejects.toThrow("ANTHROPIC_API_KEY not set");
    spy.mockRestore();
  });

  test("empty string prompt — throws", async () => {
    await expect(run(makeConfig(), "")).rejects.toThrow();
  });

  test("conversation with no turns — throws", async () => {
    const spy  = jest.spyOn(console, "error").mockImplementation(() => {});
    const conv = new Conversation();
    await expect(run(makeConfig(), conv)).rejects.toThrow("Conversation must have at least one turn");
    spy.mockRestore();
  });

  test("last turn is assistant, not user — throws", async () => {
    const spy  = jest.spyOn(console, "error").mockImplementation(() => {});
    const conv = new Conversation("Q");
    conv.push(new Turn("assistant", "A"));
    await expect(run(makeConfig(), conv)).rejects.toThrow("Last conversation turn must be a user turn");
    spy.mockRestore();
  });

  test("SDK error — re-thrown", async () => {
    mockCreate.mockRejectedValue(new Error("API error"));
    await expect(run(makeConfig(), "Hello")).rejects.toThrow("API error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response envelope shape
// ─────────────────────────────────────────────────────────────────────────────

describe("run — response envelope", () => {
  test("returns a Response instance", async () => {
    expect(await run(makeConfig(), "Hello")).toBeInstanceOf(Response);
  });

  test("output.text equals API response text", async () => {
    const r = await run(makeConfig(), "Hello");
    expect(r.output.text).toBe("Mock answer.");
  });

  test("output.success is true", async () => {
    expect((await run(makeConfig(), "Hello")).output.success).toBe(true);
  });

  test("output.stopped equals stop_reason", async () => {
    expect((await run(makeConfig(), "Hello")).output.stopped).toBe("end_turn");
  });

  test("output.stopped is false when stop_reason is falsy", async () => {
    mockCreate.mockResolvedValue(makeMockApiResponse({ stop_reason: null }));
    expect((await run(makeConfig(), "Hello")).output.stopped).toBe(false);
  });

  test("output.json() parses JSON text response", async () => {
    mockCreate.mockResolvedValue(makeMockApiResponse({
      content: [{ type: "text", text: '{"answer":42}' }],
    }));
    expect((await run(makeConfig(), "Hello")).output.json()).toEqual({ answer: 42 });
  });

  test("config assigned to response (safe — no apiKey)", async () => {
    const r = await run(makeConfig(), "Hello");
    expect(r.config).toBeDefined();
    expect(r.config.apiKey).toBeUndefined();
    expect(r.config.model).toBe("claude-sonnet-4-6");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation handling
// ─────────────────────────────────────────────────────────────────────────────

describe("run — conversation", () => {
  test("string prompt — conversation has 2 turns after run (user + assistant)", async () => {
    const r = await run(makeConfig(), "Hello");
    expect(r.conversation.length).toBe(2);
    expect(r.conversation[0].role).toBe("user");
    expect(r.conversation[1].role).toBe("assistant");
  });

  test("assistant turn content equals response text", async () => {
    const r = await run(makeConfig(), "Hello");
    expect(r.conversation[1].content).toBe("Mock answer.");
  });

  test("pre-built Conversation passed through — assistant turn appended", async () => {
    const conv = new Conversation("Q1");
    conv.push(new Turn("assistant", "A1"));
    conv.push(new Turn("user", new Content("Q2")));
    const r = await run(makeConfig(), conv);
    expect(r.conversation.length).toBe(4); // Q1 + A1 + Q2 + A2
    expect(r.conversation.last.role).toBe("assistant");
    expect(r.conversation.last.content).toBe("Mock answer.");
  });

  test("response.conversation is same reference as input conversation", async () => {
    const conv = new Conversation("Hello");
    const r    = await run(makeConfig(), conv);
    expect(r.conversation).toBe(conv);
  });

  test("response.input is the last user turn Content", async () => {
    const r = await run(makeConfig(), "Hello");
    expect(r.input).toBeInstanceOf(Content);
    expect(r.input.prompt.text).toBe("Hello");
  });

  test("prompt + documents — Content has both", async () => {
    const r = await run(makeConfig(), "Summarize", "doc1", "doc2");
    expect(r.input.length).toBe(3); // prompt + 2 docs
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API call shape
// ─────────────────────────────────────────────────────────────────────────────

describe("run — API call shape", () => {
  test("messages.create called once", async () => {
    await run(makeConfig(), "Hello");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test("model and max_tokens forwarded to API", async () => {
    await run(makeConfig({ model: "claude-haiku-4-5-20251001", max_tokens: 512 }), "Hello");
    const params = mockCreate.mock.calls[0][0];
    expect(params.model).toBe("claude-haiku-4-5-20251001");
    expect(params.max_tokens).toBe(512);
  });

  test("apiKey not in modelParams sent to API", async () => {
    await run(makeConfig(), "Hello");
    const params = mockCreate.mock.calls[0][0];
    expect(params.apiKey).toBeUndefined();
  });

  test("pricing not in modelParams sent to API", async () => {
    await run(makeConfig({ pricing: { input: { standard: 3 } } }), "Hello");
    const params = mockCreate.mock.calls[0][0];
    expect(params.pricing).toBeUndefined();
  });

  test("pollInterval not in modelParams sent to API", async () => {
    await run(makeConfig({ pollInterval: 5000 }), "Hello");
    const params = mockCreate.mock.calls[0][0];
    expect(params.pollInterval).toBeUndefined();
  });

  test("messages field is the Conversation array", async () => {
    await run(makeConfig(), "Hello");
    const params = mockCreate.mock.calls[0][0];
    expect(Array.isArray(params.messages)).toBe(true);
    expect(params.messages[0].role).toBe("user");
  });

  test("multi-content text response joined by newline", async () => {
    mockCreate.mockResolvedValue(makeMockApiResponse({
      content: [
        { type: "text", text: "Part one." },
        { type: "text", text: "Part two." },
      ],
    }));
    const r = await run(makeConfig(), "Hello");
    expect(r.output.text).toBe("Part one.\nPart two.");
  });

  test("non-text content blocks filtered out", async () => {
    mockCreate.mockResolvedValue(makeMockApiResponse({
      content: [
        { type: "tool_use", id: "x", name: "search", input: {} },
        { type: "text", text: "Answer." },
      ],
    }));
    expect((await run(makeConfig(), "Hello")).output.text).toBe("Answer.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Caching
// ─────────────────────────────────────────────────────────────────────────────

describe("run — caching", () => {
  test("no cache — caching header not set", async () => {
    const Anthropic = require("@anthropic-ai/sdk").default;
    await run(makeConfig(), "Hello");
    const clientArgs = Anthropic.mock.calls[Anthropic.mock.calls.length - 1][0];
    expect(clientArgs.defaultHeaders).toBeUndefined();
  });

  test("cache enabled — prompt-caching beta header set", async () => {
    const Anthropic = require("@anthropic-ai/sdk").default;
    await run(makeConfig(), { data: "Hello", enableCache: true });
    const clientArgs = Anthropic.mock.calls[Anthropic.mock.calls.length - 1][0];
    expect(clientArgs.defaultHeaders).toEqual({
      "anthropic-beta": "prompt-caching-2024-07-31"
    });
  });

  test("cache hit — stats populated", async () => {
    mockCreate.mockResolvedValue(makeMockApiResponse({
      usage: {
        input_tokens: 100, output_tokens: 50,
        cache_read_input_tokens: 80, cache_creation_input_tokens: 0,
      },
    }));
    const r = await run(makeConfig(), { data: "Hello", enableCache: true });
    expect(r.stats.cacheHit).toBe(true);
    expect(r.stats.cacheMiss).toBe(false);
    expect(r.stats.cachedTokensRead).toBe(80);
  });

  test("cache miss — stats populated", async () => {
    mockCreate.mockResolvedValue(makeMockApiResponse({
      usage: {
        input_tokens: 100, output_tokens: 50,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 600,
      },
    }));
    const r = await run(makeConfig(), { data: "Hello", enableCache: true });
    expect(r.stats.cacheMiss).toBe(true);
    expect(r.stats.cacheHit).toBe(false);
    expect(r.stats.cachedTokensCreated).toBe(600);
  });

  test("no cache — cacheHit and cacheMiss absent from stats", async () => {
    const r = await run(makeConfig(), "Hello");
    expect(r.stats.cacheHit).toBeUndefined();
    expect(r.stats.cacheMiss).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

describe("run — stats", () => {
  test("stats is a StatsItem", async () => {
    expect((await run(makeConfig(), "Hello")).stats).toBeInstanceOf(StatsItem);
  });

  test("inputTokens from API usage", async () => {
    expect((await run(makeConfig(), "Hello")).stats.inputTokens).toBe(100);
  });

  test("outputTokens from API usage", async () => {
    expect((await run(makeConfig(), "Hello")).stats.outputTokens).toBe(50);
  });

  test("duration is a numeric string with 2dp", async () => {
    const { duration } = (await run(makeConfig(), "Hello")).stats;
    expect(typeof duration).toBe("string");
    expect(duration).toMatch(/^\d+\.\d{2}$/);
  });

  test("stats can be accumulated with Stats", async () => {
    const r1 = await run(makeConfig(), "Q1");
    const r2 = await run(makeConfig(), "Q2");
    const stats = new Stats(r1.stats, r2.stats);
    expect(stats.collapse().inputTokens).toBe(200);
  });
});
