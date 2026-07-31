"use strict";

/**
 * @file serializeQueryContext.js
 * @module xenova/serializeQueryContext
 * @description Serializes a {@link buildAnalyzeQuery} analysis plus
 * retrieved knowledge into the compact text format consumed by the
 * second-pass reasoning LLM. Sibling of {@link buildAnalyzeQuery} —
 * both work with the same xenova-produced data shapes (analysis +
 * search hits).
 *
 * Lives under `xenova/` rather than `endpoints/` because its inputs
 * are entirely xenova-domain: the analyzer's output, and search hits
 * augmented with section text. Callers outside the endpoint layer
 * (batch evaluators, CLI tools, debug scripts) can use it directly
 * without reaching into endpoint-specific code.
 *
 * This module replaces the previous `toonify.js`. The old format
 * encoded Q&A-based search results with inline citations and a
 * multi-part block for the LLM to traverse. The new format is
 * sections-only, with a flat row list and no parts breakdown —
 * multi-part queries are handled at retrieval time (parts drive
 * retrieval; the LLM only sees the union).
 *
 * ## Output format
 *
 *     User query: {corrected query — spell-fixed, greeting still attached}
 *     Frustration: {score} ({level})           ← when frustration is non-trivial
 *     User intent: {intent1}, {intent2}, ...   ← always
 *     Results:[{N}]{score,documentId,range:[start,end],sectionText}:
 *     - {score},{documentId},[{start},{end}],{sectionText}
 *     - {score},{documentId},[{start},{end}],{sectionText}
 *     ...
 *
 * Field rules:
 *
 *   - **User query:** The analyzer's `corrected` field — i.e. spell-
 *     corrected and punctuation-collapsed, but WITH the greeting still
 *     attached. This is what the user effectively typed and what they
 *     will see echoed back in the endpoint's response, so the LLM
 *     reasons about that exact string. Crucially, this lets the LLM
 *     cross-check the `user_intent` flag: if `user_intent` includes
 *     GREETING, the LLM can verify by spotting the greeting in the
 *     query text — guarding against silent misfires of the
 *     greeting-peel heuristic.
 *
 *     We do NOT send the raw user input (typos preserved, original
 *     capitalization). The `corrected` form is what was matched
 *     against the corpus when generating these results, so the LLM
 *     should reason in that same form.
 *
 *   - **Frustration:** Omitted when score < 0.2 (neutral tone).
 *     Otherwise emits `Frustration: {score} ({level})`. The score
 *     is the raw 0..1 number from {@link detectFrustration};
 *     the level is one of {@link FRUSTRATION_BUCKETS} chosen by
 *     score. Letting the LLM see both lets it calibrate its
 *     response intensity (warm acknowledgment vs explicit empathy
 *     vs full de-escalation) without us hardcoding a single rule.
 *
 *   - **User intent:** Always present. Deduplicated set of segment
 *     classification labels (TECHNICAL, SUPPORT, CONVERSATIONAL),
 *     plus GREETING when {@link analysis.greeting} is true.
 *     GREETING is ordered first (it's the social opener), then
 *     the rest alphabetically. This lets the LLM see the full
 *     mixture of intents in one place without us flattening
 *     segment structure further.
 *
 *   - **Results:** Sections-only. Each row is one section hit. The
 *     header `[{N}]` announces the count; the column list
 *     `{score,documentId,range:[start,end],sectionText}` documents
 *     the per-row schema. Rows use `- ` as bullet markers (no
 *     explicit index — the LLM never references hits by position,
 *     since sources are emitted as `{documentId, range}` directly).
 *
 *     Scores are formatted to 3 decimal places. Ranges are
 *     bracketed `[start,end]` to disambiguate the inner comma
 *     from the field separator. sectionText is the trailing field
 *     and may contain commas, but its internal newlines are
 *     replaced with spaces before serialization to preserve the
 *     line-based parsing contract (one row per line).
 *
 * ## What the LLM produces in response
 *
 *     {
 *       "answer": [
 *         { "text": "...", "source": { "documentId": "...", "range": [start, end] } },
 *         { "text": "..." }   // unsourced chunks for transitions/framing
 *       ],
 *       "followUpQuestions": ["...", "...", "..."]
 *     }
 *
 * Sources reference results by their `{documentId, range}` pair —
 * the LLM copies them verbatim from result rows. No anchor text, no
 * indices.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Frustration score → human-readable level mapping. Walked in
 * descending order; the first row whose `min` threshold is met by
 * the analyzer's score wins. The `null` level at the bottom causes
 * the Frustration line to be omitted entirely — when the user is
 * calm, the LLM doesn't need a "Frustration: 0.05 (neutral)" line
 * cluttering its prompt.
 *
 * Thresholds are starting values. They can be tuned via smoke
 * tests as we accumulate real frustrated-user traffic. Specifically:
 *
 *   - 0.2 lower threshold: anything below this is treated as
 *     neutral. The analyzer's detector picks up mild signals (one
 *     instance of "!" or moderate caps); we don't want to label
 *     those as frustration.
 *   - 0.5: middle bucket. Clear frustration markers (multiple
 *     "!!!", repeated keywords, allCaps phrase).
 *   - 0.8: heavy frustration. Sustained shouting, profanity, or
 *     multiple stacked signals.
 *
 * @type {Array<{min: number, level: string|null}>}
 */
const FRUSTRATION_BUCKETS = Object.freeze([
  { min: 0.8, level: "very_frustrated" },
  { min: 0.5, level: "frustrated"      },
  { min: 0.2, level: "mildly_frustrated" },
  { min: 0.0, level: null              },  // sentinel — omits the line
]);

/**
 * Number of decimal places used when formatting scores. Three is
 * enough precision for the LLM to compare relative scores without
 * being misled by float-tail noise. Cosine scores typically sit
 * in [0.4, 1.0] so three decimals captures meaningful differences.
 *
 * @type {number}
 */
const SCORE_DECIMALS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine the frustration level for a score, or `null` if the
 * score is below all bucket minimums (= neutral, omit the line).
 *
 * Walks {@link FRUSTRATION_BUCKETS} top-down. The buckets are
 * ordered by decreasing threshold so the first match is the highest
 * applicable level. The sentinel `{min: 0, level: null}` at the
 * bottom is reached only when score < 0.2 — its `null` causes the
 * caller to omit the Frustration line.
 *
 * @param {number} score - Frustration score in [0, 1].
 * @returns {string|null}
 *
 * @example
 *   frustrationLevel(0.85) // → "very_frustrated"
 *   frustrationLevel(0.6)  // → "frustrated"
 *   frustrationLevel(0.3)  // → "mildly_frustrated"
 *   frustrationLevel(0.1)  // → null  (omit the line)
 */
const frustrationLevel = (score) => {
  for (const bucket of FRUSTRATION_BUCKETS) {
    if (score >= bucket.min) return bucket.level;
  }
  return null;
};

/**
 * Build the deduplicated user_intent array for an analyzer output.
 *
 * Combines two sources of intent:
 *   - `analysis.greeting === true` → adds "GREETING"
 *   - Each segment's classification label
 *
 * Ordering: GREETING first when present (it's the social opener;
 * the LLM should see it before anything else so it knows to open
 * warmly). Remaining labels are sorted alphabetically for stable
 * output — same query produces same string across runs.
 *
 * Deduplication: a multi-segment query where all segments are
 * TECHNICAL produces `["TECHNICAL"]` (not `["TECHNICAL", "TECHNICAL"]`).
 * The LLM doesn't need to know how many segments shared a label;
 * the set is what matters.
 *
 * @param {object} analysis - Analyzer output (see buildAnalyzeQuery).
 * @param {boolean} analysis.greeting
 * @param {Array<{classification: {label: string}}>} analysis.segments
 * @returns {string[]} Ordered, deduplicated intent labels.
 *
 * @example
 *   buildIntents({ greeting: true, segments: [
 *     { classification: { label: "TECHNICAL" } },
 *     { classification: { label: "SUPPORT" } },
 *   ]})
 *   // → ["GREETING", "SUPPORT", "TECHNICAL"]
 */
const buildIntents = (analysis) => {
  const set = new Set();
  if (analysis.greeting) set.add("GREETING");
  for (const segment of analysis.segments || []) {
    const label = segment?.classification?.label;
    if (typeof label === "string") set.add(label);
  }
  const intents = Array.from(set);
  const hasGreeting = intents.includes("GREETING");
  const rest = intents.filter((i) => i !== "GREETING").sort();
  return hasGreeting ? ["GREETING", ...rest] : rest;
};

/**
 * Serialize a single result row.
 *
 * Row format:
 *
 *     - {score},{documentId},[{start},{end}],{sectionText}
 *
 * Each row begins with "- " (bullet marker, no leading index since
 * the LLM addresses sources by {documentId, range} pair, never by
 * row position).
 *
 * The range is bracketed `[start,end]` to disambiguate its internal
 * comma from the field separator. This matches the schema header's
 * `range:[start,end]` declaration so input shape and output shape
 * align — the LLM emits sources as `range: [start, end]` matching
 * exactly what it sees here.
 *
 * sectionText is the trailing field and may contain commas (they're
 * part of the text, not field delimiters — the LLM parses the row
 * as "first 3 commas split off score, documentId, range; everything
 * after the third comma is sectionText"). Internal newlines are
 * replaced with spaces because rows are line-delimited; a newline
 * inside sectionText would break the line-based parsing contract.
 * Section text content is for synthesis, not faithful reproduction,
 * so collapsed whitespace is acceptable.
 *
 * @param {object} result
 * @param {number} result.score
 * @param {string} result.documentId
 * @param {[number, number]} result.range
 * @param {string} result.sectionText
 * @returns {string}
 */
const serializeRow = (result) => {
  const score      = result.score.toFixed(SCORE_DECIMALS);
  const documentId = result.documentId;
  const start      = result.range[0];
  const end        = result.range[1];
  // Replace any whitespace run (including newlines, tabs) with a
  // single space. Preserves text content but flattens to one line.
  const sectionText = String(result.sectionText || "").replace(/\s+/g, " ").trim();
  return `- ${score},${documentId},[${start},${end}],${sectionText}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize the analyzer output + retrieved results into the
 * compact text format consumed by the second-pass LLM prompt.
 *
 * This is the LLM's whole input. The prompt itself contains the
 * task description and output schema; this serialized context is
 * what the prompt's user-message field gets populated with.
 *
 * Format documentation is in this module's file header. The
 * serializer is intentionally minimal — no XML, no JSON, no escaping
 * — because the LLM has demonstrated strong handling of the
 * "schema-header + bullet rows" pattern, and avoiding wrapper
 * syntax keeps the token cost low.
 *
 * ## Inputs
 *
 * `analysis` is the result of `buildAnalyzeQuery()(query)`. We
 * pull `corrected` (spell-fixed, greeting still attached),
 * `greeting`, `frustration`, and `segments` from it. We do NOT
 * use `query` (cleaned, greeting peeled) for the LLM input — the
 * `corrected` form is what the user effectively said and what
 * they'll see echoed back in the response. Showing it to the LLM
 * also lets it cross-verify the `user_intent` GREETING flag against
 * the actual text.
 *
 * `results` is the unioned, sorted, deduplicated hit list — each
 * hit augmented with `sectionText` (the actual markdown text for
 * the section, resolved by the section text resolver upstream).
 * Hits should already be ordered by score descending; the
 * serializer does NOT sort them.
 *
 * ## Why this signature
 *
 * Both inputs are read-only — the serializer mutates nothing.
 * `analysis` and `results` are passed separately rather than as a
 * combined object because they have distinct lifecycles: `analysis`
 * is produced once per query; `results` is built from N searches
 * + section resolution. Keeping them separate makes the data flow
 * explicit and lets callers swap one without rebuilding the other.
 *
 * @function serializeQueryContext
 * @param {object} analysis
 *   Analyzer output from {@link buildAnalyzeQuery}. Required fields:
 *   `corrected` (spell-corrected string with greeting still attached),
 *   `greeting` (boolean), `frustration` (object with `score`),
 *   `segments` (array of {classification:{label}}).
 * @param {Array<{score: number, documentId: string, range: [number, number], sectionText: string}>} results
 *   Section hits, sorted by score descending. Each must include
 *   `sectionText` (resolved from the source markdown). Empty array
 *   is acceptable but unusual — empty-results cases should be
 *   routed to the conversational path before invoking this
 *   serializer.
 * @returns {string} Serialized context, ready to drop into the
 *   second-pass LLM prompt.
 *
 * @example
 *   serializeQueryContext({
 *     corrected: "what causes biofilm",
 *     greeting: false,
 *     frustration: { score: 0.0 },
 *     segments: [{ classification: { label: "TECHNICAL" } }],
 *   }, [
 *     { score: 0.612, documentId: "biocides|water_chemistry",
 *       range: [3331, 3631], sectionText: "Biofilm forms when..." },
 *   ]);
 *   // →
 *   // User query: what causes biofilm
 *   // User intent: TECHNICAL
 *   // Results:[1]{score,documentId,range:[start,end],sectionText}:
 *   // - 0.612,biocides|water_chemistry,[3331,3631],Biofilm forms when...
 */
const serializeQueryContext = (analysis, results) => {
  const lines = [];

  // The corrected form (spell-corrected, BUT greeting still attached).
  // This is what the user effectively typed — what they'll see echoed
  // back in the response — so the LLM should reason about that exact
  // string rather than the post-peel `query` form. Greetings remain
  // in the text and ALSO appear in user_intent as GREETING; the LLM
  // can independently confirm the analyzer's flag by reading the
  // text, which guards against silent misfires of the greeting peel.
  lines.push(`User query: ${analysis.corrected}`);

  // Frustration — only when the score crosses the lowest bucket
  // threshold. Below that, the user is calm and the LLM doesn't
  // need a tone hint.
  const score = analysis.frustration?.score ?? 0;
  const level = frustrationLevel(score);
  if (level !== null) {
    lines.push(`Frustration: ${score.toFixed(2)} (${level})`);
  }

  // User intent — always present. Greeting folded in as an intent
  // when peeled. See buildIntents for ordering rules.
  const intents = buildIntents(analysis);
  lines.push(`User intent: ${intents.join(", ")}`);

  // Results — flat list of section hits. The schema header
  // documents the column order so the LLM knows what to expect
  // before reading rows. range:[start,end] signals the array shape
  // — the LLM emits sources with `range: [start, end]` matching.
  const N = results.length;
  lines.push(`Results:[${N}]{score,documentId,range:[start,end],sectionText}:`);
  for (let i = 0; i !== N; ++i) {
    lines.push(serializeRow(results[i]));
  }

  return lines.join("\n");
};

// Attach helper exports for callers / tests that want bucket
// thresholds, the level function, or intent assembly without
// invoking the full serializer. Useful for tests and for any
// adjacent code that needs to mirror these conventions.
serializeQueryContext.FRUSTRATION_BUCKETS = FRUSTRATION_BUCKETS;
serializeQueryContext.frustrationLevel    = frustrationLevel;
serializeQueryContext.buildIntents        = buildIntents;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(serializeQueryContext, "serializeQueryContext", {
  value: serializeQueryContext,
}));
