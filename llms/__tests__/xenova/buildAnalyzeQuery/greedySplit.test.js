"use strict";

/**
 * @file greedySplit.test.js
 * @brief Unit tests for the local regex query splitter.
 *
 * Pure-regex pipeline, no mocks. Tests cover each of the five stages:
 *   1. Greeting peel
 *   2. Question marks
 *   3. Sentence dots (with honorific protection)
 *   4. Additive openers
 *   5. Connective + intent
 *
 * Plus the negative cases the splitter must preserve: enumerations,
 * decimals, single-letter scientific abbreviations, lowercase acronym
 * openers (e.g., i.e.), URLs, and the inline "also" adverb.
 */

const greedySplit = require("../../../src/xenova/buildAnalyzeQuery/greedySplit");

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1: greeting peel
// ─────────────────────────────────────────────────────────────────────────────

describe("greedySplit — stage 1: greeting peel", () => {
  test("'Hello! What is biofilm?' → greeting + question", () => {
    expect(greedySplit("Hello! What is biofilm?")).toEqual([
      "Hello!", "What is biofilm?",
    ]);
  });

  test("'Hello' alone is not split (no content after greeting)", () => {
    // Greeting peel requires non-whitespace content after the separator.
    // A bare greeting passes through as one segment.
    expect(greedySplit("Hello")).toEqual(["Hello"]);
  });

  test("'Hello!' alone is not split", () => {
    expect(greedySplit("Hello!")).toEqual(["Hello!"]);
  });

  test("'thanks how do I' → not peeled (no punctuation break)", () => {
    // 'thanks how do I' is grammatically continuous — the greeting is
    // not a discrete boundary, so it stays attached to the rest. To
    // peel, the greeting needs a punctuation marker (!,.) after it.
    expect(greedySplit("thanks how do I")).toEqual(["thanks how do I"]);
  });

  test("greeting without trailing punctuation is not peeled", () => {
    expect(greedySplit("hi how are you")).toEqual(["hi how are you"]);
  });

  test("'good morning what is X?' → not peeled but split on ?", () => {
    // No punctuation break between 'good morning' and 'what is X' — the
    // greeting stays attached. Stage 2 (terminators) still splits on
    // the question mark, but there's no content after the ?, so the
    // result is a single segment.
    expect(greedySplit("good morning what is X?")).toEqual([
      "good morning what is X?",
    ]);
  });

  test("'good morning, what is X?' → comma triggers peel, then ? splits", () => {
    // With the comma, the greeting peels cleanly. Then stage 2
    // would split on the ? but there's no content after, so we end
    // up with two segments: the peeled greeting and the question.
    expect(greedySplit("good morning, what is X?")).toEqual([
      "good morning", "what is X?",
    ]);
  });

  test("'thanks!!!' → not split, collapsed to 'thanks!'", () => {
    // The repeated punctuation collapses to a single mark via
    // collapseRepeatedPunctuation, then the greeting peel has no
    // alphanumeric content after the punctuation to capture as the
    // "rest" group. The entire query stays as one collapsed segment.
    expect(greedySplit("thanks!!!")).toEqual(["thanks!"]);
  });

  test("'thanks for explaining biofilm' → not split (grammatical continuation)", () => {
    // 'thanks for X' is one conversational utterance. The greeting
    // peel requires punctuation between the greeting and the rest;
    // a space alone is not a peel boundary.
    expect(greedySplit("thanks for explaining biofilm")).toEqual([
      "thanks for explaining biofilm",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2: question marks
// ─────────────────────────────────────────────────────────────────────────────

describe("greedySplit — stage 2: question marks", () => {
  test("two questions → two segments", () => {
    expect(greedySplit("what is biofilm? how do I remove it?")).toEqual([
      "what is biofilm?", "how do I remove it?",
    ]);
  });

  test("three questions → three segments", () => {
    expect(greedySplit("what is X? why does it happen? how do I fix it?")).toEqual([
      "what is X?", "why does it happen?", "how do I fix it?",
    ]);
  });

  test("single question → one segment", () => {
    expect(greedySplit("how do I prevent scale?")).toEqual([
      "how do I prevent scale?",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3: sentence dots — POSITIVES (real boundaries)
// ─────────────────────────────────────────────────────────────────────────────

describe("greedySplit — stage 3: sentence-dot positives", () => {
  test("4+ char word before and after period", () => {
    expect(greedySplit("Treatment fails. Replace the tower.")).toEqual([
      "Treatment fails.", "Replace the tower.",
    ]);
  });

  test("short trailing word, capital after period", () => {
    expect(greedySplit("Biofilm builds up. Treat it now.")).toEqual([
      "Biofilm builds up.", "Treat it now.",
    ]);
  });

  test("'I tested. The result was high' splits", () => {
    expect(greedySplit("I tested. The result was high")).toEqual([
      "I tested.", "The result was high",
    ]);
  });

  test("honorific in left side, real boundary later — splits only at boundary", () => {
    expect(greedySplit("Dr. Smith said hello. What is biofilm?")).toEqual([
      "Dr. Smith said hello.", "What is biofilm?",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3: sentence dots — NEGATIVES (must not split)
// ─────────────────────────────────────────────────────────────────────────────

describe("greedySplit — stage 3: sentence-dot negatives", () => {
  test("enumeration '1. First 2. Second' preserved", () => {
    expect(greedySplit("1. First item 2. Second item")).toEqual([
      "1. First item 2. Second item",
    ]);
  });

  test("chapter heading 'Chapter 3. Introduction' preserved", () => {
    expect(greedySplit("Chapter 3. Introduction to chemistry")).toEqual([
      "Chapter 3. Introduction to chemistry",
    ]);
  });

  test("single-letter initial 'L. pneumophila' preserved", () => {
    expect(greedySplit("L. pneumophila is dangerous")).toEqual([
      "L. pneumophila is dangerous",
    ]);
  });

  test("single-letter initial 'E. coli' preserved", () => {
    expect(greedySplit("E. coli is also dangerous")).toEqual([
      "E. coli is also dangerous",
    ]);
  });

  test("lowercase acronym opener 'e.g.' preserved", () => {
    expect(greedySplit("e.g. chlorine works well")).toEqual([
      "e.g. chlorine works well",
    ]);
  });

  test("honorific 'Mrs. Smith said hi' preserved (no real boundary)", () => {
    expect(greedySplit("Mrs. Smith said hi")).toEqual([
      "Mrs. Smith said hi",
    ]);
  });

  test("honorific 'Dr. Smith said pH 7.5' preserved", () => {
    expect(greedySplit("Dr. Smith said pH 7.5")).toEqual([
      "Dr. Smith said pH 7.5",
    ]);
  });

  test("honorifics 'See Fig. 2 and Eq. 3.' preserved", () => {
    expect(greedySplit("See Fig. 2 and Eq. 3.")).toEqual([
      "See Fig. 2 and Eq. 3.",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 4: additive openers
// ─────────────────────────────────────────────────────────────────────────────

describe("greedySplit — stage 4: additive openers", () => {
  test("'X. Also Y' splits before 'Also'", () => {
    expect(greedySplit("Tested X. Also need urgent help.")).toEqual([
      "Tested X.", "Also need urgent help.",
    ]);
  });

  test("inline adverb 'is also Y' does NOT split (no preceding punctuation)", () => {
    expect(greedySplit("E. coli is also dangerous")).toEqual([
      "E. coli is also dangerous",
    ]);
  });

  test("'X, also Y' splits before 'also' (preceded by comma)", () => {
    expect(greedySplit("Need scale removal, also need corrosion control")).toEqual([
      "Need scale removal,", "also need corrosion control",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5: connective + intent
// ─────────────────────────────────────────────────────────────────────────────

describe("greedySplit — stage 5: connective + intent", () => {
  test("'and how' → split at connective + intent word", () => {
    expect(greedySplit("what is X and how do I prevent Y")).toEqual([
      "what is X", "how do I prevent Y",
    ]);
  });

  test("'and explain' → split", () => {
    expect(greedySplit("what is biofilm and explain how to remove it")).toEqual([
      "what is biofilm", "explain how to remove it",
    ]);
  });

  test("'salt and pepper' → no split (no intent word after 'and')", () => {
    expect(greedySplit("I use salt and pepper")).toEqual([
      "I use salt and pepper",
    ]);
  });

  test("'X and Y happened' → no split (Y isn't an intent word)", () => {
    expect(greedySplit("scale forms and rust appears")).toEqual([
      "scale forms and rust appears",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-stage interaction
// ─────────────────────────────────────────────────────────────────────────────

describe("greedySplit — multi-stage interaction", () => {
  test("'Hi! How do I X? Also need Y' → greeting + question + additive", () => {
    expect(greedySplit("Hi! How do I clean my system? Also need urgent help")).toEqual([
      "Hi!", "How do I clean my system?", "Also need urgent help",
    ]);
  });

  test("greeting + dot-split sentence", () => {
    expect(greedySplit("Hello! I tested. The result was high")).toEqual([
      "Hello!", "I tested.", "The result was high",
    ]);
  });

  test("dot-split + connective+intent", () => {
    expect(greedySplit("Treatment failed. Explain what to do and how to fix it")).toEqual([
      "Treatment failed.", "Explain what to do", "how to fix it",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency / pass-through
// ─────────────────────────────────────────────────────────────────────────────

describe("greedySplit — single-intent pass-through", () => {
  test("single question → 1 element", () => {
    const result = greedySplit("how do I prevent scale?");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("how do I prevent scale?");
  });

  test("single statement → 1 element", () => {
    const result = greedySplit("Biofilm grows in cooling towers");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Biofilm grows in cooling towers");
  });

  test("no boundaries found → 1-element array (the original query)", () => {
    const q = "chlorine dosing matters here";
    const result = greedySplit(q);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(q);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("greedySplit — edge cases", () => {
  test("empty string → [\"\"]", () => {
    // Documented contract: always returns an array of at least one element.
    // Empty input produces a single empty-string element.
    expect(greedySplit("")).toEqual([""]);
  });

  test("whitespace-only → [\"\"]", () => {
    expect(greedySplit("   ")).toEqual([""]);
  });

  test("leading/trailing whitespace trimmed", () => {
    expect(greedySplit("  what is X?  ")).toEqual(["what is X?"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Repeated-punctuation invariance
// ─────────────────────────────────────────────────────────────────────────────

describe("greedySplit — repeated punctuation collapses before splitting", () => {
  test("'thanks!!!' produces same output as 'thanks!'", () => {
    expect(greedySplit("thanks!!!")).toEqual(greedySplit("thanks!"));
  });

  test("'help???' produces same output as 'help?'", () => {
    expect(greedySplit("help???")).toEqual(greedySplit("help?"));
  });

  test("'??!!!???!!' keymash collapses for boundary detection", () => {
    expect(greedySplit("hello??!!!???!!")).toEqual(greedySplit("hello?"));
  });

  test("'what is pH??? what is alkalinity!!!' collapses each run", () => {
    expect(greedySplit("what is pH??? what is alkalinity!!!")).toEqual(
      greedySplit("what is pH? what is alkalinity!")
    );
  });

  test("'thanks!!! what causes biofilm???' splits into collapsed segments", () => {
    expect(greedySplit("thanks!!! what causes biofilm???")).toEqual([
      "thanks!",
      "what causes biofilm?",
    ]);
  });

  test("isolated punctuation marks across content are preserved", () => {
    // No runs of 2+ adjacent terminal marks → no collapse.
    expect(greedySplit("what is biofilm? how do I remove it?")).toEqual([
      "what is biofilm?",
      "how do I remove it?",
    ]);
  });
});

describe("greedySplit — module export", () => {
  test("module is the function itself", () => {
    expect(typeof greedySplit).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(greedySplit)).toBe(true);
  });

  test("self-referential greedySplit.greedySplit property", () => {
    expect(greedySplit.greedySplit).toBe(greedySplit);
  });
});