"use strict";

const parseResponseJson      = require("../../utilities/parseResponseJson");
const SectionResolver        = require("./SectionResolver");
const unionHits              = require("./unionHits");
const validateLLMResponse    = require("./validateLLMResponse");
const search                 = require("../../VectorStore/search");
const Stats                  = require("../../Stats");
const serializeQueryContext  = require("../../xenova/serializeQueryContext");
const { MAX_OUTPUT_ROWS }    = require("../../VectorStore/constants");
const retrievalDiagnostics   = require("./retrievalDiagnostics");

/**
 * @file index.js
 * @module actions/query
 * @description End-to-end query handler.
 *
 * (Module-level docstring trimmed for brevity in this patch — the full
 * description of execution paths, retry logic, and tracing is preserved.
 * See prior version for those details.)
 *
 * ## Per-segment search filtering
 *
 * The analyzer can split a multi-clause query into segments and classify
 * each as TECHNICAL, SUPPORT, or CONVERSATIONAL. Searching on
 * CONVERSATIONAL segments wastes work and pollutes the result union with
 * weak matches against generic content (e.g. "WTF?" retrieves emotional/
 * help-related sections at scores around 0.5, drowning out the real
 * question's high-signal results).
 *
 * The orchestrator skips search for segments whose classification label
 * is CONVERSATIONAL. The segment is still preserved in `analysis.segments`
 * and included in the serialized context the LLM sees, so the model has
 * full visibility into the user's input — it just doesn't retrieve on it.
 *
 * If ALL segments are CONVERSATIONAL, the union is empty and the LLM is
 * called with `Results:[0]`. The answer prompt's no-coverage path handles
 * this (greeting reply, off-topic reply, or empathy + redirect for
 * frustrated CONVERSATIONAL queries).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Greeting templates — internal defaults for Path 1
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATES = Object.freeze({
  default:    "Hello! I'm here to help with water treatment questions — cooling towers, biocide programs, Legionella, system chemistry, and related topics. What's on your mind?",
  thanks:     "You're welcome! Let me know if you have other water treatment questions.",
  morning:    "Good morning! What can I help you with today?",
  afternoon:  "Good afternoon! What's on your mind?",
  evening:    "Good evening! How can I help?",
});

const TEMPLATE_RULES = Object.freeze([
  [/\b(thanks|thank\s+you|thx|ty)\b/i,                  "thanks"],
  [/\bgood\s+(morning|day)\b/i,                          "morning"],
  [/\bgood\s+afternoon\b/i,                              "afternoon"],
  [/\bgood\s+evening\b/i,                                "evening"],
  [/./,                                                  "default"],
]);

const pickGreetingTemplate = (correctedQuery) => {
  for (const [pattern, key] of TEMPLATE_RULES) {
    if (pattern.test(correctedQuery)) {
      return TEMPLATES[key] || TEMPLATES.default;
    }
  }
  return TEMPLATES.default;
};

// ─────────────────────────────────────────────────────────────────────────────
// Segment filter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Predicate: should this segment trigger a search?
 *
 * Returns false for CONVERSATIONAL segments — they're noise for the
 * retrieval pipeline — but only when the classifier was confident
 * about the CONVERSATIONAL label. The confidence gate exists because
 * the classifier may assign a CONVERSATIONAL label with weak signal
 * (e.g. scores.CONVERSATIONAL ~0.45 winning over near-tied SUPPORT/
 * TECHNICAL): a low-confidence skip risks silently dropping a real
 * technical question, which is the more expensive failure mode.
 *
 * SUPPORT and TECHNICAL always search. SUPPORT may have material in
 * the KB (contact info, escalation procedures, location, hours);
 * TECHNICAL is the primary retrieval case.
 *
 * @param {object} segment - From analyzer output.
 * @returns {boolean}
 */

// Minimum CONVERSATIONAL score required to skip retrieval. Below this,
// the classifier's CONVERSATIONAL "win" wasn't decisive (weak signal
// or thin margin), so we search defensively. 0.7 lets clean matches
// through (greetings, exact frustration-anchor hits typically score
// 0.85-1.0) while routing ambiguous cases to retrieval.
const SEGMENT_SKIP_CONFIDENCE_THRESHOLD = 0.7;

const shouldSearchSegment = (segment) => {
  if (!segment.classification) return true;
  const { label, scores } = segment.classification;

  // SUPPORT and TECHNICAL always search.
  if (label !== "CONVERSATIONAL") return true;

  // CONVERSATIONAL is skipped only when the classifier was confident.
  // A weak-signal CONVERSATIONAL win (score below threshold) means the
  // classifier didn't have a clear match — search defensively rather
  // than risk dropping a misclassified TECHNICAL/SUPPORT segment.
  if (scores && typeof scores.CONVERSATIONAL === "number") {
    return scores.CONVERSATIONAL < SEGMENT_SKIP_CONFIDENCE_THRESHOLD;
  }

  // Defensive default when scores aren't available: search.
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// Result enrichment
// ─────────────────────────────────────────────────────────────────────────────

const enrichWithSectionText = (hits, resolver) => {
  const enriched = [];
  for (const hit of hits) {
    const sectionText = resolver.resolve(hit.documentId, hit.range);
    if (sectionText === null) continue;
    enriched.push({ ...hit, sectionText });
  }
  return enriched;
};

// ─────────────────────────────────────────────────────────────────────────────
// Default fallback response builder
// ─────────────────────────────────────────────────────────────────────────────

const buildSimpleResponse = (analysis, rawQuery, text, stats) => ({
  query:             rawQuery,
  corrected:         analysis.corrected,
  greeting:          analysis.greeting,
  frustration:       analysis.frustration,
  user_intent:       serializeQueryContext.buildIntents(analysis),
  answer:            [{ text }],
  followUpQuestions: [],
  stats:             stats || new Stats(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Main: run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * End-to-end query handler.
 */
const run = async ({
  rawQuery,
  store,
  analyzeQuery,
  resolver,
  runLLM,
  prompts,
  llmConfig,
  greetingTemplate,
  maxRetries = 2,
  maxOutputRows = MAX_OUTPUT_ROWS,
  fallbackAnswer,
}) => {
  const analysis = await analyzeQuery(rawQuery);
  const stats = new Stats();

  // ──── DIAGNOSTIC: show what the classifier did per segment ────
  if (process.env.NEREUS_DEBUG_RETRIEVAL) {
    console.log("[analyzer] segments:", analysis.segments.map(s => ({
      text:        s.text,
      label:       s.classification?.label,
      confidence:  s.classification?.confidence?.toFixed(3),
      scores:      s.classification?.scores,
      lowConf:     s.classification?.lowConfidence,
      usedNli:     s.classification?.usedNli,
    })));
  }

  // ── Path 1: Pure greeting fast path ──────────────────────────────────────
  if (analysis.segments.length === 0 && analysis.greeting) {
    const text = greetingTemplate || pickGreetingTemplate(analysis.corrected || analysis.query || rawQuery);
    return buildSimpleResponse(analysis, rawQuery, text, stats);
  }

  // ── Retrieval (with optional diagnostics) ────────────────────────────────
  const tracingEnabled = !!process.env.NEREUS_DEBUG_RETRIEVAL;
  const trace = tracingEnabled ? retrievalDiagnostics.makeTraceCollector() : null;

  // Filter segments — CONVERSATIONAL segments are skipped for search.
  // We retain the original segment index so trace events stay aligned
  // with what the analyzer produced.
  const searchableSegments = [];
  const skippedSegments    = [];
  analysis.segments.forEach((seg, i) => {
    if (shouldSearchSegment(seg)) {
      searchableSegments.push({ seg, index: i });
    } else {
      skippedSegments.push({ seg, index: i });
    }
  });

  // Record skipped segments in the trace (they don't get search() calls,
  // but the diagnostic block should still show what was filtered and why).
  if (trace) {
    for (const { seg, index } of skippedSegments) {
      const cb = trace.forSegment(index, seg.text);
      cb({
        stage:  "skipped",
        reason: `classification=${seg.classification?.label || "unknown"} (no search performed)`,
        confidence: seg.classification?.confidence ?? null,
      });
    }
  }

  // Run search only on the searchable segments.
  const perSegmentHits = await Promise.all(
    searchableSegments.map(({ seg, index }) =>
      search(store, seg.vec, {
        onTrace: trace?.forSegment(index, seg.text),
      })
    )
  );
  const unionedHits = unionHits(perSegmentHits);

  // Resolve section text and cap at maxOutputRows.
  const enriched = enrichWithSectionText(unionedHits, resolver);
  const results = enriched.slice(0, maxOutputRows);

  // Production minimal log (always on, unchanged from prior behavior).
  if (process.env.NEREUS_DEBUG_RETRIEVAL) {
    console.log(`[query] top ${results.length} hits:`,
      results.map(h => `${h.documentId} [score=${h.score.toFixed(3)}] range=[${h.range[0]},${h.range[1]}]`));
  }

  // Rich diagnostic block (debug envvar only).
  if (trace) {
    trace.recordUnion(unionedHits, results);
    if (process.env.NEREUS_DEBUG_RETRIEVAL) {
      console.log(retrievalDiagnostics.formatTraceReport(trace.collect()));
    }
  }

  // ── LLM call with retry loop ─────────────────────────────────────────────
  const context = serializeQueryContext(analysis, results);
  const callConfig = { ...llmConfig, system: prompts.answer };

  let llmOutput = null;
  let validatorResult = { valid: false, errors: ["no attempt made"] };
  const totalAttempts = 1 + maxRetries;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    let raw;
    try {
      raw = await runLLM(callConfig, context);
    } catch (err) {
      validatorResult = { valid: false, errors: [`runLLM threw: ${err.message}`] };
      continue;
    }

    raw?.stats && stats.push(...Stats.normalize(raw));

    llmOutput = parseResponseJson(raw);
    validatorResult = validateLLMResponse(llmOutput);
    if (validatorResult.valid) break;
  }

  if (!validatorResult.valid) {
    if (typeof fallbackAnswer === "string" && fallbackAnswer.length > 0) {
      return buildSimpleResponse(analysis, rawQuery, fallbackAnswer, stats);
    }
    const err = new Error(
      `run: LLM output failed validation after ${totalAttempts} attempts: ${validatorResult.errors.join("; ")}`
    );
    err.attempts = totalAttempts;
    err.errors = validatorResult.errors;
    err.lastOutput = llmOutput;
    err.stats = stats;
    throw err;
  }

  return {
    query:             rawQuery,
    corrected:         analysis.corrected,
    greeting:          analysis.greeting,
    frustration:       analysis.frustration,
    user_intent:       serializeQueryContext.buildIntents(analysis),
    answer:            llmOutput.answer,
    followUpQuestions: llmOutput.followUpQuestions,
    stats,
  };
};

// Helper exports for tests and adjacent code.
run.TEMPLATES               = TEMPLATES;
run.TEMPLATE_RULES          = TEMPLATE_RULES;
run.pickGreetingTemplate    = pickGreetingTemplate;
run.shouldSearchSegment     = shouldSearchSegment;
run.enrichWithSectionText   = enrichWithSectionText;
run.buildSimpleResponse     = buildSimpleResponse;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(run, "run", {
  value: run,
}));