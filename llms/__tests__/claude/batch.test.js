"use strict";

/**
 * @file batch.test.js
 * @brief Unit tests for the batch() orchestrator.
 *
 * The Anthropic SDK and Spinner are mocked at the module level so no real API
 * calls are made. All tests verify orchestration logic: batch submission,
 * polling, result collection, response envelope shape, stats population,
 * succeeded/errored counts, and error paths.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mock Anthropic SDK
// ─────────────────────────────────────────────────────────────────────────────

const makeMockBatchJob = (overrides = {}) => ({
  id: "batch_job_test_123",
  processing_status: "ended",
  request_counts: { processing: 0, succeeded: 2, errored: 0, canceled: 0 },
  ...overrides,
});

const makeMockResultSucceeded = (customId, text = "Mock answer.", usageOverrides = {}) => ({
  custom_id: customId,
  result: {
    type: "succeeded",
    message: {
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        ...usageOverrides,
      },
    },
  },
});

const makeMockResultErrored = (customId, errorMessage = "Something went wrong") => ({
  custom_id: customId,
  result: {
    type: "errored",
    error: { message: errorMessage },
  },
});

// Returns a Promise resolving to an async iterable, matching the real SDK shape.
const createAsyncIterable = (results) =>
  Promise.resolve({
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: async () =>
          index < results.length
            ? { value: results[index++], done: false }
            : { done: true },
      };
    },
  });

const mockBatchCreate   = jest.fn();
const mockBatchRetrieve = jest.fn();
const mockBatchResults  = jest.fn();

jest.mock("@anthropic-ai/sdk", () => ({
  default: jest.fn().mockImplementation(() => ({
    beta: {
      messages: {
        batches: {
          create:   mockBatchCreate,
          retrieve: mockBatchRetrieve,
          results:  mockBatchResults,
        },
      },
    },
  })),
}));

// Spinner does nothing in tests.
jest.mock("../../src/utilities/spinner", () => ({
  create: () => ({ start: () => ({ stop: () => {} }) }),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Imports (after mock registration)
// ─────────────────────────────────────────────────────────────────────────────

const batch         = require("../../src/claude/batch");
const Pricing       = require("../../src/claude/Pricing");
const Response      = require("../../src/Response");
const Conversation  = require("../../src/Conversation");
const Content       = require("../../src/Content");
const Stats         = require("../../src/Stats");
const { StatsItem } = Stats;
const { Turn }      = Conversation;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const makeConfig = (overrides = {}) => ({
  apiKey:       "sk-test-key",
  model:        "claude-sonnet-4-6",
  max_tokens:   1024,
  temperature:  0.5,
  pollInterval: 10, // Short for tests
  ...overrides,
});

// Registers default mock results for a given set of IDs.
const setupResults = (ids, text = "Mock answer.") => {
  mockBatchResults.mockImplementation(() =>
    createAsyncIterable(ids.map(id => makeMockResultSucceeded(id, text)))
  );
};

let consoleErrorSpy;
let consoleWarnSpy;
let consoleLogSpy;

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  consoleWarnSpy  = jest.spyOn(console, "warn").mockImplementation(() => {});
  consoleLogSpy   = jest.spyOn(console, "log").mockImplementation(() => {});

  mockBatchCreate.mockResolvedValue(makeMockBatchJob({ processing_status: "in_progress" }));
  mockBatchRetrieve.mockResolvedValue(makeMockBatchJob({ processing_status: "ended" }));
  setupResults(["req-1", "req-2"]);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleLogSpy.mockRestore();
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Error paths
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — error paths", () => {
  test("missing apiKey — throws with clear message", async () => {
    await expect(
      batch(makeConfig({ apiKey: undefined }), { id: "req-1", prompt: "Hello" })
    ).rejects.toThrow("ANTHROPIC_API_KEY not set");
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test("empty requests array — returns [] immediately without calling the API", async () => {
    const responses = await batch(makeConfig());
    expect(responses).toEqual([]);
    expect(mockBatchCreate).not.toHaveBeenCalled();
  });

  test("request missing id — throws before any API call", async () => {
    await expect(
      batch(makeConfig(), { prompt: "No ID here" })
    ).rejects.toThrow("unique 'id' field");
    expect(mockBatchCreate).not.toHaveBeenCalled();
  });

  test("duplicate request id — throws before any API call", async () => {
    await expect(
      batch(
        makeConfig(),
        { id: "dup", prompt: "First" },
        { id: "dup", prompt: "Second" }
      )
    ).rejects.toThrow("Duplicate batch request ID: dup");
    expect(mockBatchCreate).not.toHaveBeenCalled();
  });

  test("SDK batch create error — re-thrown", async () => {
    mockBatchCreate.mockRejectedValue(new Error("Batch creation failed"));
    await expect(
      batch(makeConfig(), { id: "req-1", prompt: "Hello" })
    ).rejects.toThrow("Batch creation failed");
  });

  test("polling error exceeding retry limit — throws", async () => {
    mockBatchCreate.mockResolvedValue(makeMockBatchJob({ processing_status: "in_progress" }));
    mockBatchRetrieve.mockRejectedValue(new Error("Network error"));
    await expect(
      batch(makeConfig({ pollInterval: 1 }), { id: "req-1", prompt: "Hello" })
    ).rejects.toThrow(/Batch polling failed/);
  }, 30_000); // needs 11+ retrieve attempts with backoff before throwing
});

// ─────────────────────────────────────────────────────────────────────────────
// Request normalization
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — request normalization", () => {
  test("single request object", async () => {
    setupResults(["single"]);
    const responses = await batch(makeConfig(), { id: "single", prompt: "Hello" });
    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe("single");
    expect(responses[0].output.text).toBe("Mock answer.");
  });

  test("variadic arguments", async () => {
    const ids = ["v1", "v2", "v3"];
    setupResults(ids);
    const responses = await batch(
      makeConfig(),
      { id: ids[0], prompt: "A" },
      { id: ids[1], prompt: "B" },
      { id: ids[2], prompt: "C" }
    );
    expect(responses).toHaveLength(3);
    ids.forEach((id, i) => expect(responses[i].id).toBe(id));
  });

  test("nested array flattened", async () => {
    const ids = ["n1", "n2", "n3"];
    setupResults(ids);
    const responses = await batch(
      makeConfig(),
      [{ id: ids[0], prompt: "A" }, { id: ids[1], prompt: "B" }],
      { id: ids[2], prompt: "C" }
    );
    expect(responses).toHaveLength(3);
  });

  test("deeply nested array flattened", async () => {
    const ids = ["d1", "d2"];
    setupResults(ids);
    const responses = await batch(
      makeConfig(),
      [[{ id: ids[0], prompt: "A" }], [{ id: ids[1], prompt: "B" }]]
    );
    expect(responses).toHaveLength(2);
  });

  test("documents array passed through to Content", async () => {
    setupResults(["doc-req"]);
    const responses = await batch(
      makeConfig(),
      { id: "doc-req", prompt: "Summarize", documents: ["doc1", "doc2"] }
    );
    // prompt + 2 documents = 3 Content items
    expect(responses[0].input.length).toBe(3);
  });

  test("pre-built Conversation preserved, assistant turn appended", async () => {
    const conv = new Conversation("Q1");
    conv.push(new Turn("assistant", "A1"));
    conv.push(new Turn("user", new Content("Q2")));

    setupResults(["conv-req"]);
    const responses = await batch(makeConfig(), { id: "conv-req", prompt: conv });

    // Q1 + A1 + Q2 + A2(appended)
    expect(responses[0].conversation.length).toBe(4);
    expect(responses[0].conversation.last.role).toBe("assistant");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch submission — params forwarding
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — submission params", () => {
  test("model, max_tokens, temperature forwarded", async () => {
    const ids = ["p1", "p2"];
    setupResults(ids);
    await batch(
      makeConfig({ model: "claude-haiku-4-5-20251001", max_tokens: 512, temperature: 0.8 }),
      { id: ids[0], prompt: "A" },
      { id: ids[1], prompt: "B" }
    );
    const { requests } = mockBatchCreate.mock.calls[0][0];
    expect(requests[0].params.model).toBe("claude-haiku-4-5-20251001");
    expect(requests[0].params.max_tokens).toBe(512);
    expect(requests[0].params.temperature).toBe(0.8);
  });

  test("system prompt forwarded in params", async () => {
    setupResults(["sys-req"]);
    await batch(
      makeConfig({ system: "You are a helpful assistant." }),
      { id: "sys-req", prompt: "Hello" }
    );
    const { requests } = mockBatchCreate.mock.calls[0][0];
    expect(requests[0].params.system).toBe("You are a helpful assistant.");
  });

  test("tools and tool_choice forwarded in params", async () => {
    const tools      = [{ name: "search", description: "Search the web", input_schema: { type: "object", properties: {} } }];
    const tool_choice = { type: "auto" };
    setupResults(["tools-req"]);
    await batch(
      makeConfig({ tools, tool_choice }),
      { id: "tools-req", prompt: "Hello" }
    );
    const { requests } = mockBatchCreate.mock.calls[0][0];
    expect(requests[0].params.tools).toEqual(tools);
    expect(requests[0].params.tool_choice).toEqual(tool_choice);
  });

  test("stop_sequences forwarded in params", async () => {
    setupResults(["stop-req"]);
    await batch(
      makeConfig({ stop_sequences: ["\n\nHuman:"] }),
      { id: "stop-req", prompt: "Hello" }
    );
    const { requests } = mockBatchCreate.mock.calls[0][0];
    expect(requests[0].params.stop_sequences).toEqual(["\n\nHuman:"]);
  });

  test("apiKey never forwarded in params", async () => {
    setupResults(["apikey-req"]);
    await batch(makeConfig(), { id: "apikey-req", prompt: "Hello" });
    const { requests } = mockBatchCreate.mock.calls[0][0];
    expect(requests[0].params.apiKey).toBeUndefined();
  });

  test("pollInterval and pricing not forwarded in params", async () => {
    setupResults(["strip-req"]);
    await batch(makeConfig({ pollInterval: 999, pricing: { input: { standard: 3 } } }), { id: "strip-req", prompt: "Hello" });
    const { requests } = mockBatchCreate.mock.calls[0][0];
    expect(requests[0].params.pollInterval).toBeUndefined();
    expect(requests[0].params.pricing).toBeUndefined();
  });

  test("each request gets its own messages array", async () => {
    const ids = ["msg1", "msg2"];
    setupResults(ids);
    await batch(
      makeConfig(),
      { id: ids[0], prompt: "First" },
      { id: ids[1], prompt: "Second" }
    );
    const { requests } = mockBatchCreate.mock.calls[0][0];
    expect(requests[0].custom_id).toBe(ids[0]);
    expect(requests[1].custom_id).toBe(ids[1]);
    expect(requests[0].params.messages[0].role).toBe("user");
    expect(requests[1].params.messages[0].role).toBe("user");
  });

  test("batch ID logged to console", async () => {
    const batchId = "batch_xyz_123";
    mockBatchCreate.mockResolvedValue(
      makeMockBatchJob({ id: batchId, processing_status: "in_progress" })
    );
    setupResults(["log-req"]);
    await batch(makeConfig(), { id: "log-req", prompt: "Hello" });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining(batchId));
  });

  test("singular 'request' in log for 1 item", async () => {
    setupResults(["sing-req"]);
    await batch(makeConfig(), { id: "sing-req", prompt: "Hello" });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("1 request..."));
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining("1 requests"));
  });

  test("plural 'requests' in log for multiple items", async () => {
    const ids = ["pl1", "pl2"];
    setupResults(ids);
    await batch(makeConfig(), { id: ids[0], prompt: "A" }, { id: ids[1], prompt: "B" });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("2 requests..."));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Polling behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — polling", () => {
  test("polls until status is 'ended'", async () => {
    setupResults(["poll-req"]);
    mockBatchCreate.mockResolvedValue(makeMockBatchJob({ processing_status: "in_progress" }));
    mockBatchRetrieve
      .mockResolvedValueOnce(makeMockBatchJob({ processing_status: "in_progress" }))
      .mockResolvedValueOnce(makeMockBatchJob({ processing_status: "in_progress" }))
      .mockResolvedValueOnce(makeMockBatchJob({ processing_status: "ended" }));

    await batch(makeConfig({ pollInterval: 1 }), { id: "poll-req", prompt: "Hello" });
    expect(mockBatchRetrieve).toHaveBeenCalledTimes(3);
  });

  test("skips polling entirely when batch is already ended on create", async () => {
    mockBatchCreate.mockResolvedValue(makeMockBatchJob({ processing_status: "ended" }));
    setupResults(["ended-req"]);
    await batch(makeConfig(), { id: "ended-req", prompt: "Hello" });
    expect(mockBatchRetrieve).not.toHaveBeenCalled();
  });

  test("onPoll callback called each retrieve cycle", async () => {
    const onPoll = jest.fn();
    mockBatchCreate.mockResolvedValue(makeMockBatchJob({ processing_status: "in_progress" }));
    mockBatchRetrieve
      .mockResolvedValueOnce(makeMockBatchJob({ processing_status: "in_progress", request_counts: { processing: 5 } }))
      .mockResolvedValueOnce(makeMockBatchJob({ processing_status: "ended",      request_counts: { succeeded: 1 } }));
    setupResults(["onpoll-req"]);

    await batch(makeConfig({ pollInterval: 1, onPoll }), { id: "onpoll-req", prompt: "Hello" });

    expect(onPoll).toHaveBeenCalledTimes(2);
    expect(onPoll).toHaveBeenNthCalledWith(1, expect.objectContaining({ request_counts: expect.objectContaining({ processing: 5 }) }));
    expect(onPoll).toHaveBeenNthCalledWith(2, expect.objectContaining({ request_counts: expect.objectContaining({ succeeded: 1 }) }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response envelope shape
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — response envelope", () => {
  test("returns array of Response instances in submission order", async () => {
    const ids = ["r1", "r2"];
    setupResults(ids);
    const responses = await batch(
      makeConfig(),
      { id: ids[0], prompt: "A" },
      { id: ids[1], prompt: "B" }
    );
    expect(responses).toHaveLength(2);
    expect(responses[0]).toBeInstanceOf(Response);
    expect(responses[1]).toBeInstanceOf(Response);
    expect(responses[0].id).toBe(ids[0]);
    expect(responses[1].id).toBe(ids[1]);
  });

  test("output.text equals API response text", async () => {
    setupResults(["req-1", "req-2"]);
    const responses = await batch(
      makeConfig(),
      { id: "req-1", prompt: "A" },
      { id: "req-2", prompt: "B" }
    );
    expect(responses[0].output.text).toBe("Mock answer.");
    expect(responses[1].output.text).toBe("Mock answer.");
  });

  test("output.success is true for succeeded", async () => {
    setupResults(["req-1"]);
    const responses = await batch(makeConfig(), { id: "req-1", prompt: "Hello" });
    expect(responses[0].output.success).toBe(true);
  });

  test("output.success is false for errored, error message populated", async () => {
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([makeMockResultErrored("err-req", "Rate limit exceeded")])
    );
    const responses = await batch(makeConfig(), { id: "err-req", prompt: "Hello" });
    expect(responses[0].output.success).toBe(false);
    expect(responses[0].output.error).toBe("Rate limit exceeded");
  });

  test("output.stopped equals stop_reason", async () => {
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([makeMockResultSucceeded("stop-req", "Answer", { stop_reason: "max_tokens" })])
    );
    // stop_reason is inside message, not usageOverrides — rebuild manually
    mockBatchResults.mockImplementationOnce(() =>
      createAsyncIterable([{
        custom_id: "stop-req",
        result: {
          type: "succeeded",
          message: {
            content: [{ type: "text", text: "Answer" }],
            stop_reason: "max_tokens",
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
      }])
    );
    const responses = await batch(makeConfig(), { id: "stop-req", prompt: "Hello" });
    expect(responses[0].output.stopped).toBe("max_tokens");
  });

  test("config on response is safe — no apiKey", async () => {
    setupResults(["safe-req"]);
    const responses = await batch(makeConfig(), { id: "safe-req", prompt: "Hello" });
    expect(responses[0].config.apiKey).toBeUndefined();
    expect(responses[0].config.model).toBe("claude-sonnet-4-6");
  });

  test("errored result — error type used as fallback when no error.message", async () => {
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([{ custom_id: "cancel-req", result: { type: "canceled" } }])
    );
    const responses = await batch(makeConfig(), { id: "cancel-req", prompt: "Hello" });
    expect(responses[0].output.error).toBe("canceled");
    expect(responses[0].output.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation handling
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — conversation", () => {
  test("conversation has 2 turns after batch (user + assistant)", async () => {
    setupResults(["req-1"]);
    const responses = await batch(makeConfig(), { id: "req-1", prompt: "Hello" });
    expect(responses[0].conversation.length).toBe(2);
    expect(responses[0].conversation[0].role).toBe("user");
    expect(responses[0].conversation[1].role).toBe("assistant");
  });

  test("assistant turn content equals response text", async () => {
    const expectedText = "The answer is 42.";
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([makeMockResultSucceeded("asst-req", expectedText)])
    );
    const responses = await batch(makeConfig(), { id: "asst-req", prompt: "Hello" });
    expect(responses[0].conversation[1].content).toBe(expectedText);
  });

  test("response.input is the last user turn Content", async () => {
    setupResults(["input-req"]);
    const responses = await batch(makeConfig(), { id: "input-req", prompt: "Hello" });
    expect(responses[0].input).toBeInstanceOf(Content);
    // Content.prompt is the first Item; Item has a .text property for text items
    expect(responses[0].input.prompt.text).toBe("Hello");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-content text handling
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — multi-content text handling", () => {
  test("multiple text blocks joined by newline", async () => {
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([{
        custom_id: "multi-req",
        result: {
          type: "succeeded",
          message: {
            content: [
              { type: "text", text: "Part one." },
              { type: "text", text: "Part two." },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
      }])
    );
    const responses = await batch(makeConfig(), { id: "multi-req", prompt: "Hello" });
    expect(responses[0].output.text).toBe("Part one.\nPart two.");
  });

  test("non-text content blocks filtered out", async () => {
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([{
        custom_id: "filter-req",
        result: {
          type: "succeeded",
          message: {
            content: [
              { type: "tool_use", id: "x", name: "search", input: {} },
              { type: "text", text: "Answer here." },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
      }])
    );
    const responses = await batch(makeConfig(), { id: "filter-req", prompt: "Hello" });
    expect(responses[0].output.text).toBe("Answer here.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stats — token counts and shape
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — stats", () => {
  test("stats is a StatsItem", async () => {
    setupResults(["req-1"]);
    const responses = await batch(makeConfig(), { id: "req-1", prompt: "Hello" });
    expect(responses[0].stats).toBeInstanceOf(StatsItem);
  });

  test("inputTokens and outputTokens from API usage", async () => {
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([
        makeMockResultSucceeded("tok-req", "Answer", { input_tokens: 250, output_tokens: 75 })
      ])
    );
    const responses = await batch(makeConfig(), { id: "tok-req", prompt: "Hello" });
    expect(responses[0].stats.inputTokens).toBe(250);
    expect(responses[0].stats.outputTokens).toBe(75);
  });

  test("duration is a numeric string with 2 decimal places", async () => {
    setupResults(["req-1"]);
    const responses = await batch(makeConfig(), { id: "req-1", prompt: "Hello" });
    expect(typeof responses[0].stats.duration).toBe("string");
    expect(responses[0].stats.duration).toMatch(/^\d+\.\d{2}$/);
  });

  test("zero tokens for errored requests", async () => {
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([makeMockResultErrored("err-tok", "API error")])
    );
    const responses = await batch(makeConfig(), { id: "err-tok", prompt: "Hello" });
    expect(responses[0].stats.inputTokens).toBe(0);
    expect(responses[0].stats.outputTokens).toBe(0);
  });

  test("stats can be accumulated with Stats.collapse()", async () => {
    setupResults(["req-1", "req-2"]);
    const responses = await batch(
      makeConfig(),
      { id: "req-1", prompt: "A" },
      { id: "req-2", prompt: "B" }
    );
    const collapsed = new Stats(responses[0].stats, responses[1].stats).collapse();
    expect(collapsed.inputTokens).toBe(200);  // 100 + 100
    expect(collapsed.outputTokens).toBe(100); // 50  + 50
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stats — succeeded/errored counts (fix #2)
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — stats succeeded/errored counts", () => {
  test("succeeded request has succeeded:1 errored:0", async () => {
    setupResults(["req-1"]);
    const responses = await batch(makeConfig(), { id: "req-1", prompt: "Hello" });
    expect(responses[0].stats.succeeded).toBe(1);
    expect(responses[0].stats.errored).toBe(0);
  });

  test("API-errored request has succeeded:0 errored:1", async () => {
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([makeMockResultErrored("err-req", "API error")])
    );
    const responses = await batch(makeConfig(), { id: "err-req", prompt: "Hello" });
    expect(responses[0].stats.succeeded).toBe(0);
    expect(responses[0].stats.errored).toBe(1);
  });

  test("missing result has succeeded:0 errored:1", async () => {
    // Return results for a different ID so req-1 is missing
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([makeMockResultSucceeded("other-id", "Answer")])
    );
    const responses = await batch(makeConfig(), { id: "req-1", prompt: "Hello" });
    expect(responses[0].stats.succeeded).toBe(0);
    expect(responses[0].stats.errored).toBe(1);
  });

  test("Stats.collapse() sums succeeded and errored across mixed batch", async () => {
    const ids = ["ok-1", "err-1", "ok-2"];
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([
        makeMockResultSucceeded(ids[0], "Success 1"),
        makeMockResultErrored(ids[1], "Fail"),
        makeMockResultSucceeded(ids[2], "Success 2"),
      ])
    );
    const responses = await batch(
      makeConfig(),
      { id: ids[0], prompt: "A" },
      { id: ids[1], prompt: "B" },
      { id: ids[2], prompt: "C" }
    );

    const collapsed = new Stats(...responses.map(r => r.stats)).collapse();
    expect(collapsed.succeeded).toBe(2);
    expect(collapsed.errored).toBe(1);
  });

  test("collapsed stats shows batch formatting in toString", async () => {
    setupResults(["req-1", "req-2"]);
    const responses = await batch(
      makeConfig(),
      { id: "req-1", prompt: "A" },
      { id: "req-2", prompt: "B" }
    );
    const collapsed = new Stats(...responses.map(r => r.stats)).collapse();
    const str = String(collapsed);
    // isBatch path in StatsItem.toString uses succeeded/errored fields
    expect(str).toContain("Requests:");
    expect(str).toContain("succeeded");
    expect(str).toContain("errored");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Caching
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — caching", () => {
  test("cache hit — cacheHit:true, cachedTokensRead populated", async () => {
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([
        makeMockResultSucceeded("cache-hit", "Answer", {
          cache_read_input_tokens: 80, cache_creation_input_tokens: 0,
        })
      ])
    );
    const responses = await batch(
      makeConfig(),
      { id: "cache-hit", prompt: { data: "Hello", enableCache: true } }
    );
    expect(responses[0].stats.cacheHit).toBe(true);
    expect(responses[0].stats.cacheMiss).toBe(false);
    expect(responses[0].stats.cachedTokensRead).toBe(80);
  });

  test("cache miss — cacheMiss:true, cachedTokensCreated populated", async () => {
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([
        makeMockResultSucceeded("cache-miss", "Answer", {
          cache_read_input_tokens: 0, cache_creation_input_tokens: 600,
        })
      ])
    );
    const responses = await batch(
      makeConfig(),
      { id: "cache-miss", prompt: { data: "Hello", enableCache: true } }
    );
    expect(responses[0].stats.cacheMiss).toBe(true);
    expect(responses[0].stats.cacheHit).toBe(false);
    expect(responses[0].stats.cachedTokensCreated).toBe(600);
  });

  test("no cache — cacheHit and cacheMiss absent from stats", async () => {
    setupResults(["no-cache"]);
    const responses = await batch(makeConfig(), { id: "no-cache", prompt: "Hello" });
    expect(responses[0].stats.cacheHit).toBeUndefined();
    expect(responses[0].stats.cacheMiss).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mixed success/error results
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — mixed results", () => {
  test("handles mix of succeeded and errored, preserves submission order", async () => {
    const ids = ["ok-req", "err-req", "ok2-req"];
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([
        makeMockResultSucceeded(ids[0], "Success answer."),
        makeMockResultErrored(ids[1], "Rate limit hit"),
        makeMockResultSucceeded(ids[2], "Another success."),
      ])
    );
    const responses = await batch(
      makeConfig(),
      { id: ids[0], prompt: "A" },
      { id: ids[1], prompt: "B" },
      { id: ids[2], prompt: "C" }
    );
    expect(responses[0].output.success).toBe(true);
    expect(responses[0].output.text).toBe("Success answer.");
    expect(responses[1].output.success).toBe(false);
    expect(responses[1].output.error).toBe("Rate limit hit");
    expect(responses[2].output.success).toBe(true);
    expect(responses[2].output.text).toBe("Another success.");
  });

  test("missing result produces error response without throwing", async () => {
    // Return results for only one of two submitted requests
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([makeMockResultSucceeded("ok-req", "Found.")])
    );
    const responses = await batch(
      makeConfig(),
      { id: "ok-req",      prompt: "A" },
      { id: "missing-req", prompt: "B" }
    );
    expect(responses).toHaveLength(2);
    expect(responses[0].output.success).toBe(true);
    expect(responses[1].output.success).toBe(false);
    expect(responses[1].output.error).toMatch(/No result received/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pricing — cost() function
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — pricing", () => {
  test("pricing enables cost() method on StatsItem", async () => {
    const pricing = new Pricing({
      input:  { standard: 3.00, cacheWrite: 3.75, cacheRead: 0.30 },
      output: { standard: 15.00 },
      batchDiscount: 0.5,
    });
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable([
        makeMockResultSucceeded("pricing-req", "Answer", { input_tokens: 1000, output_tokens: 500 })
      ])
    );
    const responses = await batch(
      makeConfig({ pricing }),
      { id: "pricing-req", prompt: "Hello" }
    );
    expect(typeof responses[0].stats.cost).toBe("function");
    const cost = responses[0].stats.cost();
    expect(cost).toHaveProperty("total");
    expect(cost).toHaveProperty("uncachedInput");
    expect(cost).toHaveProperty("output");
    // 1000 * $3/1M * 0.5 = $0.0015 + 500 * $15/1M * 0.5 = $0.00375 → total $0.00525
    expect(cost.total).toBeCloseTo(0.00525, 5);
  });

  test("without pricing, cost() is not defined on StatsItem", async () => {
    setupResults(["no-pricing-req"]);
    const responses = await batch(
      makeConfig({ pricing: undefined }),
      { id: "no-pricing-req", prompt: "Hello" }
    );
    expect(responses[0].stats.cost).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scale
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — scale", () => {
  test("100 requests submitted and returned in order", async () => {
    const requests = Array.from({ length: 100 }, (_, i) => ({ id: `req-${i}`, prompt: `Prompt ${i}` }));
    mockBatchCreate.mockResolvedValue(makeMockBatchJob({ processing_status: "ended" }));
    mockBatchResults.mockImplementation(() =>
      createAsyncIterable(requests.map(r => makeMockResultSucceeded(r.id, `Answer ${r.id}`)))
    );

    const responses = await batch(makeConfig(), requests);
    expect(responses).toHaveLength(100);
    const { requests: batchRequests } = mockBatchCreate.mock.calls[0][0];
    expect(batchRequests).toHaveLength(100);
    // Order preserved
    responses.forEach((r, i) => expect(r.id).toBe(`req-${i}`));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────────────

describe("batch — module export", () => {
  test("module.exports is frozen", () => {
    expect(Object.isFrozen(batch)).toBe(true);
  });

  test("batch.batch references the same function", () => {
    expect(batch.batch).toBe(batch);
  });
});