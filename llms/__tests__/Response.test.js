"use strict";

/**
 * @file Response.test.js
 * @brief Unit tests for the Response normalized API response container.
 *
 * Covers construction, input resolution from conversation, output.json(),
 * stats coercion via toStats, toString composition, Response.create factory,
 * and frozen export.
 */

const Response      = require("../src/Response");
const Stats         = require("../src/Stats");
const Content       = require("../src/Content");
const Conversation  = require("../src/Conversation");
const { StatsItem } = Stats;
const { Turn }      = Conversation;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const makeConfig = (overrides = {}) => ({
  model:      "claude-sonnet-4-6",
  max_tokens: 1024,
  toString()  { return "\n⚙️  Config:\n─────────────────────────────────────\n   model: claude-sonnet-4-6\n"; },
  ...overrides,
});

const makeConversation = (userText = "What is Legionella?", assistantText = "It is a bacterium.") => {
  const conv = new Conversation(userText);
  conv.push(new Turn("assistant", assistantText));
  return conv;
};

const makeOutput = (overrides = {}) => ({
  success: true,
  text:    "It is a bacterium.",
  stopped: "end_turn",
  ...overrides,
});

const makeStatsItem = (overrides = {}) => new StatsItem({
  duration:     "1.23",
  inputTokens:  100,
  outputTokens: 50,
  cache:        false,
  ...overrides,
});

const makeData = (overrides = {}) => ({
  config:       makeConfig(),
  conversation: makeConversation(),
  output:       makeOutput(),
  stats:        makeStatsItem(),
  ...overrides,
});

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
// Construction — basic
// ─────────────────────────────────────────────────────────────────────────────

describe("Response — construction", () => {
  test("config assigned", () => {
    const cfg = makeConfig();
    expect(new Response(makeData({ config: cfg })).config).toBe(cfg);
  });

  test("conversation assigned", () => {
    const conv = makeConversation();
    expect(new Response(makeData({ conversation: conv })).conversation).toBe(conv);
  });

  test("output assigned as spread copy — fields preserved", () => {
    const r = new Response(makeData());
    expect(r.output.success).toBe(true);
    expect(r.output.text).toBe("It is a bacterium.");
    expect(r.output.stopped).toBe("end_turn");
  });

  test("output is a copy — not same reference as input output", () => {
    const data = makeData();
    expect(new Response(data).output).not.toBe(data.output);
  });

  test("output.stopped accessible directly", () => {
    expect(new Response(makeData()).output.stopped).toBe("end_turn");
  });

  test("output.success accessible directly", () => {
    expect(new Response(makeData()).output.success).toBe(true);
  });

  test("output.error preserved when present", () => {
    const r = new Response(makeData({ output: makeOutput({ error: "something failed" }) }));
    expect(r.output.error).toBe("something failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// input resolution from conversation
// ─────────────────────────────────────────────────────────────────────────────

describe("Response — input resolution", () => {
  test("input resolved from explicit data.input", () => {
    const content = new Content("Explicit input");
    expect(new Response(makeData({ input: content })).input).toBe(content);
  });

  test("input resolved from last user turn in conversation", () => {
    const conv = makeConversation("My question");
    const r    = new Response(makeData({ conversation: conv }));
    expect(r.input).toBeInstanceOf(Content);
    expect(r.input.prompt.text).toBe("My question");
  });

  test("input resolved from last user turn — multi-turn conversation", () => {
    const conv = new Conversation("First question");
    conv.push(new Turn("assistant", "First answer"));
    conv.push(new Turn("user",      new Content("Second question")));
    conv.push(new Turn("assistant", "Second answer"));
    const r = new Response(makeData({ conversation: conv }));
    expect(r.input.prompt.text).toBe("Second question");
  });

  test("explicit input takes precedence over conversation scan", () => {
    const explicit = new Content("Explicit");
    const conv     = makeConversation("From conversation");
    const r        = new Response(makeData({ input: explicit, conversation: conv }));
    expect(r.input).toBe(explicit);
  });

  test("conversation with no user turns — input is undefined", () => {
    const conv = new Conversation();
    conv.push(new Turn("assistant", "Unprompted reply"));
    const r = new Response(makeData({ conversation: conv }));
    expect(r.input).toBeUndefined();
  });

  test("conversation with no user turns — toString does not throw", () => {
    const conv = new Conversation();
    conv.push(new Turn("assistant", "Unprompted reply"));
    const r = new Response(makeData({ conversation: conv }));
    expect(() => String(r)).not.toThrow();
  });

  test("conversation with no user turns — no content section in toString", () => {
    const conv = new Conversation();
    conv.push(new Turn("assistant", "Unprompted reply"));
    const r = new Response(makeData({ conversation: conv }));
    expect(String(r)).not.toContain("➡️  Input Content:");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stats coercion — toStats
// ─────────────────────────────────────────────────────────────────────────────

describe("Response — stats coercion", () => {
  test("StatsItem passed through as-is", () => {
    const item = makeStatsItem();
    expect(new Response(makeData({ stats: item })).stats).toBe(item);
  });

  test("Stats instance passed through as-is", () => {
    const statsCol = new Stats(makeStatsItem());
    expect(new Response(makeData({ stats: statsCol })).stats).toBe(statsCol);
  });

  test("plain object wrapped in StatsItem", () => {
    const r = new Response(makeData({ stats: { duration: "1.00", inputTokens: 10, outputTokens: 5 } }));
    expect(r.stats).toBeInstanceOf(StatsItem);
    expect(r.stats.inputTokens).toBe(10);
  });

  test("array wrapped in Stats", () => {
    const r = new Response(makeData({ stats: [makeStatsItem(), makeStatsItem()] }));
    expect(r.stats).toBeInstanceOf(Stats);
    expect(r.stats.length).toBe(2);
  });

  test("empty array wrapped in empty Stats", () => {
    const r = new Response(makeData({ stats: [] }));
    expect(r.stats).toBeInstanceOf(Stats);
    expect(r.stats.length).toBe(0);
  });

  test("null wrapped in StatsItem with defaults", () => {
    const r = new Response(makeData({ stats: null }));
    expect(r.stats).toBeInstanceOf(StatsItem);
    expect(r.stats.inputTokens).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// output.json()
// ─────────────────────────────────────────────────────────────────────────────

describe("Response — output.json()", () => {
  test("json() present on output as a function", () => {
    expect(typeof new Response(makeData()).output.json).toBe("function");
  });

  test("json() is non-enumerable", () => {
    expect(Object.keys(new Response(makeData()).output)).not.toContain("json");
  });

  test("json() parses valid JSON object", () => {
    const r = new Response(makeData({ output: makeOutput({ text: '{"key":"value"}' }) }));
    expect(r.output.json()).toEqual({ key: "value" });
  });

  test("json() parses valid JSON array", () => {
    const r = new Response(makeData({ output: makeOutput({ text: '[1,2,3]' }) }));
    expect(r.output.json()).toEqual([1, 2, 3]);
  });

  test("json() returns null on invalid JSON", () => {
    const r = new Response(makeData({ output: makeOutput({ text: "not json" }) }));
    expect(r.output.json()).toBeNull();
  });

  test("json() returns null when text is undefined", () => {
    const r = new Response(makeData({ output: makeOutput({ text: undefined }) }));
    expect(r.output.json()).toBeNull();
  });

  test("json() handles markdown-fenced JSON", () => {
    const r = new Response(makeData({ output: makeOutput({ text: '```json\n{"a":1}\n```' }) }));
    expect(r.output.json()).toEqual({ a: 1 });
  });

  test("json() handles trailing commentary", () => {
    const r = new Response(makeData({ output: makeOutput({ text: '[{"a":1}]\n\n**Note:** done' }) }));
    expect(r.output.json()).toEqual([{ a: 1 }]);
  });

  test("json() works on success:false response — parses text regardless", () => {
    const r = new Response(makeData({ output: makeOutput({ success: false, text: '{"error":"oops"}' }) }));
    expect(r.output.json()).toEqual({ error: "oops" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toString
// ─────────────────────────────────────────────────────────────────────────────

describe("Response — toString", () => {
  test("contains response received header", () => {
    expect(String(new Response(makeData()))).toContain("✅ Response received");
  });

  test("end_turn stop reason — checkmark prefix", () => {
    expect(String(new Response(makeData()))).toContain("✅ Stopped: end_turn");
  });

  test("non-end_turn stop reason — warning prefix", () => {
    const r = new Response(makeData({ output: makeOutput({ stopped: "max_tokens" }) }));
    expect(String(r)).toContain("⚠️");
    expect(String(r)).toContain("max_tokens");
  });

  test("no stopped line when stopped is falsy", () => {
    const r = new Response(makeData({ output: makeOutput({ stopped: false }) }));
    expect(String(r)).not.toContain("Stopped:");
  });

  test("caching ENABLED line when StatsItem.cache is true", () => {
    const r = new Response(makeData({ stats: makeStatsItem({ cache: true }) }));
    expect(String(r)).toContain("⚡ Caching: ENABLED");
  });

  test("no caching line when cache is false", () => {
    expect(String(new Response(makeData()))).not.toContain("Caching: ENABLED");
  });

  test("Stats collection — collapsed for cache flag, mixed items", () => {
    const statsCol = new Stats(
      makeStatsItem({ cache: false }),
      makeStatsItem({ cache: true }),
    );
    expect(String(new Response(makeData({ stats: statsCol })))).toContain("⚡ Caching: ENABLED");
  });

  test("contains config toString output", () => {
    expect(String(new Response(makeData()))).toContain("⚙️  Config:");
  });

  test("contains content toString output when input present", () => {
    expect(String(new Response(makeData()))).toContain("➡️  Input Content:");
  });

  test("contains stats toString output", () => {
    expect(String(new Response(makeData()))).toContain("💰 Token Usage:");
  });

  test("toString is non-enumerable", () => {
    expect(Object.getOwnPropertyDescriptor(new Response(makeData()), "toString").enumerable).toBe(false);
  });

  test("toString does not contain apiKey even if config has one", () => {
    const config = { ...makeConfig(), apiKey: "sk-secret", toString() { return "\n⚙️  Config:\n─────────────────────────────────────\n"; } };
    expect(String(new Response(makeData({ config })))).not.toContain("sk-secret");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response.create factory
// ─────────────────────────────────────────────────────────────────────────────

describe("Response.create", () => {
  test("returns a Response instance", () => {
    expect(Response.create(makeData())).toBeInstanceOf(Response);
  });

  test("equivalent to new Response(data)", () => {
    const data = makeData();
    const a    = new Response(data);
    const b    = Response.create(data);
    expect(a.output.text).toBe(b.output.text);
    expect(a.config).toBe(b.config);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frozen export
// ─────────────────────────────────────────────────────────────────────────────

describe("Response — frozen export", () => {
  test("frozen — cannot add properties to export", () => {
    expect(() => { Response.foo = 1; }).toThrow();
  });

  test("named export matches default", () => {
    expect(Response.Response).toBe(Response);
  });

  test("Response.create attached", () => {
    expect(typeof Response.create).toBe("function");
  });
});