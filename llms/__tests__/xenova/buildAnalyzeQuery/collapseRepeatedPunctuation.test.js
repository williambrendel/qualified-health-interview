"use strict";

/**
 * @file collapseRepeatedPunctuation.test.js
 * @brief Unit tests for the punctuation-normalization helper.
 *
 * Three behaviors under test:
 *   1. Terminal punctuation (`!?`) — any 2+ run, mixed or not,
 *      collapses to the first character of the run.
 *   2. Non-terminal punctuation (`,.;:`) — adjacent same-character
 *      runs collapse, mixed runs are preserved.
 *   3. Important non-collapsing cases — honorifics, decimals, `e.g.`,
 *      single-mark text, empty / null input.
 */

const collapseRepeatedPunctuation =
  require("../../../src/xenova/buildAnalyzeQuery/collapseRepeatedPunctuation");

// ─────────────────────────────────────────────────────────────────────────────
// Terminal punctuation (!?) — cross-character runs collapse
// ─────────────────────────────────────────────────────────────────────────────

describe("collapseRepeatedPunctuation — terminal runs (!?)", () => {
  test("'!!' → '!'", () => {
    expect(collapseRepeatedPunctuation("hello!!")).toBe("hello!");
  });

  test("'!!!' → '!'", () => {
    expect(collapseRepeatedPunctuation("thanks!!!")).toBe("thanks!");
  });

  test("'??' → '?'", () => {
    expect(collapseRepeatedPunctuation("hello??")).toBe("hello?");
  });

  test("'???' → '?'", () => {
    expect(collapseRepeatedPunctuation("why???")).toBe("why?");
  });

  test("'?!' → '?' (first char wins)", () => {
    expect(collapseRepeatedPunctuation("hello?!")).toBe("hello?");
  });

  test("'!?' → '!' (first char wins)", () => {
    expect(collapseRepeatedPunctuation("hello!?")).toBe("hello!");
  });

  test("'??!!' → '?' (cross-character keymash)", () => {
    expect(collapseRepeatedPunctuation("hello??!!")).toBe("hello?");
  });

  test("'!?!?' → '!'", () => {
    expect(collapseRepeatedPunctuation("hello!?!?")).toBe("hello!");
  });

  test("'??!!!???!!' → '?' (large keymash)", () => {
    expect(collapseRepeatedPunctuation("hello??!!!???!!")).toBe("hello?");
  });

  test("multiple isolated terminal marks preserved", () => {
    // Each `?` is its own run of one — no collapse.
    expect(collapseRepeatedPunctuation("what? why? how?")).toBe("what? why? how?");
  });

  test("single ? preserved", () => {
    expect(collapseRepeatedPunctuation("what is biofilm?")).toBe("what is biofilm?");
  });

  test("single ! preserved", () => {
    expect(collapseRepeatedPunctuation("thanks!")).toBe("thanks!");
  });

  test("two questions separated by content each retain one mark", () => {
    expect(collapseRepeatedPunctuation("what is pH??? what is alkalinity!!!")).toBe(
      "what is pH? what is alkalinity!"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-terminal punctuation (,.;:) — same-character runs only
// ─────────────────────────────────────────────────────────────────────────────

describe("collapseRepeatedPunctuation — non-terminal runs (,.;:)", () => {
  test("'..' → '.'", () => {
    expect(collapseRepeatedPunctuation("hello..")).toBe("hello.");
  });

  test("'...' (ellipsis) → '.'", () => {
    // Ellipsis collapsing is intentional — for boundary detection an
    // ellipsis behaves as one sentence terminator.
    expect(collapseRepeatedPunctuation("wait...")).toBe("wait.");
  });

  test("',,' → ','", () => {
    expect(collapseRepeatedPunctuation("a,,b")).toBe("a,b");
  });

  test("';;' → ';'", () => {
    expect(collapseRepeatedPunctuation("foo;;bar")).toBe("foo;bar");
  });

  test("'::' → ':'", () => {
    expect(collapseRepeatedPunctuation("note::value")).toBe("note:value");
  });

  test("cross-character non-terminal NOT collapsed", () => {
    // ".," and ",." aren't a common keymash; preserved as-is.
    expect(collapseRepeatedPunctuation("a.,b")).toBe("a.,b");
    expect(collapseRepeatedPunctuation("a,.b")).toBe("a,.b");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Must-preserve cases (real content patterns)
// ─────────────────────────────────────────────────────────────────────────────

describe("collapseRepeatedPunctuation — must-preserve patterns", () => {
  test("honorific 'Dr.' preserved", () => {
    expect(collapseRepeatedPunctuation("Dr. Smith")).toBe("Dr. Smith");
  });

  test("'e.g.' preserved (two non-adjacent dots)", () => {
    expect(collapseRepeatedPunctuation("e.g. chlorine")).toBe("e.g. chlorine");
  });

  test("'i.e.' preserved", () => {
    expect(collapseRepeatedPunctuation("i.e. like this")).toBe("i.e. like this");
  });

  test("scientific name 'L. pneumophila' preserved", () => {
    expect(collapseRepeatedPunctuation("L. pneumophila")).toBe("L. pneumophila");
  });

  test("decimal '7.2' preserved", () => {
    expect(collapseRepeatedPunctuation("the pH is 7.2")).toBe("the pH is 7.2");
  });

  test("range '7.2 to 7.8' preserved", () => {
    expect(collapseRepeatedPunctuation("keep pH between 7.2 and 7.8")).toBe(
      "keep pH between 7.2 and 7.8"
    );
  });

  test("text with no punctuation passes through unchanged", () => {
    expect(collapseRepeatedPunctuation("hello world")).toBe("hello world");
  });

  test("text with single punctuation per spot passes through", () => {
    expect(collapseRepeatedPunctuation("what is X, and how do I Y.")).toBe(
      "what is X, and how do I Y."
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Falsy and edge inputs
// ─────────────────────────────────────────────────────────────────────────────

describe("collapseRepeatedPunctuation — edge inputs", () => {
  test("empty string passes through", () => {
    expect(collapseRepeatedPunctuation("")).toBe("");
  });

  test("null passes through", () => {
    expect(collapseRepeatedPunctuation(null)).toBeNull();
  });

  test("undefined passes through", () => {
    expect(collapseRepeatedPunctuation(undefined)).toBeUndefined();
  });

  test("whitespace-only string passes through", () => {
    expect(collapseRepeatedPunctuation("   ")).toBe("   ");
  });

  test("pure terminal punctuation collapses", () => {
    expect(collapseRepeatedPunctuation("!!!")).toBe("!");
    expect(collapseRepeatedPunctuation("???")).toBe("?");
    expect(collapseRepeatedPunctuation("?!?!")).toBe("?");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("collapseRepeatedPunctuation — module export", () => {
  test("module is frozen", () => {
    expect(Object.isFrozen(collapseRepeatedPunctuation)).toBe(true);
  });

  test("self-referential property", () => {
    expect(collapseRepeatedPunctuation.collapseRepeatedPunctuation).toBe(
      collapseRepeatedPunctuation
    );
  });
});
