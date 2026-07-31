"use strict";

/**
 * @file peelGreeting.js
 * @module xenova/buildAnalyzeQuery/peelGreeting
 * @brief Strip standalone-clause greetings from anywhere in a query.
 *
 * Greetings ("hello", "thanks", "good morning", etc.) are metadata,
 * not intent. When a user writes "hello, what causes biofilm?", they
 * have one intent (the technical question) and one politeness
 * marker (the greeting). Routing the greeting as its own
 * CONVERSATIONAL segment forces the dispatcher to handle two pieces
 * when really one is enough — give the LLM the technical question
 * plus "user greeted you" as context, and it produces a single
 * appropriate response.
 *
 * This module replaces the per-segment greeting handling that
 * existed in `greedySplit.peelGreeting`. The difference: this version
 * runs BEFORE segmentation, on the entire query, and can find
 * greetings at the start, at the end, or between sentence-boundary
 * marks (`!?.`). The greedySplit stage 1 remains as a defensive
 * fallback for direct callers but is usually a no-op when the
 * orchestrator runs this first.
 *
 * Standalone-clause rule. A greeting peels only when it's a COMPLETE
 * CLAUSE — bounded by:
 *   - String start or end
 *   - Sentence-boundary punctuation (`!`, `?`, `.`)
 *   - Comma (treated as a soft clause boundary for greetings only)
 *
 * Examples that peel:
 *   "hello, what is pH?"       → "what is pH?"      (leading)
 *   "what is pH? thanks!"      → "what is pH?"      (trailing)
 *   "hi, what's pH? thanks."   → "what's pH?"       (both)
 *
 * Examples that DON'T peel:
 *   "thanks for the info"      → no peel — "thanks" is followed by
 *                                          content ("for the info"),
 *                                          so it's not standalone
 *   "the user said hello"      → no peel — "hello" is mid-clause
 *   "thanks I see"             → no peel — "thanks" with content
 *                                          after (no comma/period)
 *
 * Why a closed set of greetings? Ambiguity. "regards" can mean a
 * sign-off OR "with regards to X" (mid-clause technical phrase). A
 * closed set of high-confidence greeting tokens keeps the peel
 * conservative — never wrong, occasionally misses an exotic
 * greeting. The set is intentionally the same as `greedySplit`'s
 * GREETING_RE for consistency.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Greeting tokens
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Closed set of greeting phrases. Order matters within the
 * alternation — longer phrases must come first to prevent
 * partial-prefix matches (e.g. "good morning" must come before
 * "good" if "good" were ever in the set).
 *
 * The pattern matches the greeting as a standalone token: bounded
 * by `\b` on each side. Trailing tone punctuation (`!`, `.`, `,`)
 * is matched optionally as part of the greeting itself, so
 * "thanks!" peels cleanly leaving the rest.
 */
const GREETING_ALTERNATION = (
  "thank\\s+you" +
  "|thanks" +
  "|good\\s+morning" +
  "|good\\s+afternoon" +
  "|good\\s+evening" +
  "|hello\\s+there" +
  "|hi\\s+there" +
  "|hey\\s+there" +
  "|hello" +
  "|hey" +
  "|hi"
);

/**
 * Match a greeting at the START of the query, optionally followed by
 * tone punctuation (`!`, `,`, `.`) and whitespace.
 *
 * Capture group 1 is the greeting + its trailing tone punctuation
 * (kept for diagnostic / debugging, not used in output). The match
 * itself is what gets removed.
 */
const LEADING_GREETING_RE = new RegExp(
  "^(" +
    "(?:" + GREETING_ALTERNATION + ")" +
    "[!?.,]*" +    // optional tone punctuation
  ")" +
  "\\s+",          // required whitespace separator (so we don't peel "thanksfor")
  "i"
);

/**
 * Match a greeting at the END of the query. Symmetric to the leading
 * version: a sentence-boundary mark or whitespace precedes, then the
 * greeting, then optional tone punctuation, then end-of-string.
 *
 * Whitespace BEFORE the greeting is required so we don't peel a
 * greeting from inside a word.
 */
const TRAILING_GREETING_RE = new RegExp(
  "\\s+" +                                  // required whitespace
  "(?:" + GREETING_ALTERNATION + ")" +
  "[!?.,]*" +                                // optional tone punctuation
  "$",                                      // end of string
  "i"
);

/**
 * Match a greeting that sits as a standalone clause between sentence-
 * boundary marks. The clause must be ONLY the greeting (plus tone
 * punctuation) — `". thanks. "` peels, `". thanks for the info."`
 * doesn't.
 *
 * Pattern: (sentence-boundary char) (whitespace) (greeting + tone)
 *   (whitespace OR sentence-boundary). The trailing boundary stays
 * with what follows; only the greeting clause is removed.
 */
const STANDALONE_GREETING_RE = new RegExp(
  "(?<=[!?.])\\s+" +                        // preceding boundary
  "(?:" + GREETING_ALTERNATION + ")" +
  "[!?.,]*" +
  "(?=\\s|$)",                              // followed by whitespace or end
  "gi"
);

// ─────────────────────────────────────────────────────────────────────────────
// Public function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Peel greetings from a query, returning the cleaned query and a
 * flag indicating whether any greeting was found.
 *
 * @function peelGreeting
 * @param {string} query - The query (typically already normalized for
 *   repeated punctuation, but not required).
 * @returns {{ greeting: boolean, query: string }}
 *   - `greeting`: true if any greeting was peeled.
 *   - `query`: the cleaned string, trimmed. May be empty (when the
 *     original was only a greeting).
 *
 * @example
 *   peelGreeting("hello, what is pH?");
 *   // → { greeting: true, query: "what is pH?" }
 *
 *   peelGreeting("hello");
 *   // → { greeting: true, query: "" }
 *
 *   peelGreeting("what is pH? thanks!");
 *   // → { greeting: true, query: "what is pH?" }
 *
 *   peelGreeting("thanks for the info");
 *   // → { greeting: false, query: "thanks for the info" }
 *     (no peel — "thanks" is not standalone)
 *
 *   peelGreeting("what is biofilm?");
 *   // → { greeting: false, query: "what is biofilm?" }
 *
 *   peelGreeting("");
 *   // → { greeting: false, query: "" }
 */
const peelGreeting = (query) => {
  let q = (query || "").trim();
  if (!q) return { greeting: false, query: "" };

  let greeting = false;

  // Pass 1: leading greeting. The required trailing whitespace in
  // LEADING_GREETING_RE ensures "thanks for" doesn't match (no
  // whitespace immediately after the tone punct — actually there IS
  // whitespace, but the greeting word is "thanks", and after the
  // optional `[!?.,]*` we need whitespace then more content). Let me
  // walk through:
  //   "thanks for X" → matches "thanks" + zero tone punct + " " → peel
  //   That's wrong. Need to gate on "is this a standalone greeting
  //   or just a prefix of a larger phrase?". The rule: peel leading
  //   greeting only if followed by tone punctuation OR if the
  //   query is JUST the greeting. Continued in code below.
  const m = q.match(LEADING_GREETING_RE);
  if (m) {
    // m[1] includes the greeting + any tone punctuation that was
    // appended. If tone punct is present, this is a discrete
    // greeting + content scenario — peel.
    // If no tone punct, "thanks for X" would also match, which is
    // wrong (continuation, not greeting + content). So we require
    // tone punctuation in the leading peel.
    if (/[!?.,]/.test(m[1])) {
      q = q.slice(m[0].length).trim();
      greeting = true;
    }
  }

  // Pass 2: trailing greeting. Symmetric — only peel if there's a
  // preceding sentence-boundary mark, otherwise "tell me about
  // hello" would lose its noun. We approximate "sentence boundary
  // before" by checking that what precedes the matched whitespace
  // ends in `!?.,`.
  const trailMatch = q.match(TRAILING_GREETING_RE);
  if (trailMatch) {
    const before = q.slice(0, trailMatch.index);
    // The character at the end of `before` (before the matched
    // whitespace) should be `!`, `?`, `.`, or `,` — indicating the
    // trailing greeting is a distinct clause.
    if (/[!?.,]$/.test(before)) {
      q = before.trim();
      greeting = true;
    }
  }

  // Pass 3: standalone middle greetings. Replace any matches with
  // empty string. The lookbehind ensures we only peel when preceded
  // by a sentence-boundary mark.
  const beforeStandalone = q;
  q = q.replace(STANDALONE_GREETING_RE, "").replace(/\s+/g, " ").trim();
  if (q !== beforeStandalone) {
    greeting = true;
  }

  // Pass 4: greeting-only inputs. After the leading peel above, if
  // the original was something like "hello" with no tone punct, we
  // didn't peel (no tone-gate). Handle that case: if the entire
  // remaining query (case-insensitive) is exactly one greeting
  // phrase, peel it.
  if (q) {
    const onlyGreetingRe = new RegExp(
      "^(?:" + GREETING_ALTERNATION + ")[!?.,]*$",
      "i"
    );
    if (onlyGreetingRe.test(q)) {
      q = "";
      greeting = true;
    }
  }

  return { greeting, query: q };
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(
  peelGreeting,
  "peelGreeting",
  { value: peelGreeting }
));
