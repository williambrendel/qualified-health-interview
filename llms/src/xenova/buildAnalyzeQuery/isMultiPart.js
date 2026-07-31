"use strict";

const collapseRepeatedPunctuation = require("./collapseRepeatedPunctuation");

/**
 * @file isMultiPart.js
 * @module xenova/buildAnalyzeQuery/isMultiPart
 * @brief Heuristic detection of multi-intent user queries.
 */

/**
 * Heuristic check for whether a user query contains multiple distinct
 * questions or intent components, expressed as questions or statements.
 *
 * Seven signals are checked — any single match returns `true`:
 *
 * 1. **Multiple distinct question marks** — two or more `?` that are not part
 *    of consecutive punctuation (e.g. `???` counts as one).
 *
 * 2. **Multiple question words** — two or more occurrences of `what`, `why`,
 *    `how`, `who`, `where`, `when`, or `which` separated by at least one
 *    character.
 *
 * 3. **Multiple imperative verbs** — two or more distinct action verbs from
 *    a closed set (`explain`, `describe`, `tell`, `show`, `list`, `define`,
 *    `compare`, `summarize`) separated by at least one character.
 *
 * 4. **Additive connective introducing a second clause** — explicit additive
 *    language (`also`, `as well as`, `in addition`, `additionally`).
 *
 * 5. **Strong sentence boundary** — a word of 4+ characters followed by `.`,
 *    `!`, or `?`, whitespace, and another word of 4+ characters. Rejects
 *    abbreviations (`Dr.`, `vs.`, `e.g.`), decimals, and short domain
 *    fragments (`L. pneumophila`) — these only contain `.`, not `!?`,
 *    and the 4+/4+ rule rejects the short-fragment cases.
 *
 * 6. **Sentence boundary with uppercase** — a word of 3+ characters followed
 *    by `.`, `!`, or `?`, whitespace, and an uppercase letter.
 *
 * 7. **Greeting followed by content past a punctuation break** — a greeting
 *    word (`hi`, `hello`, `hey`, `thanks`, `thank you`, `good
 *    morning/afternoon/evening`), followed by at least one punctuation mark
 *    (`!`, `,`, or `.`), followed by content containing at least one
 *    alphanumeric character. The punctuation requirement distinguishes
 *    discrete greeting + new intent ("thanks! what is biofilm?") from
 *    grammatical continuation ("thanks for explaining biofilm"). The
 *    alphanumeric requirement rejects degenerate inputs like "thanks!!!"
 *    where nothing follows but more punctuation.
 *
 * @function isMultiPart
 * @param {string} q - The corrected user query string.
 * @returns {boolean} `true` if the query appears to contain multiple distinct
 *   questions or intent components.
 *
 * @example
 * isMultiPart("what is a biofilm? how do I remove it?");  // → true  (signal 1)
 * isMultiPart("what causes X and how do I prevent it");   // → true  (signal 2)
 * isMultiPart("explain biofilm and tell me how to fix it"); // → true (signal 3)
 * isMultiPart("what is chloramine, also how does it compare"); // → true (signal 4)
 * isMultiPart("Biofilm builds up. Explain how to treat it."); // → true (signal 5)
 * isMultiPart("Hello! What is biofilm?");                 // → true  (signal 7)
 * isMultiPart("thanks for explaining biofilm");           // → false (no punctuation after greeting)
 * isMultiPart("thanks!!!");                               // → false (no real content after greeting)
 * isMultiPart("what is chlorine dosing?");                // → false
 * isMultiPart("L. pneumophila is dangerous");             // → false
 */
const isMultiPart = q => {
  // Normalize repeated punctuation runs ("!!!" → "!", "???" → "?", etc.)
  // before running any signal. The repetition is user emphasis, not
  // structural information, and several signals (notably 1, "multiple
  // ?") become noise-sensitive without this pass. Same-character runs
  // only — mixed adjacent marks like "?!" are preserved.
  q = collapseRepeatedPunctuation(q || "");

  return (
    // 1. Multiple distinct question marks.
    /\?(?!\?)/.test(q) && (q.match(/\?(?!\?)/g) || []).length > 1 ||
    // 2. Multiple question words.
    /\b(what|why|how|who|where|when|which)\b.+\b(what|why|how|who|where|when|which)\b/i.test(q) ||
    // 3. Multiple imperative verbs.
    /\b(explain|describe|tell|show|list|define|compare|summarize)\b.+\b(explain|describe|tell|show|list|define|compare|summarize)\b/i.test(q) ||
    // 4. Additive connective introducing a second clause.
    /\b(also|as well as|in addition|additionally)\b/i.test(q) ||
    // 5. Strong sentence boundary: word(4+) [.!?] word(4+).
    //    Includes `!` and `?` alongside `.` — all three are sentence
    //    terminators in user input. Adding them doesn't introduce
    //    false positives because decimals and honorifics only contain
    //    `.`, never `!` or `?`.
    /\b\w{4,}[.!?]\s+\w{4,}/.test(q) ||
    // 6. Weaker sentence boundary: word(3+) [.!?] Uppercase.
    /\b\w{3,}[.!?]\s+[A-Z]/.test(q) ||
    // 7. Greeting at the start, with punctuation somewhere after it,
    //    and alphanumeric content somewhere after the punctuation.
    //    Three conditions in sequence:
    //      - greeting + word boundary
    //      - any non-punctuation chars (the optional preamble: "for the
    //        info", or empty for "thanks!")
    //      - at least one of !,. (the boundary marker)
    //      - any non-alphanumeric chars (more punctuation, whitespace)
    //      - at least one alphanumeric (real content follows)
    //
    //    Rejects "thanks for X" (no !,. anywhere) and "thanks!!!" (after
    //    punctuation collapse this becomes "thanks!" — still no
    //    alphanumeric after the punctuation, so still rejected).
    //    Accepts greeting + content + boundary + content layouts like
    //    "thanks for the info! how do I prevent scale?".
    /^(hi|hello|hey|thanks|thank you|good morning|good afternoon|good evening)\b[^!,.]*[!,.][^A-Za-z0-9]*[A-Za-z0-9]/i.test(q.trim())
  );
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(isMultiPart, "isMultiPart", {
  value: isMultiPart,
}));