"use strict";

const { formatObject } = require("../../../src/utilities/object/formatObject");

describe("formatObject", () => {
  // ── flat objects ──────────────────────────────────────────────────────────

  test("single key — no indent", () => {
    expect(formatObject({ a: 1 })).toBe("a: 1");
  });

  test("multiple flat keys", () => {
    expect(formatObject({ port: 8080, host: "localhost" })).toBe(
      "port: 8080\nhost: localhost"
    );
  });

  test("string value", () => {
    expect(formatObject({ name: "claude" })).toBe("name: claude");
  });

  test("boolean value", () => {
    expect(formatObject({ active: true })).toBe("active: true");
  });

  test("zero value", () => {
    expect(formatObject({ count: 0 })).toBe("count: 0");
  });

  test("null value — rendered as null", () => {
    expect(formatObject({ x: null })).toBe("x: null");
  });

  // ── indent ────────────────────────────────────────────────────────────────

  test("indent=3 — prepends spaces", () => {
    expect(formatObject({ a: 1 }, 3)).toBe("   a: 1");
  });

  test("indent=3 — multiple keys", () => {
    expect(formatObject({ a: 1, b: 2 }, 3)).toBe("   a: 1\n   b: 2");
  });

  // ── nested objects ────────────────────────────────────────────────────────

  test("nested object — child indented by indentStep", () => {
    expect(formatObject({ db: { host: "localhost" } })).toBe(
      "db:\n  host: localhost"
    );
  });

  test("nested object — with parent indent", () => {
    expect(formatObject({ db: { host: "localhost" } }, 2)).toBe(
      "  db:\n    host: localhost"
    );
  });

  test("nested object — multiple children", () => {
    expect(formatObject({ db: { host: "localhost", user: "admin" } })).toBe(
      "db:\n  host: localhost\n  user: admin"
    );
  });

  test("deeply nested object", () => {
    expect(formatObject({ a: { b: { c: 1 } } })).toBe(
      "a:\n  b:\n    c: 1"
    );
  });

  test("sibling keys alongside nested object", () => {
    expect(formatObject({ port: 8080, db: { host: "localhost" } })).toBe(
      "port: 8080\ndb:\n  host: localhost"
    );
  });

  // ── arrays ────────────────────────────────────────────────────────────────

  test("array value — rendered as [a, b, c]", () => {
    expect(formatObject({ flags: ["quiet", "debug"] })).toBe(
      "flags: [quiet, debug]"
    );
  });

  test("array value — single element", () => {
    expect(formatObject({ tags: ["only"] })).toBe("tags: [only]");
  });

  test("empty array", () => {
    expect(formatObject({ tags: [] })).toBe("tags: []");
  });

  test("numeric array", () => {
    expect(formatObject({ ids: [1, 2, 3] })).toBe("ids: [1, 2, 3]");
  });

  test("array with indent", () => {
    expect(formatObject({ flags: ["a", "b"] }, 2)).toBe("  flags: [a, b]");
  });

  // ── custom indentStep ─────────────────────────────────────────────────────

  test("indentStep=4 — nested uses 4 spaces", () => {
    expect(formatObject({ db: { host: "localhost" } }, 0, 4)).toBe(
      "db:\n    host: localhost"
    );
  });

  test("indentStep=0 — nested has no extra indent", () => {
    expect(formatObject({ db: { host: "localhost" } }, 0, 0)).toBe(
      "db:\nhost: localhost"
    );
  });

  // ── combined ──────────────────────────────────────────────────────────────

  test("full config-like object", () => {
    const obj = {
      port: 8080,
      db: { host: "localhost", user: "admin" },
      flags: ["quiet", "debug"]
    };
    expect(formatObject(obj)).toBe(
      "port: 8080\ndb:\n  host: localhost\n  user: admin\nflags: [quiet, debug]"
    );
  });

  test("full config with indent=3", () => {
    const obj = { port: 8080, db: { host: "localhost" } };
    expect(formatObject(obj, 3)).toBe(
      "   port: 8080\n   db:\n     host: localhost"
    );
  });

  // ── empty object ──────────────────────────────────────────────────────────

  test("empty object — returns empty string", () => {
    expect(formatObject({})).toBe("");
  });

  // ── frozen export ─────────────────────────────────────────────────────────

  test("frozen — cannot add properties", () => {
    const mod = require("../../../src/utilities/object/formatObject");
    expect(() => { mod.foo = 1; }).toThrow();
  });

  test("named export matches default", () => {
    const mod = require("../../../src/utilities/object/formatObject");
    expect(mod.formatObject).toBe(mod);
  });
});
