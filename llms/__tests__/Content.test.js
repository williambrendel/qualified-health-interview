"use strict";

/**
 * @file Content.test.js
 * @brief Unit tests for Item and Content.
 *
 * Covers Item construction from all input shapes (string, object with data,
 * object without data, Buffer, JSON-serializable), cache control, document vs
 * text render modes, stat properties, Content prompt/document collection,
 * aggregate stats, invalid document skipping, and frozen export.
 */

const Content = require("../src/Content");
const { Item } = Content;

// ─────────────────────────────────────────────────────────────────────────────
// Item — string input (text mode)
// ─────────────────────────────────────────────────────────────────────────────

describe("Item — string input (text mode)", () => {
  test("type is 'text'", () => {
    expect(new Item("Hello world").type).toBe("text");
  });

  test("text property equals input", () => {
    expect(new Item("Hello world").text).toBe("Hello world");
  });

  test("no source property on text item", () => {
    expect(new Item("Hello world").source).toBeUndefined();
  });

  test("isBinary is false", () => {
    expect(new Item("Hello world").isBinary).toBe(false);
  });

  test("cacheEnabled is false when no cache control", () => {
    expect(new Item("Hello world").cacheEnabled).toBe(false);
  });

  test("size equals text length", () => {
    expect(new Item("Hello").size).toBe(5);
  });

  test("numBytes matches UTF-8 byte count", () => {
    expect(new Item("Hello").numBytes).toBe(Buffer.byteLength("Hello", "utf-8"));
  });

  test("numBytes counts multi-byte characters correctly", () => {
    const emoji = "🌊";
    expect(new Item(emoji).numBytes).toBe(Buffer.byteLength(emoji, "utf-8"));
  });

  test("numWords counted", () => {
    expect(new Item("Hello world").numWords).toBe(2);
  });

  test("numSpecialCharacters counted", () => {
    expect(new Item("Hello, world!").numSpecialCharacters).toBe(2);
  });

  test("estimatedNumTokens is a positive integer", () => {
    const item = new Item("Hello world");
    expect(Number.isInteger(item.estimatedNumTokens)).toBe(true);
    expect(item.estimatedNumTokens).toBeGreaterThan(0);
  });

  test("getSegments returns array of string tokens", () => {
    const segs = new Item("Hello world").getSegments();
    expect(Array.isArray(segs)).toBe(true);
    expect(segs).toContain("Hello");
  });

  test("toObject returns plain object copy of enumerable props", () => {
    const obj = new Item("Hello").toObject();
    expect(obj.type).toBe("text");
    expect(obj.text).toBe("Hello");
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item — string input (document mode)
// ─────────────────────────────────────────────────────────────────────────────

describe("Item — string input (document mode)", () => {
  test("type is 'document'", () => {
    expect(new Item("doc content", "document").type).toBe("document");
  });

  test("source.data equals input", () => {
    expect(new Item("doc content", "document").source.data).toBe("doc content");
  });

  test("source.type is 'text'", () => {
    expect(new Item("doc content", "document").source.type).toBe("text");
  });

  test("source.media_type is text/plain", () => {
    expect(new Item("doc content", "document").source.media_type).toBe("text/plain");
  });

  test("no text property on document item", () => {
    expect(new Item("doc content", "document").text).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item — object with data
// ─────────────────────────────────────────────────────────────────────────────

describe("Item — object with data", () => {
  test("data string used as text", () => {
    expect(new Item({ data: "hello" }).text).toBe("hello");
  });

  test("enableCache shorthand — cacheEnabled true", () => {
    expect(new Item({ data: "hello", enableCache: true }).cacheEnabled).toBe(true);
  });

  test("enable_cache alias — cacheEnabled true", () => {
    expect(new Item({ data: "hello", enable_cache: true }).cacheEnabled).toBe(true);
  });

  test("cache_control passthrough — cacheEnabled true", () => {
    expect(new Item({ data: "hello", cache_control: { type: "ephemeral" } }).cacheEnabled).toBe(true);
  });

  test("cache_control on text item — top-level property", () => {
    const item = new Item({ data: "hello", enableCache: true });
    expect(item.cache_control).toEqual({ type: "ephemeral" });
  });

  test("cache_control on document item — on source", () => {
    const item = new Item({ data: "hello", enableCache: true }, "document");
    expect(item.source.cache_control).toEqual({ type: "ephemeral" });
  });

  test("cache_control stored non-enumerably on document item", () => {
    const item = new Item({ data: "hello", enableCache: true }, "document");
    // present but non-enumerable
    expect(item.cache_control).toEqual({ type: "ephemeral" });
    expect(Object.keys(item)).not.toContain("cache_control");
  });

  test("mediaType override respected", () => {
    const item = new Item({ data: "hello", mediaType: "text/markdown" }, "document");
    expect(item.source.media_type).toBe("text/markdown");
  });

  test("media_type alias respected", () => {
    const item = new Item({ data: "hello", media_type: "application/xml" }, "document");
    expect(item.source.media_type).toBe("application/xml");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item — object without data (JSON-serialized)
// ─────────────────────────────────────────────────────────────────────────────

describe("Item — object without data (JSON body)", () => {
  test("object JSON-stringified as text", () => {
    const item = new Item({ query: "Legionella", threshold: 0.7 });
    expect(item.text).toBe(JSON.stringify({ query: "Legionella", threshold: 0.7 }));
  });

  test("type is 'text'", () => {
    expect(new Item({ query: "test" }).type).toBe("text");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item — Buffer input
// ─────────────────────────────────────────────────────────────────────────────

describe("Item — Buffer input", () => {
  const buf = Buffer.from("binary content");

  test("isBinary is true", () => {
    expect(new Item({ data: buf }, "document").isBinary).toBe(true);
  });

  test("default media type is application/pdf", () => {
    expect(new Item({ data: buf }, "document").source.media_type).toBe("application/pdf");
  });

  test("base64 type — data is base64 encoded", () => {
    expect(new Item({ data: buf, type: "base64" }, "document").source.data).toBe(buf.toString("base64"));
  });

  test("utf-8 type (default) — data is utf-8 string", () => {
    expect(new Item({ data: buf }, "document").source.data).toBe(buf.toString("utf-8"));
  });

  test("numBytes equals buffer.length", () => {
    expect(new Item({ data: buf }, "document").numBytes).toBe(buf.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item — error cases
// ─────────────────────────────────────────────────────────────────────────────

describe("Item — error cases", () => {
  test("empty string throws", () => {
    expect(() => new Item("")).toThrow("Input must NOT have empty content");
  });

  test("object with empty data throws", () => {
    expect(() => new Item({ data: "" })).toThrow();
  });

  test("empty object (no data, no keys) throws", () => {
    expect(() => new Item({})).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Item — non-enumerable stat properties
// ─────────────────────────────────────────────────────────────────────────────

describe("Item — non-enumerable stat properties", () => {
  test("isBinary not in Object.keys", () => {
    expect(Object.keys(new Item("hello"))).not.toContain("isBinary");
  });

  test("cacheEnabled not in Object.keys", () => {
    expect(Object.keys(new Item("hello"))).not.toContain("cacheEnabled");
  });

  test("numBytes not in Object.keys", () => {
    expect(Object.keys(new Item("hello"))).not.toContain("numBytes");
  });

  test("estimatedNumTokens not in Object.keys", () => {
    expect(Object.keys(new Item("hello"))).not.toContain("estimatedNumTokens");
  });

  test("toObject not in Object.keys", () => {
    expect(Object.keys(new Item("hello"))).not.toContain("toObject");
  });

  test("getSegments not in Object.keys", () => {
    expect(Object.keys(new Item("hello"))).not.toContain("getSegments");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content — prompt
// ─────────────────────────────────────────────────────────────────────────────

describe("Content — prompt", () => {
  test("falsy prompt throws", () => {
    expect(() => new Content("")).toThrow("Input prompt must NOT be empty");
    expect(() => new Content(null)).toThrow();
    expect(() => new Content(undefined)).toThrow();
  });

  test("prompt is first element", () => {
    expect(new Content("Hello")[0].text).toBe("Hello");
  });

  test("prompt getter returns this[0]", () => {
    const c = new Content("Hello");
    expect(c.prompt).toBe(c[0]);
  });

  test("prompt Item has type 'text'", () => {
    expect(new Content("Hello").prompt.type).toBe("text");
  });

  test("prompt-only — length is 1", () => {
    expect(new Content("Hello").length).toBe(1);
  });

  test("documents getter returns empty array when no docs", () => {
    expect(new Content("Hello").documents).toEqual([]);
  });

  test("prompt accepts object with data", () => {
    const c = new Content({ data: "from object" });
    expect(c.prompt.text).toBe("from object");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content — documents
// ─────────────────────────────────────────────────────────────────────────────

describe("Content — documents", () => {
  test("single document — length is 2", () => {
    expect(new Content("Hello", "doc1").length).toBe(2);
  });

  test("document Item has type 'document'", () => {
    expect(new Content("Hello", "doc1")[1].type).toBe("document");
  });

  test("documents getter returns slice from index 1", () => {
    expect(new Content("Hello", "doc1", "doc2").documents).toHaveLength(2);
  });

  test("nested document arrays flattened", () => {
    expect(new Content("Hello", ["doc1", ["doc2", "doc3"]]).length).toBe(4);
  });

  test("invalid document silently skipped with console.warn", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const c = new Content("Hello", "");
    expect(c.length).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test("mix of valid and invalid documents — valids kept", () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const c = new Content("Hello", "valid", "", "also valid");
    expect(c.length).toBe(3);
    spy.mockRestore();
  });

  test("documents getter returns correct items in order", () => {
    const c = new Content("prompt", "doc one", "doc two", "doc three");
    const docs = c.documents;
    expect(docs[0].source.data).toBe("doc one");
    expect(docs[1].source.data).toBe("doc two");
    expect(docs[2].source.data).toBe("doc three");
  });

  test("documents getter returns plain Array, not Content", () => {
    const c = new Content("prompt", "doc one", "doc two");
    expect(Array.isArray(c.documents)).toBe(true);
    expect(c.documents instanceof Content).toBe(false);
  });

  test("documents getter length matches doc count", () => {
    const c = new Content("prompt", "doc one", "doc two", "doc three");
    expect(c.documents).toHaveLength(3);
  });

  test("documents[i] is same reference as content[i+1]", () => {
    const c = new Content("prompt", "doc one", "doc two");
    expect(c.documents[0]).toBe(c[1]);
    expect(c.documents[1]).toBe(c[2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content — aggregate stats
// ─────────────────────────────────────────────────────────────────────────────

describe("Content — aggregate stats", () => {
  test("numBytes equals sum of item numBytes", () => {
    const c = new Content("Hello", "World");
    expect(c.numBytes).toBe(c[0].numBytes + c[1].numBytes);
  });

  test("estimatedNumTokens equals sum of item estimates", () => {
    const c = new Content("Hello", "World");
    expect(c.estimatedNumTokens).toBe(c[0].estimatedNumTokens + c[1].estimatedNumTokens);
  });

  test("cacheEnabled false when no item has cache", () => {
    expect(new Content("Hello", "doc").cacheEnabled).toBeFalsy();
  });

  test("cacheEnabled true when prompt has cache", () => {
    expect(new Content({ data: "Hello", enableCache: true }, "doc").cacheEnabled).toBeTruthy();
  });

  test("cacheEnabled true when document has cache", () => {
    expect(new Content("Hello", { data: "doc", enableCache: true }).cacheEnabled).toBeTruthy();
  });

  test("stats are non-enumerable — spread returns only Items", () => {
    const items = [...new Content("Hello", "doc")];
    expect(items).toHaveLength(2);
    expect(items.every(i => i instanceof Item)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content — toString
// ─────────────────────────────────────────────────────────────────────────────

describe("Content — toString", () => {
  test("contains header", () => {
    expect(String(new Content("Hello"))).toContain("➡️  Input Content:");
  });

  test("contains separator", () => {
    expect(String(new Content("Hello"))).toContain("─────────────────────────────────────");
  });

  test("contains item count", () => {
    expect(String(new Content("Hello", "doc"))).toContain("num content items: 2");
  });

  test("contains byte count", () => {
    const c = new Content("Hello");
    expect(String(c)).toContain(`num content bytes: ${c.numBytes}`);
  });

  test("contains token estimate", () => {
    const c = new Content("Hello");
    expect(String(c)).toContain(`estimated num tokens: ${c.estimatedNumTokens}`);
  });

  test("contains cache enabled flag", () => {
    expect(String(new Content("Hello"))).toContain("cache enabled:");
  });

  test("toString is non-enumerable", () => {
    expect(Object.getOwnPropertyDescriptor(new Content("Hello"), "toString").enumerable).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content — extends Array
// ─────────────────────────────────────────────────────────────────────────────

describe("Content — extends Array", () => {
  test("instanceof Array", () => {
    expect(new Content("Hello") instanceof Array).toBe(true);
  });

  test("iterable", () => {
    expect([...new Content("Hello", "doc")]).toHaveLength(2);
  });

  test("usable as messages content array directly", () => {
    const c = new Content("Hello");
    expect([{ role: "user", content: c }][0].content[0].text).toBe("Hello");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Content.create factory
// ─────────────────────────────────────────────────────────────────────────────

describe("Content.create", () => {
  test("returns a Content instance", () => {
    expect(Content.create("Hello")).toBeInstanceOf(Content);
  });

  test("equivalent to new Content(...args)", () => {
    const a = new Content("Hello", "doc");
    const b = Content.create("Hello", "doc");
    expect(a.length).toBe(b.length);
    expect(a.prompt.text).toBe(b.prompt.text);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frozen export
// ─────────────────────────────────────────────────────────────────────────────

describe("Content — frozen export", () => {
  test("frozen — cannot add properties to export", () => {
    expect(() => { Content.foo = 1; }).toThrow();
  });

  test("named export matches default", () => {
    expect(Content.Content).toBe(Content);
  });

  test("Content.Item exported", () => {
    expect(Content.Item).toBe(Item);
  });

  test("Content.create attached", () => {
    expect(typeof Content.create).toBe("function");
  });
});
