"use strict";

/**
 * @file parseResponseJson.test.js
 * @brief Unit tests for the parseResponseJson JSON extraction utility.
 *
 * Covers markdown fence stripping, trailing text discarding, plain JSON,
 * nested structures, string escape handling, invalid JSON error throwing,
 * and the frozen export contract.
 */

const parseResponseJson = require("../../src/utilities/parseResponseJson");

// ─────────────────────────────────────────────────────────────────────────────
// Plain JSON — no quirks
// ─────────────────────────────────────────────────────────────────────────────

describe("parseResponseJson — plain JSON", () => {
  test("plain object", () => {
    expect(parseResponseJson('{"key":"value"}')).toEqual({ key: "value" });
  });

  test("plain array", () => {
    expect(parseResponseJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  test("empty object", () => {
    expect(parseResponseJson("{}" )).toEqual({});
  });

  test("empty array", () => {
    expect(parseResponseJson("[]")).toEqual([]);
  });

  test("nested object", () => {
    expect(parseResponseJson('{"a":{"b":1}}')).toEqual({ a: { b: 1 } });
  });

  test("nested array", () => {
    expect(parseResponseJson('[[1,2],[3,4]]')).toEqual([[1, 2], [3, 4]]);
  });

  test("object with array value", () => {
    expect(parseResponseJson('{"tags":["a","b"]}')).toEqual({ tags: ["a", "b"] });
  });

  test("array of objects", () => {
    expect(parseResponseJson('[{"a":1},{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("numeric values", () => {
    expect(parseResponseJson('{"n":42,"f":3.14}')).toEqual({ n: 42, f: 3.14 });
  });

  test("boolean and null values", () => {
    expect(parseResponseJson('{"t":true,"f":false,"n":null}')).toEqual({ t: true, f: false, n: null });
  });

  test("unicode in string values", () => {
    expect(parseResponseJson('{"emoji":"🌊"}')).toEqual({ emoji: "🌊" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Markdown code fence stripping
// ─────────────────────────────────────────────────────────────────────────────

describe("parseResponseJson — markdown fence stripping", () => {
  test("```json fence stripped", () => {
    expect(parseResponseJson('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  test("plain ``` fence stripped", () => {
    expect(parseResponseJson('```\n{"key":"value"}\n```')).toEqual({ key: "value" });
  });

  test("uppercase ```JSON fence stripped (case-insensitive)", () => {
    expect(parseResponseJson('```JSON\n{"k":1}\n```')).toEqual({ k: 1 });
  });

  test("fence with no newline after opening", () => {
    expect(parseResponseJson('```json{"k":1}\n```')).toEqual({ k: 1 });
  });

  test("fence with trailing whitespace after closing ```", () => {
    expect(parseResponseJson('```json\n[1,2]\n```  ')).toEqual([1, 2]);
  });

  test("leading whitespace before JSON after fence", () => {
    expect(parseResponseJson('```json\n   {"k":1}\n```')).toEqual({ k: 1 });
  });

  test("object in fence", () => {
    expect(parseResponseJson('```json\n{"answer":"yes","score":0.9}\n```'))
      .toEqual({ answer: "yes", score: 0.9 });
  });

  test("empty array in fence", () => {
    expect(parseResponseJson('```json\n[]\n```')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Trailing text discarding
// ─────────────────────────────────────────────────────────────────────────────

describe("parseResponseJson — trailing text discarding", () => {
  test("trailing commentary after array", () => {
    expect(parseResponseJson('[{"a":1}]\n\n**Reasoning:** no facts found'))
      .toEqual([{ a: 1 }]);
  });

  test("trailing commentary after object", () => {
    expect(parseResponseJson('{"k":"v"}\n\nNote: see above'))
      .toEqual({ k: "v" });
  });

  test("trailing text with no blank line", () => {
    expect(parseResponseJson('{"x":1} trailing garbage'))
      .toEqual({ x: 1 });
  });

  test("trailing text after empty array", () => {
    expect(parseResponseJson('[] **Reasoning:** the section has no facts'))
      .toEqual([]);
  });

  test("trailing text after empty object", () => {
    expect(parseResponseJson('{} some extra text'))
      .toEqual({});
  });

  test("fence + trailing text combined", () => {
    expect(parseResponseJson('```json\n[1,2,3]\n```\nSome explanation here.'))
      .toEqual([1, 2, 3]);
  });

  test("multiple JSON-like patterns — only first extracted", () => {
    // Second object after closing brace is trailing text, not parsed.
    expect(parseResponseJson('{"a":1} {"b":2}'))
      .toEqual({ a: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// String escape handling
// ─────────────────────────────────────────────────────────────────────────────

describe("parseResponseJson — string escape handling", () => {
  test("escaped quote inside string value", () => {
    expect(parseResponseJson('{"q":"say \\"hello\\""}')).toEqual({ q: 'say "hello"' });
  });

  test("escaped backslash inside string value", () => {
    expect(parseResponseJson('{"path":"C:\\\\Users"}')).toEqual({ path: "C:\\Users" });
  });

  test("brackets inside string value not treated as depth change", () => {
    // The "]" inside the string should not close the outer array.
    expect(parseResponseJson('["a]b","c"]')).toEqual(["a]b", "c"]);
  });

  test("braces inside string value not treated as depth change", () => {
    expect(parseResponseJson('{"k":"{ not an object }"}')).toEqual({ k: "{ not an object }" });
  });

  test("nested brackets in string with trailing text", () => {
    expect(parseResponseJson('["[inner]"] trailing'))
      .toEqual(["[inner]"]);
  });

  test("escaped backslash before quote — not a string escape", () => {
    // "\\\"" → escaped backslash followed by quote that closes string
    expect(parseResponseJson('{"k":"a\\\\"}')).toEqual({ k: "a\\" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Depth tracking — deeply nested structures
// ─────────────────────────────────────────────────────────────────────────────

describe("parseResponseJson — depth tracking", () => {
  test("deeply nested object — correct closing brace found", () => {
    expect(parseResponseJson('{"a":{"b":{"c":{"d":1}}}} trailing'))
      .toEqual({ a: { b: { c: { d: 1 } } } });
  });

  test("deeply nested array — correct closing bracket found", () => {
    expect(parseResponseJson('[[[1,2],[3,4]],[5]] trailing'))
      .toEqual([[[1, 2], [3, 4]], [5]]);
  });

  test("object with deeply nested array — correct extraction", () => {
    expect(parseResponseJson('{"data":[[1,2],[3,4]]} trailing'))
      .toEqual({ data: [[1, 2], [3, 4]] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-object / non-array top-level values (no depth extraction)
// ─────────────────────────────────────────────────────────────────────────────

describe("parseResponseJson — non-object/array top-level", () => {
  test("plain number string", () => {
    expect(parseResponseJson("42")).toBe(42);
  });

  test("plain true", () => {
    expect(parseResponseJson("true")).toBe(true);
  });

  test("plain false", () => {
    expect(parseResponseJson("false")).toBe(false);
  });

  test("plain null", () => {
    expect(parseResponseJson("null")).toBe(null);
  });

  test("plain string in quotes", () => {
    expect(parseResponseJson('"hello"')).toBe("hello");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

describe("parseResponseJson — error handling", () => {
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });
  
  test("invalid JSON throws SyntaxError", () => {
    expect(() => parseResponseJson("not json at all")).toThrow(SyntaxError);
  });

  test("truncated object throws SyntaxError", () => {
    expect(() => parseResponseJson('{"key":')).toThrow(SyntaxError);
  });

  test("truncated array throws SyntaxError", () => {
    expect(() => parseResponseJson("[1, 2,")).toThrow(SyntaxError);
  });

  test("fence with invalid JSON inside throws SyntaxError", () => {
    expect(() => parseResponseJson("```json\n{bad}\n```")).toThrow(SyntaxError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frozen export
// ─────────────────────────────────────────────────────────────────────────────

describe("parseResponseJson — frozen export", () => {
  test("frozen — cannot add properties", () => {
    expect(() => { parseResponseJson.foo = 1; }).toThrow();
  });

  test("named export matches default", () => {
    expect(parseResponseJson.parseResponseJson).toBe(parseResponseJson);
  });
});
