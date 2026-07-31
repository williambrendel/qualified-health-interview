"use strict";

/**
 * @file getMediaType.test.js
 * @brief Unit tests for the getMediaType MIME type resolver.
 *
 * Covers direct extension lookup, dot-prefixed extensions, case-insensitivity,
 * full path and basename resolution, custom and global fallbacks, static
 * property access, dot-prefixed key mirroring, frozen export, and the
 * MEDIA_TYPES backward-compatibility alias.
 */

const getMediaType = require("../../src/utilities/getMediaType");

// ─────────────────────────────────────────────────────────────────────────────
// Known types — direct extension
// ─────────────────────────────────────────────────────────────────────────────

describe("getMediaType — direct extension", () => {
  test("txt → text/plain", () => {
    expect(getMediaType("txt")).toBe("text/plain");
  });

  test("text → text/plain", () => {
    expect(getMediaType("text")).toBe("text/plain");
  });

  test("pdf → application/pdf", () => {
    expect(getMediaType("pdf")).toBe("application/pdf");
  });

  test("doc → application/msword", () => {
    expect(getMediaType("doc")).toBe("application/msword");
  });

  test("docx → full openxmlformats MIME", () => {
    expect(getMediaType("docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });

  test("xml → application/xml", () => {
    expect(getMediaType("xml")).toBe("application/xml");
  });

  test("csv → application/csv", () => {
    expect(getMediaType("csv")).toBe("application/csv");
  });

  test("md → text/markdown", () => {
    expect(getMediaType("md")).toBe("text/markdown");
  });

  test("json → application/json", () => {
    expect(getMediaType("json")).toBe("application/json");
  });

  test("yaml → application/yaml", () => {
    expect(getMediaType("yaml")).toBe("application/yaml");
  });

  test("yml → application/yaml", () => {
    expect(getMediaType("yml")).toBe("application/yaml");
  });

  test("ppl → text/plain", () => {
    expect(getMediaType("ppl")).toBe("text/plain");
  });

  test("dsl → text/plain", () => {
    expect(getMediaType("dsl")).toBe("text/plain");
  });

  test("moon → text/plain", () => {
    expect(getMediaType("moon")).toBe("text/plain");
  });

  test("toon → text/toon", () => {
    expect(getMediaType("toon")).toBe("text/toon");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dot-prefixed extensions
// ─────────────────────────────────────────────────────────────────────────────

describe("getMediaType — dot-prefixed extensions", () => {
  test(".txt → text/plain", () => {
    expect(getMediaType(".txt")).toBe("text/plain");
  });

  test(".pdf → application/pdf", () => {
    expect(getMediaType(".pdf")).toBe("application/pdf");
  });

  test(".docx → full openxmlformats MIME", () => {
    expect(getMediaType(".docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });

  test(".json → application/json", () => {
    expect(getMediaType(".json")).toBe("application/json");
  });

  test(".yaml → application/yaml", () => {
    expect(getMediaType(".yaml")).toBe("application/yaml");
  });

  test(".md → text/markdown", () => {
    expect(getMediaType(".md")).toBe("text/markdown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case-insensitivity
// ─────────────────────────────────────────────────────────────────────────────

describe("getMediaType — case-insensitivity", () => {
  test("PDF → application/pdf", () => {
    expect(getMediaType("PDF")).toBe("application/pdf");
  });

  test("DOCX → full openxmlformats MIME", () => {
    expect(getMediaType("DOCX")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });

  test(".PDF → application/pdf", () => {
    expect(getMediaType(".PDF")).toBe("application/pdf");
  });

  test("TXT → text/plain", () => {
    expect(getMediaType("TXT")).toBe("text/plain");
  });

  test("mixed case .Csv → application/csv", () => {
    expect(getMediaType(".Csv")).toBe("application/csv");
  });

  test("mixed case Json → application/json", () => {
    expect(getMediaType("Json")).toBe("application/json");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full file paths and filenames
// ─────────────────────────────────────────────────────────────────────────────

describe("getMediaType — file paths and filenames", () => {
  test("full path with .pdf extension", () => {
    expect(getMediaType("/path/to/report.pdf")).toBe("application/pdf");
  });

  test("full path with .docx extension", () => {
    expect(getMediaType("/docs/file.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });

  test("relative path — ./data/file.csv", () => {
    expect(getMediaType("./data/file.csv")).toBe("application/csv");
  });

  test("filename only — report.pdf", () => {
    expect(getMediaType("report.pdf")).toBe("application/pdf");
  });

  test("filename only — notes.md", () => {
    expect(getMediaType("notes.md")).toBe("text/markdown");
  });

  test("filename with uppercase extension — FILE.JSON", () => {
    expect(getMediaType("FILE.JSON")).toBe("application/json");
  });

  test("deeply nested path — /a/b/c/d.xml", () => {
    expect(getMediaType("/a/b/c/d.xml")).toBe("application/xml");
  });

  test("path with no extension — falls back to defaultType", () => {
    expect(getMediaType("/path/to/noextension", "application/octet-stream")).toBe(
      "application/octet-stream"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unknown / unresolvable input
// ─────────────────────────────────────────────────────────────────────────────

describe("getMediaType — unknown input", () => {
  test("unknown extension — returns global default", () => {
    expect(getMediaType("xyz")).toBe("text/plain");
  });

  test("unknown extension — custom fallback", () => {
    expect(getMediaType("xyz", "application/octet-stream")).toBe("application/octet-stream");
  });

  test("empty string — returns global default", () => {
    expect(getMediaType("")).toBe("text/plain");
  });

  test("null input — returns global default", () => {
    expect(getMediaType(null)).toBe("text/plain");
  });

  test("undefined input — returns global default", () => {
    expect(getMediaType(undefined)).toBe("text/plain");
  });

  test("empty string + custom fallback", () => {
    expect(getMediaType("", "application/octet-stream")).toBe("application/octet-stream");
  });

  test("null + falsy defaultType — returns empty string", () => {
    expect(getMediaType(null, "")).toBe("");
  });

  test("unknown + falsy defaultType — returns empty string", () => {
    expect(getMediaType("xyz", "")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Static property access
// ─────────────────────────────────────────────────────────────────────────────

describe("getMediaType — static properties", () => {
  test("getMediaType.txt === 'text/plain'", () => {
    expect(getMediaType.txt).toBe("text/plain");
  });

  test("getMediaType.pdf === 'application/pdf'", () => {
    expect(getMediaType.pdf).toBe("application/pdf");
  });

  test("getMediaType.csv === 'application/csv'", () => {
    expect(getMediaType.csv).toBe("application/csv");
  });

  test("getMediaType.json === 'application/json'", () => {
    expect(getMediaType.json).toBe("application/json");
  });

  test("getMediaType.yaml === 'application/yaml'", () => {
    expect(getMediaType.yaml).toBe("application/yaml");
  });

  test("getMediaType.md === 'text/markdown'", () => {
    expect(getMediaType.md).toBe("text/markdown");
  });

  test("getMediaType.default === 'text/plain'", () => {
    expect(getMediaType.default).toBe("text/plain");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dot-prefixed key mirroring
// ─────────────────────────────────────────────────────────────────────────────

describe("getMediaType — dot-prefixed key mirroring", () => {
  test("getMediaType['.pdf'] === getMediaType['pdf']", () => {
    expect(getMediaType[".pdf"]).toBe(getMediaType["pdf"]);
  });

  test("getMediaType['.docx'] === getMediaType['docx']", () => {
    expect(getMediaType[".docx"]).toBe(getMediaType["docx"]);
  });

  test("getMediaType['.json'] === getMediaType['json']", () => {
    expect(getMediaType[".json"]).toBe(getMediaType["json"]);
  });

  test("getMediaType['.yaml'] === getMediaType['yaml']", () => {
    expect(getMediaType[".yaml"]).toBe(getMediaType["yaml"]);
  });

  test("getMediaType['.md'] === getMediaType['md']", () => {
    expect(getMediaType[".md"]).toBe(getMediaType["md"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA_TYPES backward-compatibility alias
// ─────────────────────────────────────────────────────────────────────────────

describe("getMediaType — MEDIA_TYPES alias", () => {
  test("MEDIA_TYPES is attached to getMediaType", () => {
    expect(getMediaType.MEDIA_TYPES).toBeDefined();
  });

  test("MEDIA_TYPES.pdf === 'application/pdf'", () => {
    expect(getMediaType.MEDIA_TYPES.pdf).toBe("application/pdf");
  });

  test("MEDIA_TYPES.default === 'text/plain'", () => {
    expect(getMediaType.MEDIA_TYPES.default).toBe("text/plain");
  });

  test("MEDIA_TYPES['.pdf'] === MEDIA_TYPES['pdf'] (dot-prefix mirrored)", () => {
    expect(getMediaType.MEDIA_TYPES[".pdf"]).toBe(getMediaType.MEDIA_TYPES["pdf"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frozen export
// ─────────────────────────────────────────────────────────────────────────────

describe("getMediaType — frozen export", () => {
  test("frozen — cannot add properties", () => {
    expect(() => { getMediaType.foo = 1; }).toThrow();
  });

  test("named export matches default", () => {
    expect(getMediaType.getMediaType).toBe(getMediaType);
  });
});
