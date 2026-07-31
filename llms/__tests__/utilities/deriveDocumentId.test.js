"use strict";

const deriveDocumentId = require("../../src/utilities/deriveDocumentId");
const { isDocumentIdShape, METADATA_SUFFIX_RE } = deriveDocumentId;

// ─────────────────────────────────────────────────────────────────────────────
// Basic derivation (no override)
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveDocumentId — basic derivation", () => {
  test("relative path with single parent folder", () => {
    expect(deriveDocumentId("biology/overview.md")).toBe("biology|overview");
  });

  test("absolute path", () => {
    expect(deriveDocumentId("/abs/path/to/biology/overview.md")).toBe("biology|overview");
  });

  test("bare filename uses root theme", () => {
    expect(deriveDocumentId("overview.md")).toBe("root|overview");
  });

  test("filename with no extension", () => {
    expect(deriveDocumentId("biology/overview")).toBe("biology|overview");
  });

  test("multiple intermediate directories — uses immediate parent", () => {
    expect(deriveDocumentId("/data/markdowns/biology/overview.md"))
      .toBe("biology|overview");
  });

  test("sanitizes uppercase to lowercase", () => {
    expect(deriveDocumentId("Chemistry/Cooling Towers.md"))
      .toBe("chemistry|cooling_towers");
  });

  test("sanitizes special characters in theme", () => {
    expect(deriveDocumentId("biology-and-chemistry/overview.md"))
      .toBe("biology_and_chemistry|overview");
  });

  test("sanitizes diacritics", () => {
    expect(deriveDocumentId("biology/résumé.md")).toBe("biology|resume");
  });

  test("collapses repeated separators", () => {
    expect(deriveDocumentId("biology///overview.md")).toBe("biology|overview");
  });

  test("trims leading and trailing separators in stem", () => {
    expect(deriveDocumentId("biology/--overview--.md")).toBe("biology|overview");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Build-metadata suffix stripping
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveDocumentId — build-metadata suffix", () => {
  test("strips suffix from markdown filename", () => {
    expect(deriveDocumentId("biology/overview|md_2026-04-22T02-28-30-099Z.md"))
      .toBe("biology|overview");
  });

  test("strips suffix from binary filename", () => {
    expect(deriveDocumentId("biology/overview|md_2026-04-22T02-28-30-099Z.bin"))
      .toBe("biology|overview");
  });

  test("preserves other | characters in stem", () => {
    expect(deriveDocumentId("biology/foo|v2|extra.bin"))
      .toBe("biology|foo_v2_extra");
  });

  test("only strips trailing suffix (anchored at end)", () => {
    expect(deriveDocumentId("biology/foo|md_2026-04-22T02-28-30-099Z|extra.md"))
      .toBe("biology|foo_md_2026_04_22t02_28_30_099z_extra");
  });

  test("METADATA_SUFFIX_RE is exposed for tests", () => {
    expect(METADATA_SUFFIX_RE).toBeInstanceOf(RegExp);
    expect("|md_2026-04-22T02-28-30-099Z").toMatch(METADATA_SUFFIX_RE);
    expect("|md_bad-timestamp").not.toMatch(METADATA_SUFFIX_RE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pass-through (idempotence)
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveDocumentId — pass-through (idempotence)", () => {
  test("already-formed id passes through unchanged", () => {
    expect(deriveDocumentId("biology|overview")).toBe("biology|overview");
  });

  test("f(f(x)) === f(x) for arbitrary path", () => {
    const x = "Biology/Cooling Towers.md";
    expect(deriveDocumentId(deriveDocumentId(x))).toBe(deriveDocumentId(x));
  });

  test("uppercase fails round-trip — falls through to derivation", () => {
    // "Biology|Overview" is NOT a well-formed id (theme isn't lowercase)
    // so it goes through normal pipeline, which treats `|` as part of the filename.
    expect(deriveDocumentId("Biology|Overview")).toBe("root|biology_overview");
  });

  test("path-like input is not treated as pass-through", () => {
    expect(deriveDocumentId("biology/overview")).toBe("biology|overview");
  });

  test("isDocumentIdShape exposed for tests", () => {
    expect(isDocumentIdShape("biology|overview")).toBe(true);
    expect(isDocumentIdShape("Biology|Overview")).toBe(false);
    expect(isDocumentIdShape("biology/overview")).toBe(false);
    expect(isDocumentIdShape("biology|overview.md")).toBe(false);
    expect(isDocumentIdShape("biology|")).toBe(false);
    expect(isDocumentIdShape("|overview")).toBe(false);
    expect(isDocumentIdShape("biology|overview|extra")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveDocumentId — input validation", () => {
  test("throws on non-string input", () => {
    expect(() => deriveDocumentId(42)).toThrow(/must be a non-empty string/);
    expect(() => deriveDocumentId(null)).toThrow(/must be a non-empty string/);
    expect(() => deriveDocumentId(undefined)).toThrow(/must be a non-empty string/);
    expect(() => deriveDocumentId({})).toThrow(/must be a non-empty string/);
  });

  test("throws on empty string", () => {
    expect(() => deriveDocumentId("")).toThrow(/must be a non-empty string/);
    expect(() => deriveDocumentId("   ")).toThrow(/must be a non-empty string/);
  });

  test("throws when filename sanitizes to empty stem", () => {
    expect(() => deriveDocumentId("biology/!!!.md"))
      .toThrow(/sanitizes to an empty stem/);
    expect(() => deriveDocumentId("biology/---.md"))
      .toThrow(/sanitizes to an empty stem/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Theme override — string shape
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveDocumentId — theme override (string shape)", () => {
  test("string override sets theme", () => {
    expect(deriveDocumentId("water_chemistry.md", "biocides"))
      .toBe("biocides|water_chemistry");
  });

  test("override wins over path-derived theme", () => {
    expect(deriveDocumentId("biology/overview.md", "chemistry"))
      .toBe("chemistry|overview");
  });

  test("override sanitizes hyphens to underscores", () => {
    expect(deriveDocumentId("water_chemistry.md", "biocides-and-chemicals"))
      .toBe("biocides_and_chemicals|water_chemistry");
  });

  test("override sanitizes uppercase", () => {
    expect(deriveDocumentId("water_chemistry.md", "Biocides"))
      .toBe("biocides|water_chemistry");
  });

  test("override sanitizes spaces", () => {
    expect(deriveDocumentId("water_chemistry.md", "Biocides and Chemicals"))
      .toBe("biocides_and_chemicals|water_chemistry");
  });

  test("override with absolute path input", () => {
    expect(deriveDocumentId("/abs/path/biology/overview.md", "chemistry"))
      .toBe("chemistry|overview");
  });

  test("override with bare filename — no path theme to conflict", () => {
    // No console.warn should fire for string shape regardless
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(deriveDocumentId("overview.md", "biocides"))
        .toBe("biocides|overview");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("string shape is silent on conflict by default", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      deriveDocumentId("biology/overview.md", "chemistry");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("override with metadata suffix in path", () => {
    expect(deriveDocumentId(
      "biology/overview|md_2026-04-22T02-28-30-099Z.md",
      "chemistry"
    )).toBe("chemistry|overview");
  });

  test("override with already-formed id input", () => {
    // Override bypasses pass-through.
    expect(deriveDocumentId("biology|overview", "chemistry"))
      .toBe("chemistry|overview");
  });

  test("override matching path theme — no conflict, no change", () => {
    // Same theme — output identical to no-override case.
    expect(deriveDocumentId("biology/overview.md", "biology"))
      .toBe("biology|overview");
  });

  test("empty string override treated as no override", () => {
    expect(deriveDocumentId("biology/overview.md", ""))
      .toBe("biology|overview");
  });

  test("null override treated as no override", () => {
    expect(deriveDocumentId("biology/overview.md", null))
      .toBe("biology|overview");
  });

  test("undefined override treated as no override", () => {
    expect(deriveDocumentId("biology/overview.md", undefined))
      .toBe("biology|overview");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Theme override — object shape
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveDocumentId — theme override (object shape)", () => {
  test("object with theme works like string shape", () => {
    expect(deriveDocumentId("water_chemistry.md", { theme: "biocides" }))
      .toBe("biocides|water_chemistry");
  });

  test("object without theme is a no-op (path-derived theme used)", () => {
    expect(deriveDocumentId("biology/overview.md", {}))
      .toBe("biology|overview");
  });

  test("object with theme: undefined behaves like no theme", () => {
    expect(deriveDocumentId("biology/overview.md", { theme: undefined }))
      .toBe("biology|overview");
  });

  test("default onConflict is silent", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      deriveDocumentId("biology/overview.md", { theme: "chemistry" });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// onConflict behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveDocumentId — onConflict", () => {
  describe("silent (explicit)", () => {
    test("no warning, no throw, override wins", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = deriveDocumentId("biology/overview.md", {
          theme: "chemistry",
          onConflict: "silent",
        });
        expect(result).toBe("chemistry|overview");
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("warn", () => {
    let warnSpy;
    beforeEach(() => { warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {}); });
    afterEach(()  => { warnSpy.mockRestore(); });

    test("fires console.warn on conflict, override still wins", () => {
      const result = deriveDocumentId("biology/overview.md", {
        theme: "chemistry",
        onConflict: "warn",
      });
      expect(result).toBe("chemistry|overview");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("biology");
      expect(warnSpy.mock.calls[0][0]).toContain("chemistry");
    });

    test("no warning when path theme equals override", () => {
      deriveDocumentId("biology/overview.md", {
        theme: "biology",
        onConflict: "warn",
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test("no warning for bare filename (path theme is root, override fills in)", () => {
      deriveDocumentId("overview.md", {
        theme: "chemistry",
        onConflict: "warn",
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test("no warning when override matches sanitized path theme (hyphen vs underscore)", () => {
      // "biocides-and-chemicals" on disk sanitizes to "biocides_and_chemicals"
      // — matches the override, no conflict.
      deriveDocumentId("biocides-and-chemicals/overview.md", {
        theme: "biocides_and_chemicals",
        onConflict: "warn",
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test("warns when override conflicts with already-formed id input", () => {
      const result = deriveDocumentId("biology|overview", {
        theme: "chemistry",
        onConflict: "warn",
      });
      expect(result).toBe("chemistry|overview");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("throw", () => {
    test("throws on conflict", () => {
      expect(() => deriveDocumentId("biology/overview.md", {
        theme: "chemistry",
        onConflict: "throw",
      })).toThrow(/theme conflict/);
    });

    test("does not throw when themes match", () => {
      expect(deriveDocumentId("biology/overview.md", {
        theme: "biology",
        onConflict: "throw",
      })).toBe("biology|overview");
    });

    test("does not throw for bare filename", () => {
      expect(deriveDocumentId("overview.md", {
        theme: "chemistry",
        onConflict: "throw",
      })).toBe("chemistry|overview");
    });

    test("error message includes both themes and input", () => {
      try {
        deriveDocumentId("biology/overview.md", {
          theme: "chemistry",
          onConflict: "throw",
        });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err.message).toContain("biology");
        expect(err.message).toContain("chemistry");
        expect(err.message).toContain("biology/overview.md");
      }
    });
  });

  describe("function callback", () => {
    test("fires callback with details on conflict", () => {
      const seen = [];
      const result = deriveDocumentId("biology/overview.md", {
        theme: "chemistry",
        onConflict: (details) => seen.push(details),
      });
      expect(result).toBe("chemistry|overview");
      expect(seen).toHaveLength(1);
      expect(seen[0].pathTheme).toBe("biology");
      expect(seen[0].overrideTheme).toBe("chemistry");
      expect(seen[0].input).toBe("biology/overview.md");
    });

    test("does not fire callback when themes match", () => {
      const seen = [];
      deriveDocumentId("biology/overview.md", {
        theme: "biology",
        onConflict: (details) => seen.push(details),
      });
      expect(seen).toHaveLength(0);
    });

    test("callback can throw to bubble up its own error", () => {
      expect(() => deriveDocumentId("biology/overview.md", {
        theme: "chemistry",
        onConflict: () => { throw new Error("custom conflict handler error"); },
      })).toThrow(/custom conflict handler error/);
    });

    test("callback receives all details for diagnostics", () => {
      let captured;
      deriveDocumentId("/abs/path/biology/overview.md", {
        theme: "chemistry",
        onConflict: (details) => { captured = details; },
      });
      expect(captured).toEqual({
        pathTheme: "biology",
        overrideTheme: "chemistry",
        input: "/abs/path/biology/overview.md",
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Override validation
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveDocumentId — override validation", () => {
  test("throws on invalid override type", () => {
    expect(() => deriveDocumentId("x.md", 42))
      .toThrow(/second argument must be a string/);
    expect(() => deriveDocumentId("x.md", true))
      .toThrow(/second argument must be a string/);
  });

  test("throws on options.theme that's not a string", () => {
    expect(() => deriveDocumentId("x.md", { theme: 42 }))
      .toThrow(/options\.theme must be a non-empty string/);
  });

  test("throws on options.theme that's empty/whitespace", () => {
    expect(() => deriveDocumentId("x.md", { theme: "" }))
      .toThrow(/options\.theme must be a non-empty string/);
    expect(() => deriveDocumentId("x.md", { theme: "   " }))
      .toThrow(/options\.theme must be a non-empty string/);
  });

  test("throws on invalid onConflict string", () => {
    expect(() => deriveDocumentId("x.md", { theme: "y", onConflict: "yell" }))
      .toThrow(/onConflict must be one of/);
  });

  test("throws when theme sanitizes to empty", () => {
    expect(() => deriveDocumentId("x.md", "!!!"))
      .toThrow(/sanitizes to an empty string/);
    expect(() => deriveDocumentId("x.md", "---"))
      .toThrow(/sanitizes to an empty string/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveDocumentId — module export", () => {
  test("module is the function itself", () => {
    expect(typeof deriveDocumentId).toBe("function");
  });

  test("self-referential property", () => {
    expect(deriveDocumentId.deriveDocumentId).toBe(deriveDocumentId);
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(deriveDocumentId)).toBe(true);
  });

  test("exposes helper functions", () => {
    expect(typeof deriveDocumentId.isDocumentIdShape).toBe("function");
    expect(deriveDocumentId.METADATA_SUFFIX_RE).toBeInstanceOf(RegExp);
    expect(typeof deriveDocumentId.normalizeOptions).toBe("function");
  });
});