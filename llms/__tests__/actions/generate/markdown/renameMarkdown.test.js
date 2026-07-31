"use strict";

const renameMarkdown = require("../../../../src/actions/generate/markdown/renameMarkdown");
const {
  MAX_STEM_LENGTH,
  toSnakeCase,
  truncateAtWord,
  stripMarkdownFormatting,
} = renameMarkdown;

// ─────────────────────────────────────────────────────────────────────────────
// Happy path: valid markdown with clear H1
// ─────────────────────────────────────────────────────────────────────────────

describe("renameMarkdown — basic H1 extraction", () => {
  test("simple ASCII H1 produces snake_case filename", () => {
    const result = renameMarkdown({
      markdown: "# What Causes Biofilm\n\nSome content here.",
    });
    expect(result).toBe("what_causes_biofilm.md");
  });

  test("H1 with question mark", () => {
    const result = renameMarkdown({
      markdown: "# How Much Extra Pump Pressure Do AI Data Centers Need?\n\n## Executive Summary",
    });
    expect(result).toBe("how_much_extra_pump_pressure_do_ai_data_centers_need.md");
  });

  test("H1 with numbers", () => {
    const result = renameMarkdown({
      markdown: "# 30 Minutes Contact Time for Biofilm Control\n\n## Overview",
    });
    expect(result).toBe("30_minutes_contact_time_for_biofilm_control.md");
  });

  test("H1 with mixed case is lowercased", () => {
    const result = renameMarkdown({
      markdown: "# WHY Is My Biocide NOT Working\n\nContent",
    });
    expect(result).toBe("why_is_my_biocide_not_working.md");
  });

  test("H1 with em-dash and other punctuation", () => {
    // Em-dashes, colons, commas should all become underscores
    // (and then collapse).
    const result = renameMarkdown({
      markdown: "# Biofilm Control: A Practical Guide — Part One\n\nContent",
    });
    expect(result).toBe("biofilm_control_a_practical_guide_part_one.md");
  });

  test("H1 with apostrophes", () => {
    const result = renameMarkdown({
      markdown: "# Why Won't My Biocide Work\n\nContent",
    });
    expect(result).toBe("why_won_t_my_biocide_work.md");
  });

  test("only the first H1 is used (subsequent H1s ignored)", () => {
    // The first `# ` line wins. Documents shouldn't have multiple
    // H1s, but if they do, we use the document title (first).
    const result = renameMarkdown({
      markdown: "# First Title\n\n## Sub\n\n# Second Title",
    });
    expect(result).toBe("first_title.md");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Markdown formatting in H1
// ─────────────────────────────────────────────────────────────────────────────

describe("renameMarkdown — formatting in H1", () => {
  test("strips bold emphasis", () => {
    const result = renameMarkdown({
      markdown: "# **Bold Title**\n\nContent",
    });
    expect(result).toBe("bold_title.md");
  });

  test("strips italic emphasis", () => {
    const result = renameMarkdown({
      markdown: "# *Italic Title*\n\nContent",
    });
    expect(result).toBe("italic_title.md");
  });

  test("strips inline code backticks", () => {
    const result = renameMarkdown({
      markdown: "# Using `chlorine` for Biofilm\n\nContent",
    });
    expect(result).toBe("using_chlorine_for_biofilm.md");
  });

  test("strips mixed emphasis", () => {
    const result = renameMarkdown({
      markdown: "# **Bold** and *italic* and `code` mixed\n\nContent",
    });
    expect(result).toBe("bold_and_italic_and_code_mixed.md");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H1 lookup: position in document
// ─────────────────────────────────────────────────────────────────────────────

describe("renameMarkdown — H1 lookup", () => {
  test("finds H1 not on first line", () => {
    // Documents may have a leading blank line or frontmatter.
    const result = renameMarkdown({
      markdown: "\n\n# After Blank Lines\n\nContent",
    });
    expect(result).toBe("after_blank_lines.md");
  });

  test("does NOT match H2", () => {
    // Without an H1, throws — even if H2 exists.
    expect(() => renameMarkdown({
      markdown: "## Only Subheading\n\nContent",
    })).toThrow(/no H1 heading found/);
  });

  test("does NOT match H3 or deeper", () => {
    expect(() => renameMarkdown({
      markdown: "### Sub-sub-heading\n\nContent",
    })).toThrow(/no H1 heading found/);
  });

  test("matches H1 with multiple spaces after #", () => {
    const result = renameMarkdown({
      markdown: "#   Title With Extra Spaces\n\nContent",
    });
    expect(result).toBe("title_with_extra_spaces.md");
  });

  test("matches H1 with trailing whitespace", () => {
    const result = renameMarkdown({
      markdown: "# Title With Trailing Space   \n\nContent",
    });
    expect(result).toBe("title_with_trailing_space.md");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Truncation
// ─────────────────────────────────────────────────────────────────────────────

describe("renameMarkdown — truncation", () => {
  test("titles within the limit are unchanged", () => {
    const result = renameMarkdown({
      markdown: "# Short Title\n\nContent",
    });
    expect(result.length).toBeLessThanOrEqual(MAX_STEM_LENGTH + 3); // + ".md"
    expect(result).toBe("short_title.md");
  });

  test("very long title is truncated at a word boundary", () => {
    // Build a title longer than MAX_STEM_LENGTH (80 chars).
    const longTitle = "How Does Glycol Affect Pump Performance In Modern AI Data Center Cooling Loops With High Density Direct To Chip Hardware";
    const result = renameMarkdown({
      markdown: `# ${longTitle}\n\nContent`,
    });
    const stem = result.replace(/\.md$/, "");
    expect(stem.length).toBeLessThanOrEqual(MAX_STEM_LENGTH);
    // Should end at a word boundary, not mid-word.
    expect(stem).not.toMatch(/_$/);  // doesn't end with trailing underscore
    expect(stem).toMatch(/^[a-z0-9_]+$/);  // valid snake_case
  });

  test("truncation prefers word boundary over hard cut", () => {
    // Build a stem clearly past the 80-char limit, with an underscore
    // boundary partway through so the truncator has a place to cut.
    // The "tail" portion comes after the boundary and should get
    // dropped during truncation.
    const head = "a".repeat(70);             // 70 chars
    const tail = "_morewords_thatshouldgetdropped";  // pushes well past 80
    const stem = head + tail;
    expect(stem.length).toBeGreaterThan(MAX_STEM_LENGTH);

    const truncated = truncateAtWord(stem);
    expect(truncated.length).toBeLessThanOrEqual(MAX_STEM_LENGTH);
    // The post-boundary "morewords" / "thatshouldgetdropped" gone.
    expect(truncated).not.toContain("thatshouldgetdropped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error paths
// ─────────────────────────────────────────────────────────────────────────────

describe("renameMarkdown — error paths", () => {
  test("throws on missing markdown argument", () => {
    expect(() => renameMarkdown()).toThrow(/markdown must be a non-empty string/);
    expect(() => renameMarkdown({})).toThrow(/markdown must be a non-empty string/);
  });

  test("throws on empty string markdown", () => {
    expect(() => renameMarkdown({ markdown: "" })).toThrow(/markdown must be a non-empty string/);
  });

  test("throws on non-string markdown", () => {
    expect(() => renameMarkdown({ markdown: 42 })).toThrow(/markdown must be a non-empty string/);
    expect(() => renameMarkdown({ markdown: null })).toThrow(/markdown must be a non-empty string/);
  });

  test("throws when no H1 is present", () => {
    expect(() => renameMarkdown({
      markdown: "Just some paragraph content with no headings at all.",
    })).toThrow(/no H1 heading found/);
  });

  test("throws when H1 is empty after stripping", () => {
    // H1 with only markdown formatting (no actual text).
    expect(() => renameMarkdown({
      markdown: "# **__**\n\nContent",
    })).toThrow(/H1 heading is empty/);
  });

  test("throws when H1 produces empty stem (only special chars)", () => {
    // The H1 has visible content but all chars normalize to underscore.
    // This is hard to engineer because most punctuation in the regex
    // gets stripped — but a heading of only `---` punctuation
    // would do it. With `#` alone, the H1 wouldn't match in the
    // first place; we test the stem-empty branch via punctuation-only.
    expect(() => renameMarkdown({
      markdown: "# ---\n\nContent",
    })).toThrow(/produced an empty stem|H1 heading is empty/);
  });

  test("error messages name the function", () => {
    try {
      renameMarkdown({ markdown: "no heading" });
    } catch (err) {
      expect(err.message).toMatch(/renameMarkdown/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: toSnakeCase
// ─────────────────────────────────────────────────────────────────────────────

describe("toSnakeCase", () => {
  test("simple lowercase ASCII", () => {
    expect(toSnakeCase("Hello World")).toBe("hello_world");
  });

  test("multiple spaces collapse", () => {
    expect(toSnakeCase("Many   spaces   here")).toBe("many_spaces_here");
  });

  test("punctuation becomes underscore", () => {
    expect(toSnakeCase("hello, world!")).toBe("hello_world");
  });

  test("runs of non-word chars collapse to one underscore", () => {
    expect(toSnakeCase("hello---world")).toBe("hello_world");
    expect(toSnakeCase("a:::b")).toBe("a_b");
  });

  test("leading/trailing whitespace stripped", () => {
    expect(toSnakeCase("  hello  ")).toBe("hello");
  });

  test("numbers preserved", () => {
    expect(toSnakeCase("100 ways to do X")).toBe("100_ways_to_do_x");
  });

  test("empty string returns empty", () => {
    expect(toSnakeCase("")).toBe("");
  });

  test("only-punctuation string returns empty", () => {
    expect(toSnakeCase("!!!")).toBe("");
    expect(toSnakeCase("---")).toBe("");
  });

  test("accented characters become underscore", () => {
    // \w in JS doesn't match accented letters by default; they
    // get treated as non-word. May or may not be desirable;
    // this test pins the current behavior.
    expect(toSnakeCase("café")).toBe("caf");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: truncateAtWord
// ─────────────────────────────────────────────────────────────────────────────

describe("truncateAtWord", () => {
  test("short input unchanged", () => {
    expect(truncateAtWord("short")).toBe("short");
  });

  test("input exactly at limit unchanged", () => {
    const exact = "a".repeat(MAX_STEM_LENGTH);
    expect(truncateAtWord(exact)).toBe(exact);
  });

  test("input one over limit gets truncated", () => {
    const oneOver = "a".repeat(MAX_STEM_LENGTH + 1);
    const result = truncateAtWord(oneOver);
    expect(result.length).toBeLessThanOrEqual(MAX_STEM_LENGTH);
  });

  test("truncates at last underscore before limit", () => {
    // Build "a_b_c_d_e_f_..." extending past the limit.
    // Confirm truncation lands on an underscore boundary.
    const parts = [];
    while (parts.join("_").length < MAX_STEM_LENGTH + 20) {
      parts.push("word");
    }
    const stem = parts.join("_");
    const result = truncateAtWord(stem);
    expect(result.length).toBeLessThanOrEqual(MAX_STEM_LENGTH);
    // Result should be a sequence of complete "word" tokens, no partials.
    expect(result.split("_").every(p => p === "word")).toBe(true);
  });

  test("hard-truncates when no underscore exists within limit", () => {
    // Single long string with no boundaries.
    const longWord = "a".repeat(MAX_STEM_LENGTH + 50);
    const result = truncateAtWord(longWord);
    expect(result.length).toBe(MAX_STEM_LENGTH);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: stripMarkdownFormatting
// ─────────────────────────────────────────────────────────────────────────────

describe("stripMarkdownFormatting", () => {
  test("strips backticks", () => {
    expect(stripMarkdownFormatting("Use `chlorine`")).toBe("Use chlorine");
  });

  test("strips asterisks", () => {
    expect(stripMarkdownFormatting("**Bold** text")).toBe("Bold text");
  });

  test("strips underscores", () => {
    expect(stripMarkdownFormatting("__bold__ text")).toBe("bold text");
  });

  test("strips tildes", () => {
    expect(stripMarkdownFormatting("~~strikethrough~~ text")).toBe("strikethrough text");
  });

  test("preserves plain words", () => {
    expect(stripMarkdownFormatting("plain text")).toBe("plain text");
  });

  test("trims whitespace", () => {
    expect(stripMarkdownFormatting("  spaced  ")).toBe("spaced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("renameMarkdown — module export", () => {
  test("module is the function itself", () => {
    expect(typeof renameMarkdown).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(renameMarkdown)).toBe(true);
  });

  test("self-referential .renameMarkdown property", () => {
    expect(renameMarkdown.renameMarkdown).toBe(renameMarkdown);
  });

  test("exposes MAX_STEM_LENGTH", () => {
    expect(typeof MAX_STEM_LENGTH).toBe("number");
    expect(MAX_STEM_LENGTH).toBeGreaterThan(0);
  });

  test("exposes toSnakeCase, truncateAtWord, stripMarkdownFormatting", () => {
    expect(typeof toSnakeCase).toBe("function");
    expect(typeof truncateAtWord).toBe("function");
    expect(typeof stripMarkdownFormatting).toBe("function");
  });
});