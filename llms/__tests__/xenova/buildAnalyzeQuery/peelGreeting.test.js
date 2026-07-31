"use strict";

/**
 * @file peelGreeting.test.js
 * @brief Unit tests for the greeting peeler.
 *
 * Pure function, no mocks. Tests cover:
 *   - Leading greetings with various punctuation
 *   - Trailing greetings with various punctuation
 *   - Mid-query standalone greetings between sentence boundaries
 *   - Greeting-only inputs (cleaned query becomes "")
 *   - Continuation patterns that should NOT peel ("thanks for X")
 *   - Greetings used as content words ("the user said hello")
 *   - Edge inputs (empty, null, single greeting, multiple greetings)
 */

const peelGreeting = require("../../../src/xenova/buildAnalyzeQuery/peelGreeting");

// ─────────────────────────────────────────────────────────────────────────────
// Leading greetings
// ─────────────────────────────────────────────────────────────────────────────

describe("peelGreeting — leading greeting", () => {
  test("'hello, what is pH?' → strips 'hello,', flag true", () => {
    expect(peelGreeting("hello, what is pH?")).toEqual({
      greeting: true,
      query:    "what is pH?",
    });
  });

  test("'hello! what is pH?' → strips 'hello!'", () => {
    expect(peelGreeting("hello! what is pH?")).toEqual({
      greeting: true,
      query:    "what is pH?",
    });
  });

  test("'hi. what is pH?' → strips 'hi.'", () => {
    expect(peelGreeting("hi. what is pH?")).toEqual({
      greeting: true,
      query:    "what is pH?",
    });
  });

  test("'good morning, what is pH?' → strips 'good morning,'", () => {
    expect(peelGreeting("good morning, what is pH?")).toEqual({
      greeting: true,
      query:    "what is pH?",
    });
  });

  test("'thanks! what causes biofilm?' → strips 'thanks!'", () => {
    expect(peelGreeting("thanks! what causes biofilm?")).toEqual({
      greeting: true,
      query:    "what causes biofilm?",
    });
  });

  test("case insensitive", () => {
    expect(peelGreeting("HELLO, what is pH?")).toEqual({
      greeting: true,
      query:    "what is pH?",
    });
  });

  test("'thank you, what is pH?' → strips 'thank you,'", () => {
    expect(peelGreeting("thank you, what is pH?")).toEqual({
      greeting: true,
      query:    "what is pH?",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Trailing greetings
// ─────────────────────────────────────────────────────────────────────────────

describe("peelGreeting — trailing greeting", () => {
  test("'what is pH? thanks!' → strips 'thanks!', keeps '?'", () => {
    expect(peelGreeting("what is pH? thanks!")).toEqual({
      greeting: true,
      query:    "what is pH?",
    });
  });

  test("'what is pH? thanks' → strips 'thanks'", () => {
    expect(peelGreeting("what is pH? thanks")).toEqual({
      greeting: true,
      query:    "what is pH?",
    });
  });

  test("'what is pH. good morning.' → strips trailing greeting", () => {
    expect(peelGreeting("what is pH. good morning.")).toEqual({
      greeting: true,
      query:    "what is pH.",
    });
  });

  test("'what is pH thanks' → does NOT strip (no preceding boundary)", () => {
    // No `!?.,` before "thanks" → can't be sure it's a standalone
    // clause. Preserve as-is. (Real users would write
    // "what is pH? thanks" with the boundary; we don't try to
    // guess.)
    expect(peelGreeting("what is pH thanks")).toEqual({
      greeting: false,
      query:    "what is pH thanks",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mid-query standalone greetings
// ─────────────────────────────────────────────────────────────────────────────

describe("peelGreeting — mid-query standalone greeting", () => {
  test("'hello! what is pH? thanks!' → strips both", () => {
    expect(peelGreeting("hello! what is pH? thanks!")).toEqual({
      greeting: true,
      query:    "what is pH?",
    });
  });

  test("'what is pH? thanks. how about alkalinity?' → strips middle", () => {
    expect(peelGreeting("what is pH? thanks. how about alkalinity?")).toEqual({
      greeting: true,
      query:    "what is pH? how about alkalinity?",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Greeting-only inputs
// ─────────────────────────────────────────────────────────────────────────────

describe("peelGreeting — greeting-only inputs", () => {
  test("'hello' → empty query, flag true", () => {
    expect(peelGreeting("hello")).toEqual({ greeting: true, query: "" });
  });

  test("'hello!' → empty query, flag true", () => {
    expect(peelGreeting("hello!")).toEqual({ greeting: true, query: "" });
  });

  test("'hi there' → empty query, flag true", () => {
    expect(peelGreeting("hi there")).toEqual({ greeting: true, query: "" });
  });

  test("'good morning' → empty query, flag true", () => {
    expect(peelGreeting("good morning")).toEqual({ greeting: true, query: "" });
  });

  test("'thanks.' → empty query, flag true", () => {
    expect(peelGreeting("thanks.")).toEqual({ greeting: true, query: "" });
  });

  test("'thank you' → empty query, flag true", () => {
    expect(peelGreeting("thank you")).toEqual({ greeting: true, query: "" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Continuation patterns — should NOT peel
// ─────────────────────────────────────────────────────────────────────────────

describe("peelGreeting — continuation patterns are not peeled", () => {
  test("'thanks for the info' → no peel", () => {
    // 'thanks for X' is a single conversational utterance. Without
    // tone punctuation after 'thanks', it's a continuation, not
    // standalone greeting + content.
    expect(peelGreeting("thanks for the info")).toEqual({
      greeting: false,
      query:    "thanks for the info",
    });
  });

  test("'hello world how are you' → no peel (no punctuation)", () => {
    // No comma or punctuation gating "hello" as standalone.
    expect(peelGreeting("hello world how are you")).toEqual({
      greeting: false,
      query:    "hello world how are you",
    });
  });

  test("'thanks how do I' → no peel", () => {
    expect(peelGreeting("thanks how do I")).toEqual({
      greeting: false,
      query:    "thanks how do I",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Greetings as content (should NOT peel)
// ─────────────────────────────────────────────────────────────────────────────

describe("peelGreeting — greeting words in content are not peeled", () => {
  test("'the user said hello' → no peel", () => {
    // "hello" is mid-sentence, used as a noun. No peel.
    expect(peelGreeting("the user said hello")).toEqual({
      greeting: false,
      query:    "the user said hello",
    });
  });

  test("'explain why people say hello' → no peel", () => {
    expect(peelGreeting("explain why people say hello")).toEqual({
      greeting: false,
      query:    "explain why people say hello",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge inputs
// ─────────────────────────────────────────────────────────────────────────────

describe("peelGreeting — edge inputs", () => {
  test("empty string → no peel", () => {
    expect(peelGreeting("")).toEqual({ greeting: false, query: "" });
  });

  test("null → no peel", () => {
    expect(peelGreeting(null)).toEqual({ greeting: false, query: "" });
  });

  test("undefined → no peel", () => {
    expect(peelGreeting(undefined)).toEqual({ greeting: false, query: "" });
  });

  test("whitespace only → no peel", () => {
    expect(peelGreeting("   ")).toEqual({ greeting: false, query: "" });
  });

  test("non-greeting content unchanged", () => {
    expect(peelGreeting("what is biofilm?")).toEqual({
      greeting: false,
      query:    "what is biofilm?",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("peelGreeting — module export", () => {
  test("module is frozen", () => {
    expect(Object.isFrozen(peelGreeting)).toBe(true);
  });

  test("self-referential property", () => {
    expect(peelGreeting.peelGreeting).toBe(peelGreeting);
  });
});
