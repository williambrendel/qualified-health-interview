"use strict";

/**
 * @file collapseRepeatedPunctuation.js
 * @module xenova/buildAnalyzeQuery/collapseRepeatedPunctuation
 * @brief Normalize runs of repeated punctuation to a single mark.
 *
 * Real users type with varying emphasis: `"hello!!!"`, `"why???"`,
 * `"wait..."`. The repetition is decorative — it carries tone but no
 * structural meaning. For boundary detection (`isMultiPart`,
 * `greedySplit`) and downstream classification, the repetition is
 * noise that can produce spurious results:
 *
 *   - Multiple boundary detectors see "more punctuation than expected"
 *     and may fire on what is structurally one boundary.
 *   - The classifier reads `"???"` as urgency and pulls responses
 *     toward SUPPORT when the underlying intent is TECHNICAL.
 *   - Splitting can break apart a single utterance because the regex
 *     interprets trailing emphasis as a second segment.
 *
 * The fix is to collapse adjacent runs of the same punctuation
 * character to a single instance before any analysis runs.
 *
 * Scope. The collapse rules differ by character class:
 *
 *   - Terminal punctuation (`!`, `?`): any run of 2+ such marks
 *     collapses to the first mark in the run, INCLUDING runs that mix
 *     `!` and `?`. So `"!!"`, `"??"`, `"?!"`, `"!?!?"`, and
 *     `"??!!!???!!"` all collapse to a single mark. Justification: the
 *     marks are interchangeable for the boundary detector, and users
 *     who keymash terminal punctuation aren't conveying compositional
 *     intent — they're conveying emphasis.
 *
 *   - Non-terminal punctuation (`,`, `.`, `;`, `:`): only adjacent
 *     same-character runs collapse. `".."` → `"."`, `";;;"` → `";"`.
 *     Cross-character runs like `",.;"` aren't natural keymash patterns
 *     and protecting structures like `"e.g."` (which has two `.`s
 *     separated by a letter) matters more than aggressive collapsing.
 *
 * Ellipsis caveat. `"..."` (three-dot ellipsis) collapses to a single
 * `.`. This is intentional — for boundary detection purposes an
 * ellipsis behaves as one sentence terminator. The visual decoration
 * is lost, but the downstream analyzer doesn't need it.
 *
 * Honorifics, acronyms, decimals are unaffected. None of these
 * contain adjacent-same-character punctuation runs: `Dr.` has one `.`,
 * `e.g.` has two `.`s but separated by `g`, `7.5` has one `.`. The
 * regex only matches when a punctuation character repeats
 * CONSECUTIVELY.
 */

/**
 * @function collapseRepeatedPunctuation
 * @param {string} s - Input string. Falsy values pass through as-is.
 * @returns {string} The input normalized so that:
 *   - Any run of 2+ terminal marks (`!` or `?`), with or without
 *     other terminal marks mixed in, collapses to the first character
 *     of the run. E.g. `"??!!"` → `"?"`, `"!?!?"` → `"!"`,
 *     `"??!!!???!!"` → `"?"`.
 *   - Any run of 2+ same-character non-terminal punctuation (`,.;:`)
 *     collapses to one. E.g. `".."` → `"."`, `";;;"` → `";"`.
 *
 * Why two cases. Terminal punctuation (`!?`) is the place where users
 * actually keymash for emphasis or frustration. Treating
 * `"hello??!!!???!!"` as equivalent to `"hello?"` is correct for
 * boundary detection — the boundaries are the same and the user
 * intent is the same.
 *
 * Non-terminal punctuation (`,.;:`) doesn't get the same keymash
 * treatment because cross-character runs are very rare (`,;` is not
 * a thing people type) and protecting structures like `"e.g."`
 * matters. Only adjacent-identical runs collapse here.
 *
 * @example
 *   collapseRepeatedPunctuation("hello!!!");          // → "hello!"
 *   collapseRepeatedPunctuation("why???");            // → "why?"
 *   collapseRepeatedPunctuation("wait...");           // → "wait."
 *   collapseRepeatedPunctuation("hello!! what?");     // → "hello! what?"
 *   collapseRepeatedPunctuation("hello?!");           // → "hello?"  (run of 2 terminals)
 *   collapseRepeatedPunctuation("hello??!!!???!!");   // → "hello?"
 *   collapseRepeatedPunctuation("L. pneumophila");    // → "L. pneumophila"  (single dots)
 *   collapseRepeatedPunctuation("e.g. chlorine");     // → "e.g. chlorine"   (single dots)
 *   collapseRepeatedPunctuation("");                  // → ""
 *   collapseRepeatedPunctuation(null);                // → null
 */
const collapseRepeatedPunctuation = (s) => {
  if (!s) return s;
  return s
    // Cross-character runs of !? collapse to the first mark. Catches
    // "??", "!!", "?!", "!?", "?!?!", "??!!!???!!", etc. The capture
    // group preserves the first character so the run reduces to that.
    .replace(/([!?])[!?]+/g, "$1")
    // Adjacent same-char runs of other punctuation: `..`, `,,`, `;;`,
    // `::` collapse to one. Mixed runs of these are not common enough
    // to warrant cross-character collapse.
    .replace(/([,.;:])\1+/g, "$1");
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(
  collapseRepeatedPunctuation,
  "collapseRepeatedPunctuation",
  { value: collapseRepeatedPunctuation }
));