"use strict";

const embedQuery                  = require("../embedQuery");
const isMultiPart                 = require("./isMultiPart");
const greedySplit                 = require("./greedySplit");
const buildClassifier             = require("./buildClassifier");
const detectFrustration           = require("./detectFrustration");
const peelGreeting                = require("./peelGreeting");
const collapseRepeatedPunctuation = require("./collapseRepeatedPunctuation");

/**
 * @file index.js
 * @module xenova/buildAnalyzeQuery
 * @description Factory that builds a query analyzer composing
 * frustration detection, greeting peel, multi-part detection,
 * greedy splitting, and per-segment classification.
 *
 * The analyzer is the entry point a dispatcher uses to decide how a
 * query should be routed AND how to phrase the response. It produces:
 *
 *   - A cleaned query string (whatever remains after greeting peel
 *     and punctuation normalization). Downstream consumers can use
 *     this instead of reconstructing it from segments.
 *   - A frustration object describing emotional state markers in the
 *     raw input (ALL CAPS, repeated punctuation, urgency keywords,
 *     profanity). The LLM prompt can use this to adjust tone.
 *   - A boolean `greeting` flag, true when the input contained any
 *     standalone greeting clause. The LLM prompt uses this to greet
 *     back when appropriate.
 *   - Segment classifications for each piece of the cleaned query,
 *     or an empty `segments` array when the input was greeting-only.
 *
 * Pipeline order:
 *
 *   1. Trim raw input.
 *   2. `detectFrustration` on the raw (trimmed) input. MUST run
 *      before spell correction AND before collapseRepeatedPunctuation,
 *      because both destroy the very signals frustration looks for
 *      (caps, repeated punctuation, no-apostrophe contractions).
 *   3. Spell correction via the optional caller-supplied `spellEngine`.
 *      Fixes typos, expands no-apostrophe contractions (`wont` →
 *      `won't`), and normalizes punctuation. Skipped when no engine
 *      is provided.
 *   4. `collapseRepeatedPunctuation` — normalize "!!!" → "!" etc.
 *      Belt-and-suspenders: SpellEngine already collapses repeated
 *      punctuation internally, but running this again is a cheap
 *      no-op that keeps the pipeline correct when no engine is wired.
 *   5. `peelGreeting` — strip standalone greetings, return cleaned
 *      query and greeting flag.
 *   6. If cleaned query is empty (greeting-only input), return early
 *      with `segments: []`.
 *   7. `isMultiPart` on cleaned query.
 *   8. `greedySplit` if multi-part, else single-segment fast path.
 *   9. Classify each segment.
 *
 * Cost model:
 *   - Steps 1-2 are pure-regex, microsecond-fast.
 *   - Step 3 (when engine is provided) is dictionary lookup +
 *     occasional nspell suggestion per word token. Typically
 *     sub-millisecond for short queries; can spike to a few ms for
 *     queries containing words the nspell dictionary must `suggest()`
 *     for. Skipped entirely when no engine is wired.
 *   - Steps 4-7 are pure-regex.
 *   - Step 8 is pure-regex.
 *   - Step 9 invokes the classifier per segment. Each BGE
 *     classification is ~5-30ms warm; NLI fallback adds ~100-300ms
 *     when triggered.
 *   - Greeting-only inputs cost essentially nothing past step 6.
 *
 * The factory is async (builds the classifier at boot, which embeds
 * anchors). The returned analyzer is async per call (may embed
 * segments or run NLI). Call the factory once at server boot and
 * cache the result.
 */

/**
 * Build a query analyzer.
 *
 * @async
 * @function buildAnalyzeQuery
 *
 * @param {object} [options]
 *   Pass-through configuration for the underlying classifier. See
 *   {@link buildClassifier} for the full schema. Common cases:
 *   - No args → no TECHNICAL anchors (Mode 2 / open-world classifier).
 *     The analyzer routes by absence: a query is TECHNICAL unless it
 *     clearly matches SUPPORT or CONVERSATIONAL.
 *   - `{ classes: { TECHNICAL: { anchors: [...] } } }` → Mode 1 with
 *     caller-supplied domain anchors. Sharper classification.
 * @param {object} [options.spellEngine]
 *   Optional spell-correction engine implementing `correct(text) →
 *   text`. When provided, the analyzer applies `spellEngine.correct`
 *   to the raw input AFTER frustration detection and BEFORE
 *   greeting peel. Fixes typos, expands no-apostrophe contractions
 *   (e.g. `wont` → `won't`), and normalizes punctuation. The
 *   corrected form is what the analyzer embeds, classifies, and
 *   surfaces back to the caller via the `corrected` output field —
 *   so dispatchers can echo "you asked: <corrected>" to give the
 *   user visibility into autocorrect. Skipped when not provided;
 *   pipeline runs as if the user typed exactly what they meant.
 *
 * @returns {Promise<(queryString: string, queryVec?: Float32Array) => Promise<{
 *   query:         string,
 *   corrected:     string,
 *   greeting:      boolean,
 *   frustration:   {
 *     score:               number,
 *     shouting:            boolean,
 *     allCaps:             boolean,
 *     repeatedPunctCount:  number,
 *     urgentKeywords:      string[],
 *     profanity:           boolean
 *   },
 *   multiPart:     boolean,
 *   splitOk:       boolean,
 *   needsLLMSplit: boolean,
 *   segments: Array<{
 *     text:           string,
 *     vec:            Float32Array,
 *     classification: { label, confidence, scores, lowConfidence, usedNli }
 *   }>
 * }>>}
 *   Async analyzer closure. Inputs:
 *   - `queryString` — required. The raw user query (NOT pre-corrected;
 *     the analyzer handles spell correction internally if a spellEngine
 *     was provided to the factory).
 *   - `queryVec` — optional. The query's embedding (caller's
 *     dispatcher pre-embeds it once for both classification and
 *     downstream retrieval). When omitted, the analyzer embeds the
 *     cleaned query itself. NOTE: queryVec is only reused when the
 *     cleaned query equals the raw query (no spell correction, no
 *     collapse, no greeting peel happened). Otherwise the analyzer
 *     freshly embeds the cleaned form, since the pre-computed
 *     embedding is for the wrong string.
 *
 *   Output:
 *   - `query` — the cleaned query (post-spell-correction, post-
 *     collapse, post-greeting-strip). Empty string when the input
 *     was greeting-only.
 *   - `corrected` — the spell-corrected form of the raw input,
 *     BEFORE greeting peel. Suitable for echoing back to the user
 *     as "you asked: <corrected>" so they can see what autocorrect
 *     did. Equals `raw` when no spellEngine was wired or when no
 *     corrections fired.
 *   - `greeting` — true when the input contained any standalone
 *     greeting clause that was peeled.
 *   - `frustration` — emotion-marker analysis on the raw input.
 *   - `multiPart` — true if {@link isMultiPart} fired on the cleaned
 *     query. False when the cleaned query is empty.
 *   - `splitOk` — true if {@link greedySplit} produced >1 segment.
 *   - `needsLLMSplit` — true when `multiPart && !splitOk`, signaling
 *     to the dispatcher that the greedy regex couldn't find
 *     boundaries the isMultiPart heuristic insists are there.
 *   - `segments` — Array of classified segments. EMPTY when the
 *     input was greeting-only (`greeting: true` and `query: ""`).
 *     The dispatcher uses `segments.length === 0` plus the flags to
 *     detect this case and respond with a pure-greeting reply.
 */
const buildAnalyzeQuery = async ({ spellEngine, ...options } = {}) => {
  const classify = await buildClassifier(options);

  const analyzeQuery = async (queryString, queryVec) => {
    // ── Step 1: trim raw input ───────────────────────────────────────────
    const raw = (queryString || "").trim();
    if (process.env.NEREUS_DEBUG_RETRIEVAL) {
      console.log("[analyzer] raw:", JSON.stringify(raw));
    }

    // ── Step 2: detect frustration on RAW input ──────────────────────────
    // The repeated-punctuation, ALL-CAPS, and no-apostrophe-contraction
    // signals all depend on the original form. Spell correction (next
    // step) would expand "WONT" to "won't" and collapse "!!!" to "!" —
    // erasing exactly the markers we need here.
    const frustration = detectFrustration(raw);
    if (process.env.NEREUS_DEBUG_RETRIEVAL) {
      console.log("[analyzer] frustration:", frustration);
    }

    // ── Step 3: spell correction (optional) ──────────────────────────────
    // When the caller supplied a spellEngine to the factory, run it on
    // the raw input. Fixes typos via domain dictionary + nspell, expands
    // no-apostrophe contractions via the corrections map (e.g. "wont" →
    // "won't"), and normalizes punctuation. The corrected form is what
    // we use everywhere downstream AND what we surface to the caller as
    // the `corrected` output field — dispatchers can echo it back to
    // the user as "you asked: <corrected>" for autocorrect transparency.
    const corrected = spellEngine ? spellEngine.correct(raw) : raw;

    // ── Step 4: normalize repeated punctuation ───────────────────────────
    // "!!!" → "!", "???" → "?", "?!?!" → "?". Same-character and
    // cross-character terminal-punct runs both collapse. Non-terminal
    // punctuation (`,.;:`) only collapses adjacent same-char runs to
    // preserve structures like "e.g." and decimals.
    //
    // When SpellEngine ran (Step 3), it already collapsed repeated
    // punctuation internally. Running it again is a no-op on already-
    // normalized text; we keep this step so the pipeline produces the
    // same `collapsed` shape regardless of whether spellEngine was
    // wired.
    const collapsed = collapseRepeatedPunctuation(corrected);

    // ── Step 5: peel greetings from anywhere in the query ────────────────
    // Returns the cleaned query AND a flag. "hello, what is pH?"
    // becomes "what is pH?" with greeting=true. "thanks for the
    // info" stays untouched (no peel — "thanks" is followed by
    // content, not standalone).
    const { greeting, query: cleaned } = peelGreeting(collapsed);

    // ── Step 6: greeting-only fast path ──────────────────────────────────
    // When the cleaned query is empty, there's no content to
    // classify. Return the flags and an empty segments array. The
    // dispatcher detects this case via `segments.length === 0 &&
    // greeting === true` and responds with a pure-greeting reply
    // (probably without any RAG retrieval).
    if (!cleaned) {
      return {
        query:         "",
        corrected,
        greeting,
        frustration,
        multiPart:     false,
        splitOk:       false,
        needsLLMSplit: false,
        segments:      [],
      };
    }

    // ── Step 7: single-intent fast path ──────────────────────────────────
    // No multi-part signal → classify the cleaned query as one
    // segment. Reuse the caller's queryVec if provided AND if the
    // cleaned query matches the raw query exactly (no spell
    // correction, no collapse, no greeting peel happened) —
    // otherwise the pre-computed embedding is for the wrong string.
    if (!isMultiPart(cleaned)) {
      const canReuse = queryVec && cleaned === raw;
      const vec = canReuse ? queryVec : await embedQuery(cleaned);
      const classification = await classify(vec, cleaned);
      return {
        query:         cleaned,
        corrected,
        greeting,
        frustration,
        multiPart:     false,
        splitOk:       false,
        needsLLMSplit: false,
        segments:      [{ text: cleaned, vec, classification }],
      };
    }

    // ── Step 8: multi-part path — try greedy split ───────────────────────
    const pieces = greedySplit(cleaned);

    // Greedy failed: isMultiPart said true but the regex couldn't
    // find boundaries. Classify the whole cleaned query as a single
    // segment and flag the caller to consider escalation. We still
    // classify so the dispatcher has a usable label even if it
    // doesn't escalate to an LLM splitter.
    if (pieces.length === 1) {
      const canReuse = queryVec && cleaned === raw;
      const vec = canReuse ? queryVec : await embedQuery(cleaned);
      const classification = await classify(vec, cleaned);
      return {
        query:         cleaned,
        corrected,
        greeting,
        frustration,
        multiPart:     true,
        splitOk:       false,
        needsLLMSplit: true,
        segments:      [{ text: cleaned, vec, classification }],
      };
    }

    // Greedy succeeded: embed and classify each piece independently.
    // Pieces are different strings, so each needs its own embedding —
    // the caller's queryVec is no longer relevant once we've split.
    // Run in parallel; the embed step queues internally in Xenova.
    const segments = await Promise.all(pieces.map(async (text) => {
      const vec = await embedQuery(text);
      const classification = await classify(vec, text);
      return { text, vec, classification };
    }));

    return {
      query:         cleaned,
      corrected,
      greeting,
      frustration,
      multiPart:     true,
      splitOk:       true,
      needsLLMSplit: false,
      segments,
    };
  };

  return analyzeQuery;
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(buildAnalyzeQuery, "buildAnalyzeQuery", {
  value: buildAnalyzeQuery,
}));