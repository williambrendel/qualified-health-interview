"use strict";

/**
 * @file isMultiPart.test.js
 * @brief Unit tests for the multi-intent detection heuristic.
 *
 * Pure-regex function, no mocks needed. Tests cover each of the seven
 * signals with positive matches, several negatives that look like
 * they should match but shouldn't, and edge cases (empty input,
 * single-word input, whitespace-only).
 */

const isMultiPart = require("../../../src/xenova/buildAnalyzeQuery/isMultiPart");

// ─────────────────────────────────────────────────────────────────────────────
// Signal 1: multiple distinct question marks
// ─────────────────────────────────────────────────────────────────────────────

describe("isMultiPart — signal 1: multiple question marks", () => {
  test("two ? separated by content → true", () => {
    expect(isMultiPart("what is biofilm? how do I remove it?")).toBe(true);
  });

  test("three ? separated by content → true", () => {
    expect(isMultiPart("what is X? why? how?")).toBe(true);
  });

  test("`???` consecutive → false (treated as one boundary)", () => {
    // The signal-1 regex /\?(?!\?)/ matches only ? not followed by ?.
    // In "???", only the last ? matches — that's one occurrence, below
    // the >1 threshold for signal 1. Other signals also don't fire here.
    expect(isMultiPart("what???")).toBe(false);
  });

  test("single ? → false (signal 1 needs >1)", () => {
    expect(isMultiPart("what is chlorine dosing?")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signal 2: multiple question words
// ─────────────────────────────────────────────────────────────────────────────

describe("isMultiPart — signal 2: multiple question words", () => {
  test("'what' and 'how' separated by content → true", () => {
    expect(isMultiPart("what causes X and how do I prevent it")).toBe(true);
  });

  test("'why' and 'when' separated → true", () => {
    expect(isMultiPart("why is this so and when does it happen")).toBe(true);
  });

  test("'who' twice → true", () => {
    expect(isMultiPart("who decides this and who reviews it")).toBe(true);
  });

  test("question words inside a single intent (one occurrence) → false", () => {
    expect(isMultiPart("how do I prevent scale")).toBe(false);
  });

  test("question word appears as substring inside another word (e.g. 'somewhat') → false", () => {
    // \b ensures word-boundary matching, so 'somewhat' doesn't match 'what'.
    expect(isMultiPart("this is somewhat unclear")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signal 3: multiple imperative verbs
// ─────────────────────────────────────────────────────────────────────────────

describe("isMultiPart — signal 3: multiple imperative verbs", () => {
  test("'explain' and 'tell' separated → true", () => {
    expect(isMultiPart("explain biofilm and tell me how to fix it")).toBe(true);
  });

  test("'describe' and 'compare' → true", () => {
    expect(isMultiPart("describe chlorine and compare it to bromine")).toBe(true);
  });

  test("single imperative verb → false", () => {
    expect(isMultiPart("explain biofilm formation")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signal 4: additive connective
// ─────────────────────────────────────────────────────────────────────────────

describe("isMultiPart — signal 4: additive connective", () => {
  test("'also' present → true", () => {
    expect(isMultiPart("what is chloramine, also how does it compare")).toBe(true);
  });

  test("'as well as' present → true", () => {
    expect(isMultiPart("explain pH as well as alkalinity")).toBe(true);
  });

  test("'in addition' present → true", () => {
    expect(isMultiPart("treat scale, in addition handle corrosion")).toBe(true);
  });

  test("'additionally' present → true", () => {
    expect(isMultiPart("test the water; additionally check the pumps")).toBe(true);
  });

  test("'also' not present and no other signal → false", () => {
    // Important: this query has no additive connective AND nothing else fires.
    expect(isMultiPart("chlorine dosing matters")).toBe(false);
  });

  test("'also' inside another word does not match", () => {
    // \balso\b — word boundary. "alsoever" would match but no such word exists.
    // "Walso" wouldn't match because \b requires a word boundary.
    expect(isMultiPart("Walsovich is a name")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signal 5: strong sentence boundary (4+ / . / 4+)
// ─────────────────────────────────────────────────────────────────────────────

describe("isMultiPart — signal 5: strong sentence boundary (4+ both sides)", () => {
  test("4+ chars before and after period → true", () => {
    // Both sides need 4+ word chars. "Treatment fails. Replace the tower."
    // — "Treatment" is 9, "Replace" is 7.
    expect(isMultiPart("Treatment fails. Replace the tower.")).toBe(true);
  });

  test("rejects 'L. pneumophila' (1 char before period) → false", () => {
    expect(isMultiPart("L. pneumophila is dangerous")).toBe(false);
  });

  test("rejects 'e.g. chlorine' (1 char component) → false", () => {
    expect(isMultiPart("e.g. chlorine is common")).toBe(false);
  });

  test("rejects decimal '7.5 ppm' (digits, not enough word chars) → false", () => {
    // 7.5 — 7 is 1 word char before dot, 5 is 1 after; fails 4+ both sides.
    expect(isMultiPart("the pH was 7.5 ppm")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signal 6: weaker sentence boundary (3+ / . / Uppercase)
// ─────────────────────────────────────────────────────────────────────────────

describe("isMultiPart — signal 6: sentence boundary with uppercase", () => {
  test("3+ chars before, uppercase right after → true", () => {
    expect(isMultiPart("Test pump now. The result will be clear")).toBe(true);
  });

  test("Mrs. Smith — 3 chars before, uppercase right after → true (accepted FP)", () => {
    // Documented false positive for the underlying detection. Honorific
    // protection lives in greedySplit, not in isMultiPart; the detector
    // is liberal by design.
    expect(isMultiPart("Mrs. Smith said hello")).toBe(true);
  });

  test("1-2 chars before period → false", () => {
    // "L. Pneumophila" — single capital before period, fails 3+ rule.
    expect(isMultiPart("L. Pneumophila is dangerous")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signal 7: greeting + content
// ─────────────────────────────────────────────────────────────────────────────

describe("isMultiPart — signal 7: greeting at start with content past a punctuation break", () => {
  test("'Hello! What is biofilm?' → true (greeting + ! + content)", () => {
    expect(isMultiPart("Hello! What is biofilm?")).toBe(true);
  });

  test("'thanks! how do I prevent scale?' → true (greeting + ! + content)", () => {
    expect(isMultiPart("thanks! how do I prevent scale?")).toBe(true);
  });

  test("'hello, can I talk to someone?' → true (greeting + , + content)", () => {
    expect(isMultiPart("hello, can I talk to someone?")).toBe(true);
  });

  test("'thanks for the info! how do I prevent scale?' → true (preamble between greeting and !)", () => {
    expect(isMultiPart("thanks for the info! how do I prevent scale?")).toBe(true);
  });

  test("'Hi how are you' → false (grammatical continuation, single intent)", () => {
    // Without punctuation between greeting and content, the line is a
    // single conversational utterance — not a discrete greeting + new
    // intent. Routing this through multi-part would split a coherent
    // sentence in half.
    expect(isMultiPart("Hi how are you")).toBe(false);
  });

  test("'Thanks for the help' → false (grammatical continuation, single intent)", () => {
    // 'thanks for X' is one conversational utterance — the user is
    // thanking the assistant for the X. No multi-part intent.
    expect(isMultiPart("Thanks for the help")).toBe(false);
  });

  test("'good morning here is my question' → false (grammatical continuation)", () => {
    // Without punctuation, this is a single sentence introducing a
    // question — not two separate intents. Real users almost always
    // add ", " or "! " here in practice; without those markers we
    // treat the input as one segment.
    expect(isMultiPart("good morning here is my question")).toBe(false);
  });

  test("'thanks!!!' → false (no real content after the greeting)", () => {
    // Trailing-punctuation-only inputs were a regression in the
    // earlier signal-7 definition — the greeting peel would
    // backtrack to leave a stray "!" as a phantom segment. The new
    // signal requires an alphanumeric character after the
    // punctuation, rejecting these degenerate cases at the source.
    expect(isMultiPart("thanks!!!")).toBe(false);
  });

  test("'Hello' alone → false (no content after greeting)", () => {
    expect(isMultiPart("Hello")).toBe(false);
  });

  test("greeting buried mid-query does not trigger signal 7", () => {
    // ^ anchor requires the greeting at the start.
    expect(isMultiPart("explain why people say hello")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Negative cases — single-intent queries
// ─────────────────────────────────────────────────────────────────────────────

describe("isMultiPart — negatives", () => {
  test("simple single question → false", () => {
    expect(isMultiPart("what is chlorine dosing?")).toBe(false);
  });

  test("single statement → false", () => {
    expect(isMultiPart("Biofilm grows in cooling towers")).toBe(false);
  });

  test("'how do I prevent scale' → false (single intent)", () => {
    expect(isMultiPart("how do I prevent scale")).toBe(false);
  });

  test("scientific term with single-letter abbreviation → false", () => {
    expect(isMultiPart("L. pneumophila is dangerous")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("isMultiPart — edge cases", () => {
  test("empty string → false", () => {
    expect(isMultiPart("")).toBe(false);
  });

  test("whitespace-only → false", () => {
    expect(isMultiPart("   ")).toBe(false);
  });

  test("single word → false", () => {
    expect(isMultiPart("biofilm")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Repeated-punctuation invariance
// ─────────────────────────────────────────────────────────────────────────────

describe("isMultiPart — repeated punctuation does not perturb signal evaluation", () => {
  test("'thanks!!!' matches 'thanks!' (both false)", () => {
    expect(isMultiPart("thanks!!!")).toBe(isMultiPart("thanks!"));
  });

  test("'help???' matches 'help?' (both false)", () => {
    expect(isMultiPart("help???")).toBe(isMultiPart("help?"));
  });

  test("'hello??!!!???!!' keymash matches 'hello?' (both false)", () => {
    expect(isMultiPart("hello??!!!???!!")).toBe(isMultiPart("hello?"));
  });

  test("'what is pH??? what is alkalinity!!!' matches 'what is pH? what is alkalinity!' (both true)", () => {
    expect(isMultiPart("what is pH??? what is alkalinity!!!")).toBe(
      isMultiPart("what is pH? what is alkalinity!")
    );
  });

  test("'thanks!!! how do I prevent scale???' multi-parts like the clean form", () => {
    expect(isMultiPart("thanks!!! how do I prevent scale???")).toBe(
      isMultiPart("thanks! how do I prevent scale?")
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("isMultiPart — module export", () => {
  test("module is the function itself", () => {
    expect(typeof isMultiPart).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(isMultiPart)).toBe(true);
  });

  test("self-referential isMultiPart.isMultiPart property", () => {
    expect(isMultiPart.isMultiPart).toBe(isMultiPart);
  });
});