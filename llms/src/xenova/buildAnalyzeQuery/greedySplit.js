"use strict";

const collapseRepeatedPunctuation = require("./collapseRepeatedPunctuation");

/**
 * @file greedySplit.js
 * @module xenova/buildAnalyzeQuery/greedySplit
 * @description Local regex-based splitter for multi-part user queries.
 *
 * Companion to {@link isMultiPart}. Where `isMultiPart` answers "does
 * this query look multi-part?" (a boolean signal), `greedySplit`
 * actually divides the query into segments, mirroring the same boundary
 * types `isMultiPart` detects.
 *
 * Stage-based design. Rather than a single complex regex covering every
 * boundary type, the splitter applies a pipeline of focused stages, each
 * handling one type of split:
 *
 *   1. Greeting peel    — strip "Hello!" / "Hi there" / "Thanks" off the front.
 *   2. Terminators      — split on `?` or `!` followed by content.
 *   3. Sentence dots    — split on period between sentences, with care to
 *                          preserve enumerations, decimals, and acronyms.
 *   4. Additive openers — split on " also ", " in addition ", etc.
 *   5. Connective+intent — split on " and " when followed by a question
 *                           or imperative word.
 *
 * Each stage takes `string[]` and returns `string[]` (possibly longer).
 * Stages are independent and order is deterministic — greeting peel runs
 * first because greetings can hide other boundaries; question marks run
 * before period-based splits because `?` is unambiguous; "and + intent"
 * runs last because it's the most heuristic.
 *
 * Failure mode is silent and friendly. If no stage finds a boundary, the
 * function returns `[originalQuery]` — a single-element array. Callers
 * use `result.length > 1` as the "did we actually split anything?"
 * signal, which is the gate for escalating to the LLM splitter when the
 * heuristic was confident there were multiple intents (`isMultiPart`
 * said true) but the greedy pass couldn't find them.
 *
 * Conservative on sentence boundaries. The 4+ chars-on-both-sides rule
 * for period splits is intentionally tight — it rejects abbreviations
 * (`L. pneumophila`, `Dr. Smith`, `e.g. chlorine`), decimals (`7.5 ppm`),
 * and noise that would otherwise produce bad splits. A bad split costs
 * downstream pipeline cycles (each segment goes through its own RAG path)
 * and degrades retrieval (the half-segments don't carry full context),
 * so the bias is toward under-splitting. False negatives here are
 * caught by the orchestrator's `isMultiPart && pieces.length === 1`
 * check, which can fall back to the LLM splitter for the hard cases.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 — Greeting peel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Closed set of greeting tokens. Lowercase, with multiword variants
 * spelled out. Matched case-insensitively at the start of a segment.
 *
 * The leading greeting is peeled off as its own segment, preserving any
 * trailing punctuation (`!`, `.`, `,`) that gives it the right tone in
 * the conversational reply path — "Hello!" reads differently from "Hello".
 */
const GREETING_RE = new RegExp(
  // Group 1 captures the greeting itself.
  // Group 2 captures the separator between the greeting and the rest of
  // the query. The separator must contain at least one punctuation mark
  // (`!`, `,`, or `.`) — whitespace alone is grammatical continuation
  // ("thanks for explaining"), not a peel boundary. We allow optional
  // whitespace around the punctuation so "thanks !" and "thanks ! ok"
  // still split.
  // Group 3 captures the rest. It must START with an alphanumeric
  // character, not just non-whitespace — otherwise residual punctuation
  // after a greeting ("thanks!!!" with the regex engine backtracking the
  // separator to leave the last "!" as the rest) would produce a phantom
  // segment. Real content always starts with a letter or digit.
  "^(" +
    "hi(?:\\s+there)?" +
    "|hello(?:\\s+there)?" +
    "|hey(?:\\s+there)?" +
    "|thanks?(?:\\s+you)?" +
    "|good\\s+(?:morning|afternoon|evening)" +
  ")" +
  "(\\s*[!,.][!,.\\s]*)" +  // separator: must include at least one !,.
  "([A-Za-z0-9].*)$",        // rest: must start with an alphanumeric char
  "i"
);

const peelGreeting = (segments) => {
  const result = [];
  for (const seg of segments) {
    const m = seg.match(GREETING_RE);
    if (m) {
      // Preserve the trailing punctuation if it's "!" or "." — those carry
      // tone. Drop commas and whitespace-only separators.
      const sep = m[2].trim();
      const greeting = sep && /^[!.]+$/.test(sep)
        ? `${m[1]}${sep}`
        : m[1];
      result.push(greeting, m[3]);
    } else {
      result.push(seg);
    }
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 — Question marks and exclamations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split on `?` or `!` followed by whitespace and more content. Both
 * marks are unambiguous clause terminators in query input. The mark
 * stays on the left side so each segment retains its terminal
 * punctuation. Multiple consecutive marks (`???`, `!!!`) are treated
 * as one boundary — we split on the position after the run, not after
 * each one.
 *
 * Why both in one stage: a greeting like "thanks for the info! how do
 * I prevent scale?" has `!` mid-query without immediate-greeting
 * punctuation (so `peelGreeting` skips it). The mid-query `!` is a
 * legitimate clause boundary, identical in role to `?`, and should
 * split. Handling them in one stage keeps the semantics symmetric.
 */
const TERMINATOR_RE = /(?<=[?!])\s+(?=\S)/g;

const splitOnTerminators = (segments) => {
  const result = [];
  for (const seg of segments) {
    const parts = seg.split(TERMINATOR_RE);
    for (const p of parts) {
      const trimmed = p.trim();
      if (trimmed) result.push(trimmed);
    }
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — Sentence dots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Honorifics and short abbreviations that look identical to a real
 * sentence boundary (2-5 alpha chars followed by `.` and a capital).
 * Without protection these get split — "Dr." becomes its own segment,
 * leaving "Smith said hi" as a separate piece.
 *
 * The list is copied from `utilities/textSegmentation/protectDots` and
 * inlined here rather than pulled in via that utility because protectDots
 * does much more than honorific masking — it also handles URLs,
 * emails, filenames, and outline headers, some with different
 * assumptions than our query-splitting case needs (URLs greedily eat
 * trailing periods; outline patterns require line-start anchoring).
 * The honorific subset is the only piece we need.
 *
 * Order matters within the alternation: longer prefixes that share a
 * head with shorter ones don't exist here (we don't have both `Dr` and
 * `Drs`), but if we ever add such a pair, the longer must come first.
 *
 * NOTE: this regex must be created with `g` flag for the `replace`
 * callback to fire on every match.
 */
const HONORIFIC_RE = /\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|Mt|Fig|Eq|Ref|Vol|No|pp|p|vs|etc|cf|al|approx|Inc|Ltd|Co|Corp)\.|\b(?:e\.g|i\.e|et\sal)\./g;

/**
 * Mask honorifics in `text` with NULL-delimited placeholder tokens.
 * Returns the masked text and a dictionary for restoration. NULL bytes
 * (`\x00`) are used as delimiters because they don't appear in
 * user-supplied text and won't collide with any character class in our
 * splitting regexes.
 *
 * @returns {{ masked: string, dict: Object<string,string> }}
 */
const maskHonorifics = (text) => {
  const dict = {};
  let counter = 0;
  const masked = text.replace(HONORIFIC_RE, (match) => {
    const token = `\x00H${counter++}\x00`;
    dict[token] = match;
    return token;
  });
  return { masked, dict };
};

/**
 * Restore honorific placeholders to their original strings. Inverse of
 * `maskHonorifics`. The dictionary's entries are walked once each; for
 * the small honorific counts we see in queries (≤2 per segment in
 * practice) this is faster than a single mega-regex.
 */
const restoreHonorifics = (text, dict) => {
  let result = text;
  for (const [token, original] of Object.entries(dict)) {
    result = result.replaceAll(token, original);
  }
  return result;
};

/**
 * Two regexes, run in sequence, catch real sentence boundaries while
 * rejecting things that look like them but aren't:
 *
 *   - SENTENCE_DOT_RE: 4+ char word on BOTH sides of the period.
 *     Catches the easy cases: "Biofilm grows. Treat aggressively."
 *
 *   - SENTENCE_CAP_RE: 2+ alpha chars before the period, capital letter
 *     after. Catches short trailing words: "Biofilm builds up. Treat it."
 *     ("up" is only 2 chars — SENTENCE_DOT_RE misses it, SENTENCE_CAP_RE
 *     catches it via the capital letter on the right.)
 *
 * The 2+ alpha requirement on the LEFT side of SENTENCE_CAP_RE is what
 * rejects the false-positive patterns:
 *
 *   - Enumerations: "1. First item", "Chapter 3. Overview"
 *       The "word" before the dot is purely digits — no alpha chars —
 *       so neither regex matches. Enumerations stay as one segment.
 *
 *   - Single-letter abbreviations: "L. pneumophila", "E. coli"
 *       Only 1 alpha char before the dot. Neither regex matches.
 *       Preserves scientific names and other initial-letter abbreviations.
 *
 *   - Lowercase acronym openers: "e.g. chlorine works", "i.e. that's it"
 *       Right side is lowercase, fails both regexes' right-side checks
 *       (and the multi-dot internal structure is masked by the honorific
 *       pre-pass as a defense-in-depth).
 *
 * Honorifics (Dr., Mrs., Prof., Fig., etc.) are pre-masked by
 * `maskHonorifics` before either regex runs, then restored afterward.
 * Without that pre-pass, "Mrs. Smith" would split — `Mrs` is 3 alpha,
 * Smith is capitalized — and SENTENCE_CAP_RE would match.
 */
const SENTENCE_DOT_RE = /(?<=\b\w{4,}\.)\s+(?=\w{4,})/g;
const SENTENCE_CAP_RE = /(?<=\b[A-Za-z]{2,}\.)\s+(?=[A-Z])/g;

const splitOnSentenceDots = (segments) => {
  const result = [];
  for (const seg of segments) {
    // 1. Mask honorifics so they don't trip the splitter regexes.
    const { masked, dict } = maskHonorifics(seg);

    // 2. First pass: split on the 4+/4+ rule.
    const afterDotSplit = masked.split(SENTENCE_DOT_RE);

    // 3. Second pass: split on the 2+alpha/capital rule.
    const intermediate = [];
    for (const p of afterDotSplit) {
      for (const q of p.split(SENTENCE_CAP_RE)) {
        intermediate.push(q);
      }
    }

    // 4. Restore honorifics in each resulting segment.
    for (const p of intermediate) {
      const restored = restoreHonorifics(p, dict).trim();
      if (restored) result.push(restored);
    }
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage 4 — Additive openers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split before additive connectives that introduce a new clause. The
 * connective stays on the right side (matches LLM splitter examples
 * like `"Also I would need urgent support"`).
 *
 * The split point requires preceding punctuation — `.`, `?`, or `,` —
 * before the whitespace. This distinguishes clause-opening usage
 * ("X. Also Y", "X, also Y") from inline adverb usage ("X is also Y",
 * "can also do Y"). Without the punctuation gate, "E. coli is also
 * dangerous" would incorrectly split at "also".
 *
 * Segment-start usage ("Also need urgent help") doesn't need splitting
 * — by the time we get here, an earlier stage has already isolated the
 * "Also..." clause as its own segment.
 *
 * Connectives matched: "also", "additionally", "as well as", "in
 * addition". All at a word boundary so we don't match "altogether",
 * "addition" mid-word, etc.
 */
const ADDITIVE_OPENER_RE = /(?<=[.?,])\s+(?=(?:also|additionally|as\s+well\s+as|in\s+addition)\b)/gi;

const splitOnAdditiveOpeners = (segments) => {
  const result = [];
  for (const seg of segments) {
    const parts = seg.split(ADDITIVE_OPENER_RE);
    for (const p of parts) {
      const trimmed = p.trim();
      if (trimmed) result.push(trimmed);
    }
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5 — Connective + intent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split on " and " when followed by a question or imperative word.
 *
 * This is the most heuristic stage. "and" can join nouns ("salt and
 * pepper"), clauses ("X happened and Y followed"), or queries ("what
 * is X and how do I Y"). Only the last case should split. We use the
 * lookahead to require an intent-word follows — that distinguishes
 * clause-joining-with-new-intent from the other uses.
 *
 * The "and" itself is consumed by the split (it sits between segments,
 * not inside either), so the right-side segment starts with the
 * intent word directly.
 */
const CONNECTIVE_INTENT_RE = /\s+and\s+(?=(?:what|why|how|who|where|when|which|explain|describe|tell|show|list|define|compare|summarize)\b)/gi;

const splitOnConnectiveIntent = (segments) => {
  const result = [];
  for (const seg of segments) {
    const parts = seg.split(CONNECTIVE_INTENT_RE);
    for (const p of parts) {
      const trimmed = p.trim();
      if (trimmed) result.push(trimmed);
    }
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// Public function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Greedily split a multi-part query into segments.
 *
 * Returns `[query]` (single element) when no boundaries are found —
 * including for queries that already look like one intent. Callers
 * use `result.length > 1` to detect a successful split; a `length === 1`
 * result combined with `isMultiPart(query) === true` is the signal to
 * escalate to the LLM splitter.
 *
 * Boundaries are detected in this order:
 *   1. Greeting peel  (separates "Hello!" from following content)
 *   2. Terminators    (each `?` or `!` ends a segment)
 *   3. Sentence dots  (period between 4+ char words)
 *   4. Additive openers (before "also", "in addition", etc.)
 *   5. Connective + intent ("and" followed by a question/imperative word)
 *
 * @function greedySplit
 * @param {string} query - The user query. Whitespace-trimmed internally.
 * @returns {string[]} One element per detected segment. Always at least
 *   one element (`[trimmedQuery]` when no boundary matched).
 *
 * @example
 *   greedySplit("what is biofilm? how do I remove it?");
 *   // → ["what is biofilm?", "how do I remove it?"]
 *
 *   greedySplit("Hello! What is biofilm?");
 *   // → ["Hello!", "What is biofilm?"]
 *
 *   greedySplit("what is X and how do I prevent Y");
 *   // → ["what is X", "how do I prevent Y"]
 *
 *   greedySplit("L. pneumophila is dangerous");
 *   // → ["L. pneumophila is dangerous"]    (no split — too risky)
 *
 *   greedySplit("Hi! How do I clean my system? Also need urgent help");
 *   // → ["Hi!", "How do I clean my system?", "Also need urgent help"]
 */
const greedySplit = (query) => {
  // Normalize repeated punctuation runs ("!!!" → "!", "???" → "?", etc.)
  // before any boundary detection runs. The repetition is user emphasis,
  // not structural information, and the stage regexes can produce
  // spurious splits or skip real boundaries when punctuation
  // accumulates. This is destructive — output segments contain the
  // collapsed form, not the original. Same-character runs only —
  // mixed adjacent marks like "?!" are preserved.
  const normalized = collapseRepeatedPunctuation((query || "").trim());
  let segments = [normalized].filter(Boolean);

  segments = peelGreeting(segments);
  segments = splitOnTerminators(segments);
  segments = splitOnSentenceDots(segments);
  segments = splitOnAdditiveOpeners(segments);
  segments = splitOnConnectiveIntent(segments);

  // If everything got dropped (e.g. empty input), return [""] so the
  // caller always gets an array. The "no split happened" signal is
  // `segments.length === 1 && segments[0] === normalized`.
  return segments.length === 0 ? [""] : segments;
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(greedySplit, "greedySplit", {
  value: greedySplit,
}));