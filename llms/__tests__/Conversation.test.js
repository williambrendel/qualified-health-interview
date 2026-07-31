"use strict";

/**
 * @file Conversation.test.js
 * @brief Unit tests for Turn and Conversation.
 *
 * Covers Turn construction, Conversation.normalize for all input shapes,
 * Conversation construction, continue(), array behavior, and frozen export.
 */

const Conversation = require("../src/Conversation");
const Content      = require("../src/Content");
const { Turn }     = Conversation;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal Response-like object. */
const mockResponse = (text = "Assistant reply") => ({
  output: { text }
});

// ─────────────────────────────────────────────────────────────────────────────
// Turn
// ─────────────────────────────────────────────────────────────────────────────

describe("Turn — construction", () => {
  test("role and content assigned", () => {
    const t = new Turn("user", "Hello");
    expect(t.role).toBe("user");
    expect(t.content).toBe("Hello");
  });

  test("assistant role", () => {
    const t = new Turn("assistant", "Reply");
    expect(t.role).toBe("assistant");
  });

  test("Content instance as content", () => {
    const content = new Content("Hello");
    const t = new Turn("user", content);
    expect(t.content).toBe(content);
  });

  test("role and content are enumerable", () => {
    const t = new Turn("user", "Hello");
    expect(Object.keys(t)).toContain("role");
    expect(Object.keys(t)).toContain("content");
  });

  test("serializes correctly to JSON", () => {
    const t = new Turn("user", "Hello");
    const json = JSON.parse(JSON.stringify(t));
    expect(json.role).toBe("user");
    expect(json.content).toBe("Hello");
  });
});

describe("Turn.create", () => {
  test("equivalent to new Turn", () => {
    const t = Turn.create("user", "Hello");
    expect(t).toBeInstanceOf(Turn);
    expect(t.role).toBe("user");
    expect(t.content).toBe("Hello");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation.normalize — prompt fast path
// ─────────────────────────────────────────────────────────────────────────────

describe("Conversation.normalize — prompt fast path", () => {
  test("string → single user Turn with Content", () => {
    const turns = Conversation.normalize("Hello");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toBeInstanceOf(Turn);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBeInstanceOf(Content);
    expect(turns[0].content.prompt.text).toBe("Hello");
  });

  test("string + documents → user Turn with Content containing docs", () => {
    const turns = Conversation.normalize("Hello", "doc1", "doc2");
    expect(turns).toHaveLength(1);
    expect(turns[0].content.length).toBe(3); // prompt + 2 docs
  });

  test("Content instance alone — passed through as-is", () => {
    const content = new Content("Hello");
    const turns   = Conversation.normalize(content);
    expect(turns[0].content).toBe(content);
  });

  test("Content instance + documents → new Content wrapping both", () => {
    const content = new Content("Hello");
    const turns   = Conversation.normalize(content, "doc1");
    // new Content is constructed from the original prompt + doc
    expect(turns[0].content).toBeInstanceOf(Content);
    expect(turns[0].content).not.toBe(content);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation.normalize — individual source shapes
// ─────────────────────────────────────────────────────────────────────────────

describe("Conversation.normalize — individual sources", () => {
  test("Turn instance passed through unchanged", () => {
    const t     = new Turn("user", "Hello");
    const turns = Conversation.normalize(t);
    expect(turns[0]).toBe(t);
  });

  test("Response-like → assistant Turn with output.text", () => {
    const turns = Conversation.normalize(mockResponse("Reply text"));
    expect(turns[0].role).toBe("assistant");
    expect(turns[0].content).toBe("Reply text");
  });

  test("plain { role, content } → Turn with those values", () => {
    const turns = Conversation.normalize({ role: "user", content: "Hello" });
    expect(turns[0]).toBeInstanceOf(Turn);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("Hello");
  });

  test("plain { role, content } with assistant role", () => {
    const turns = Conversation.normalize({ role: "assistant", content: "Hi" });
    expect(turns[0].role).toBe("assistant");
  });

  test("Conversation flattened — all turns included", () => {
    const conv = new Conversation(
      { role: "user",      content: "Q1" },
      { role: "assistant", content: "A1" }
    );
    const turns = Conversation.normalize(conv);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[1].role).toBe("assistant");
  });

  test("null source skipped", () => {
    expect(Conversation.normalize(null)).toHaveLength(0);
  });

  test("undefined source skipped", () => {
    expect(Conversation.normalize(undefined)).toHaveLength(0);
  });

  test("unrecognized source — console.warn called, skipped", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const turns = Conversation.normalize(42);
    expect(turns).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test("mixed sources — each normalized independently", () => {
    const turns = Conversation.normalize(
      { role: "user",      content: "Q" },
      { role: "assistant", content: "A" },
      mockResponse("R")
    );
    expect(turns).toHaveLength(3);
    expect(turns[2].role).toBe("assistant");
    expect(turns[2].content).toBe("R");
  });

  test("prompt-shaped object { data, enableCache } → user Turn with Content", () => {
    const conv = new Conversation({ data: "Hello", enableCache: true });
    expect(conv.length).toBe(1);
    expect(conv[0].role).toBe("user");
    expect(conv[0].content).toBeInstanceOf(Content);
    expect(conv[0].content.cacheEnabled).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation — construction
// ─────────────────────────────────────────────────────────────────────────────

describe("Conversation — construction", () => {
  test("no sources — empty array", () => {
    expect(new Conversation().length).toBe(0);
  });

  test("extends Array", () => {
    expect(new Conversation() instanceof Array).toBe(true);
  });

  test("single string prompt — one user Turn", () => {
    const conv = new Conversation("Hello");
    expect(conv.length).toBe(1);
    expect(conv[0].role).toBe("user");
  });

  test("prompt + documents — one user Turn with Content", () => {
    const conv = new Conversation("Hello", "doc1");
    expect(conv.length).toBe(1);
    expect(conv[0].content.length).toBe(2); // prompt + doc
  });

  test("pre-built turns array", () => {
    const conv = new Conversation(
      { role: "user",      content: "Q" },
      { role: "assistant", content: "A" }
    );
    expect(conv.length).toBe(2);
    expect(conv[0].role).toBe("user");
    expect(conv[1].role).toBe("assistant");
  });

  test("Turn instances passed through", () => {
    const t1 = new Turn("user",      "Q");
    const t2 = new Turn("assistant", "A");
    const conv = new Conversation(t1, t2);
    expect(conv[0]).toBe(t1);
    expect(conv[1]).toBe(t2);
  });

  test("iterable — spread produces Turn array", () => {
    const conv  = new Conversation({ role: "user", content: "Q" });
    const turns = [...conv];
    expect(turns[0]).toBeInstanceOf(Turn);
  });

  test("passable as messages array to API shape", () => {
    const conv     = new Conversation("What is Legionella?");
    const messages = conv;
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBeInstanceOf(Content);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation.last
// ─────────────────────────────────────────────────────────────────────────────

describe("Conversation.last", () => {

  test("last returns the final turn", () => {
    const conv = new Conversation(
      { role: "user",      content: "Q" },
      { role: "assistant", content: "A" }
    );
    expect(conv.last).toBe(conv[1]);
  });

  test("last on empty conversation returns undefined", () => {
    expect(new Conversation().last).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation.continue
// ─────────────────────────────────────────────────────────────────────────────

describe("Conversation.continue", () => {
  test("appends assistant turn from response", () => {
    const conv = new Conversation("Hello");
    conv.continue(mockResponse("Reply"), "Follow up");
    expect(conv[1].role).toBe("assistant");
    expect(conv[1].content).toBe("Reply");
  });

  test("appends user turn with next prompt", () => {
    const conv = new Conversation("Hello");
    conv.continue(mockResponse("Reply"), "Follow up");
    expect(conv[2].role).toBe("user");
    expect(conv[2].content).toBeInstanceOf(Content);
    expect(conv[2].content.prompt.text).toBe("Follow up");
  });

  test("length grows by 2 per continue call", () => {
    const conv = new Conversation("Hello");
    expect(conv.length).toBe(1);
    conv.continue(mockResponse("R1"), "Q2");
    expect(conv.length).toBe(3);
    conv.continue(mockResponse("R2"), "Q3");
    expect(conv.length).toBe(5);
  });

  test("returns this for chaining", () => {
    const conv = new Conversation("Hello");
    expect(conv.continue(mockResponse("R"), "Q")).toBe(conv);
  });

  test("chained continue calls maintain alternating roles", () => {
    const conv = new Conversation("Q1");
    conv
      .continue(mockResponse("A1"), "Q2")
      .continue(mockResponse("A2"), "Q3");
    expect(conv[0].role).toBe("user");
    expect(conv[1].role).toBe("assistant");
    expect(conv[2].role).toBe("user");
    expect(conv[3].role).toBe("assistant");
    expect(conv[4].role).toBe("user");
  });

  test("continue with documents — Content includes docs", () => {
    const conv = new Conversation("Hello");
    conv.continue(mockResponse("Reply"), "Follow up", "doc1");
    expect(conv[2].content.length).toBe(2); // prompt + doc
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation.create factory
// ─────────────────────────────────────────────────────────────────────────────

describe("Conversation.create", () => {
  test("returns a Conversation instance", () => {
    expect(Conversation.create("Hello")).toBeInstanceOf(Conversation);
  });

  test("equivalent to new Conversation(...args)", () => {
    const a = new Conversation("Hello", "doc");
    const b = Conversation.create("Hello", "doc");
    expect(a.length).toBe(b.length);
    expect(a[0].role).toBe(b[0].role);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frozen export
// ─────────────────────────────────────────────────────────────────────────────

describe("Conversation — frozen export", () => {
  test("frozen — cannot add properties to export", () => {
    expect(() => { Conversation.foo = 1; }).toThrow();
  });

  test("named export matches default", () => {
    expect(Conversation.Conversation).toBe(Conversation);
  });

  test("Turn exported on Conversation", () => {
    expect(Conversation.Turn).toBe(Turn);
  });

  test("Conversation.create attached", () => {
    expect(typeof Conversation.create).toBe("function");
  });

  test("Conversation.normalize attached", () => {
    expect(typeof Conversation.normalize).toBe("function");
  });
});
