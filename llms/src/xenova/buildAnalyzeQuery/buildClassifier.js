"use strict";

const VectorStore       = require("../../VectorStore");
const Document          = require("../../VectorStore/Document");
const embedQuery        = require("../embedQuery");
const classify          = require("../classify");
const detectFrustration = require("./detectFrustration");

/**
 * @file buildClassifier.js
 * @module xenova/buildAnalyzeQuery/buildClassifier
 * @description Factory that produces a Xenova-backed zero-shot classifier
 * for a single query segment.
 *
 * Two-tier architecture:
 *
 * Tier 1 — BGE anchor classifier (fast path).
 *   Each class is described by a list of exemplar phrasings ("anchors").
 *   Anchors are embedded once at build time via {@link embedQuery}, then
 *   each query is scored against them via cosine similarity. The class
 *   with the highest max-cosine wins. Microseconds per call.
 *
 * Tier 2 — NLI classifier (fallback).
 *   When the BGE result is unconfident (low absolute score OR thin
 *   margin), the same query is run through a zero-shot NLI model via
 *   {@link classify}, using each class's `description` as the entailment
 *   hypothesis. NLI generalizes across phrasings the anchor classifier
 *   may miss, at the cost of one model forward pass per label
 *   (~100-300ms total). Used as a tiebreaker — NLI's choice overrides
 *   BGE on low-confidence cases.
 *
 *   The fallback fires on BOTH conditions:
 *
 *     Weak signal — none of the anchors matched well, coverage gap in
 *     the anchor set. NLI's hypothesis test draws on broader language
 *     understanding to rescue. Critical for queries phrased outside
 *     the anchor patterns, e.g. user-observation TECHNICAL queries
 *     ("I see green slime in my cooling tower") where the default
 *     TECHNICAL anchors are question-shaped and don't match
 *     statement-shaped observations.
 *
 *     Thin margin — two strong cosine scores are nearly tied, the
 *     query genuinely straddles two adjacent classes. NLI's
 *     entailment reasoning weighs the semantics differently than
 *     cosine and frequently picks the right one when BGE can't
 *     decide.
 *
 * Two operating modes:
 *
 * Mode 1 — TECHNICAL anchors provided.
 *   Standard 3-class max-cosine across TECHNICAL / SUPPORT /
 *   CONVERSATIONAL. Mode 1 vs Mode 2 is determined at build time by
 *   whether the caller passes TECHNICAL anchors.
 *
 * Mode 2 — no TECHNICAL anchors (open-world default).
 *   TECHNICAL is inferred by absence: when neither SUPPORT nor
 *   CONVERSATIONAL clearly matches, the query is TECHNICAL.
 *
 * Anchor philosophy. Defaults are EXEMPLARS, not descriptions. Real
 * user queries look like other queries, not like academic definitions
 * of categories. Cosine similarity rewards surface-form similarity, so
 * anchoring on phrasings the user might actually type produces better
 * matches than anchoring on category descriptions ("a greeting like
 * hello" vs the actual word "hello"). Callers should follow the same
 * style for their TECHNICAL anchors.
 *
 * ## CONVERSATIONAL anchor augmentation
 *
 * The default CONVERSATIONAL anchors are augmented at module load
 * with two arrays imported from {@link detectFrustration}:
 *
 *   - `CONVERSATIONAL_EXEMPLARS` — pure-emotion subset of the urgent
 *     vocabulary ("wtf", "help me", "urgent", "emergency", "panic"...).
 *   - `PROFANITY_HEAVY` — bare heavy profanity tokens ("fuck", "shit",
 *     "wtf").
 *
 * Why: emotional fragments like "WTF?", "help me", "urgent" are
 * legitimately CONVERSATIONAL when typed alone — pure emotion or
 * pure help-seeking with no domain content to retrieve against.
 * Without these anchors, BGE's cosine for such queries is mediocre
 * and NLI has to rescue them, and NLI can be misled by surface
 * features (caps, question marks) into picking TECHNICAL.
 *
 * The split lives in detectFrustration.js — see the
 * `Vocabulary partitioning` section there. Content-bearing distress
 * words ("broken", "not working") and light profanity ("damn",
 * "hell", "crap") are deliberately NOT included as anchors because
 * they appear in legitimate SUPPORT/TECHNICAL queries.
 *
 * ## TECHNICAL preference rule
 *
 * After the BGE argmax, a margin rule fires: a non-TECHNICAL class
 * may win only if it beats TECHNICAL's score by at least
 * `technicalPreferenceMargin` (default 0.10). Otherwise the label
 * flips to TECHNICAL.
 *
 * Why: the error landscape is asymmetric. A false TECHNICAL is cheap
 * — one wasted retrieval, the LLM filters via source attribution. A
 * false non-TECHNICAL is expensive — a real technical question is
 * silently skipped (CONVERSATIONAL) or routed to biased retrieval
 * (SUPPORT). Defaulting to TECHNICAL when the contest is close means
 * being wrong in the cheaper direction.
 *
 * The flip drives `bgeMargin` negative (TECHNICAL "wins" with a lower
 * score than the runner-up), which then triggers the existing
 * `isLowConfidence` path and gives NLI a chance to confirm. So the
 * rule plays nicely with the existing fallback: margin-rule flips are
 * NLI-confirmed, not blind overrides.
 *
 * This handles "TECH 0.65 vs SUPPORT 0.71" cases. It does NOT handle
 * cases where TECHNICAL is far below (e.g. TECH 0.04 vs SUPPORT 0.46
 * for the green-slime observation) — that gap is too large to bridge
 * with a small margin. Such cases rely on NLI's thin-margin trigger
 * to rescue.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Default class configurations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default SUPPORT class: requests for human help, contact info, or
 * escalation. Anchors are exemplar phrasings the user might actually
 * type. Description is the NLI hypothesis text.
 *
 * @type {{ anchors: string[], description: string }}
 */
const DEFAULT_SUPPORT = Object.freeze({
  anchors: Object.freeze([
    "I need to talk to a person",
    "can I speak with a human",
    "I need urgent help",
    "please escalate this",
    "is there someone I can contact",
    "I need a real person",
    "can you connect me with support",
    "what's your phone number",
    "how do I contact you",
    "I need an expert to look at this",
    "please call me back",
    "can someone call me",
    "I need immediate assistance",
    "transfer me to a representative",
    "I want to talk to your team",
    "where are you located",
    "where is the meeting",
    "what time is the call"
  ]),
  description: "a request for human help or contact information",
});

/**
 * Core CONVERSATIONAL anchors — greetings, thanks, off-topic, personal
 * questions to the assistant. The full default anchor set
 * (DEFAULT_CONVERSATIONAL.anchors) concatenates this with frustration-
 * derived vocabulary; see this file's module docstring.
 */
const CORE_CONVERSATIONAL_ANCHORS = Object.freeze([
  // Greetings
  "hello",
  "hi",
  "hey",
  "hi there",
  "hello there",
  "good morning",
  "good afternoon",
  "good evening",
  "howdy",
  "yo",
  // Thanks / appreciation
  "thanks",
  "thank you",
  "thanks for your help",
  "thank you so much",
  "appreciate it",
  "much appreciated",
  // Off-topic / chitchat
  "how are you",
  "what's up",
  "tell me a joke",
  "what's the weather like",
  "who won the game",
  // Personal / assistant questions
  "what's your name",
  "who built you",
  "what can you do",
  "are you an AI",
]);

/**
 * Default CONVERSATIONAL class. Anchors are concatenated from three
 * sources, all single-source-of-truth — no duplication:
 *
 *   1. Core anchors (greetings/thanks/chitchat) defined above
 *   2. detectFrustration.CONVERSATIONAL_EXEMPLARS (pure-emotion subset
 *      of the urgent vocabulary)
 *   3. detectFrustration.PROFANITY_HEAVY (bare heavy profanity tokens)
 *
 * The three arrays are disjoint, so direct concat is safe. If overlaps
 * appear in the future, wrap in `[...new Set(...)]`.
 *
 * @type {{ anchors: string[], description: string }}
 */
const DEFAULT_CONVERSATIONAL = Object.freeze({
  anchors: Object.freeze([
    ...CORE_CONVERSATIONAL_ANCHORS,
    ...detectFrustration.CONVERSATIONAL_EXEMPLARS,
    ...detectFrustration.PROFANITY_HEAVY,
  ]),
  description: "a greeting, thank you, or off-topic message",
});

/**
 * NLI description for TECHNICAL. Anchors are not provided by default —
 * TECHNICAL is domain-specific, so callers supply their own. The
 * description is generic enough to work as an NLI fallback when no
 * domain-specific description is given.
 *
 * @type {string}
 */
const DEFAULT_TECHNICAL_DESCRIPTION = "a technical or factual question";

// ─────────────────────────────────────────────────────────────────────────────
// Default thresholds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default tuning thresholds. Calibrated for BGE-small-en-v1.5 cosine
 * geometry. Override per-instance via the `thresholds` option.
 *
 * @type {{
 *   technical: number,
 *   lowConfidence: number,
 *   absoluteLow: number,
 *   technicalPreferenceMargin: number
 * }}
 */
const DEFAULT_THRESHOLDS = Object.freeze({
  // Mode 2: a query is TECHNICAL when max(SUPPORT, CONVERSATIONAL) is
  // below this value. Above this value, the higher of the two wins.
  technical: 0.5,

  // Mode 1 + Mode 2: margin (winning - runner-up) below this triggers
  // the NLI fallback. A small margin means the top two classes are
  // nearly tied — NLI's entailment reasoning is more reliable on close
  // calls than raw cosine.
  lowConfidence: 0.1,

  // Mode 1: winning absolute score below this also triggers NLI. Even
  // if the margin is wide, a winning score of 0.3 means nothing matched
  // well — NLI is more robust to coverage gaps in the anchor set.
  absoluteLow: 0.4,

  // TECHNICAL preference rule: a non-TECHNICAL class must beat
  // TECHNICAL's score by AT LEAST this margin to win. If a non-
  // TECHNICAL class has the highest cosine but the gap to TECHNICAL is
  // smaller than this, the label flips to TECHNICAL.
  //
  // Encodes the asymmetric error cost: false TECHNICAL is cheap (one
  // wasted retrieval), false non-TECHNICAL is expensive (silent skip
  // or biased retrieval). When the contest is close, prefer the
  // cheaper failure mode.
  //
  // Tuned conservatively at 0.10 — large enough to catch genuine ties
  // (TECH 0.65 vs SUPPORT 0.71 → flip to TECH), small enough to avoid
  // over-flipping (TECH 0.20 vs CONV 0.85 → CONV stays).
  technicalPreferenceMargin: 0.10,
});

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a query classifier with pre-cached anchor embeddings.
 *
 * @async
 * @function buildClassifier
 *
 * @param {object} [options]
 * @param {object} [options.classes]
 *   Per-class configuration. Each entry is `{ anchors, description }`:
 *   - `anchors` is an array of exemplar phrasings for that class.
 *   - `description` is a short NLI hypothesis text used when the BGE
 *     classifier is unconfident and the NLI fallback fires.
 *
 *   Recognized keys: `TECHNICAL`, `SUPPORT`, `CONVERSATIONAL`. Any class
 *   may be omitted:
 *   - `SUPPORT` and `CONVERSATIONAL` default to the universal sets
 *     exported by this module.
 *   - `TECHNICAL` omission switches the classifier to Mode 2 (open-
 *     world): TECHNICAL is inferred by absence rather than by anchor
 *     match.
 *
 *   For Mode 1 callers, supplying `classes.TECHNICAL.anchors` (with
 *   domain-specific exemplars) is enough; defaults handle the rest.
 *
 * @param {object} [options.thresholds]
 *   Override defaults for `technical`, `lowConfidence`, `absoluteLow`,
 *   `technicalPreferenceMargin`. See {@link DEFAULT_THRESHOLDS} for
 *   semantics.
 *
 * @returns {Promise<(input: Float32Array|string, originalText?: string) => Promise<{
 *   label:         "TECHNICAL"|"SUPPORT"|"CONVERSATIONAL",
 *   confidence:    number,
 *   scores:        { TECHNICAL: number, SUPPORT: number, CONVERSATIONAL: number },
 *   lowConfidence: boolean,
 *   usedNli:       boolean
 * }>>}
 *   Async classifier closure. Inputs:
 *   - `input` — either a `Float32Array` (already-embedded query, common
 *     dispatcher path) or a `string` (will be embedded). Both work.
 *   - `originalText` — when `input` is a vector, the original text the
 *     vector was computed from. Required for the NLI fallback path,
 *     since NLI reasons over text, not vectors. If omitted while a
 *     vector is passed, NLI cannot run and the classifier returns the
 *     BGE result regardless of confidence.
 *
 *   Output fields:
 *   - `label` — the winning class.
 *   - `confidence` — margin between the winning score and the runner-up.
 *     May be negative when the TECHNICAL preference rule flipped the
 *     label (TECHNICAL won despite lower raw score).
 *   - `scores` — raw max-cosine per class (TECHNICAL in Mode 2 is the
 *     synthetic threshold-minus-otherMax score; see Mode 2 docs).
 *   - `lowConfidence` — true when the result is below the absolute-low
 *     floor OR below the lowConfidence margin. Signals to callers that
 *     the routing decision is uncertain regardless of which path
 *     produced it.
 *   - `usedNli` — true if the NLI fallback ran. Useful for logging /
 *     metrics on how often the cheap path fails.
 */
const buildClassifier = async ({ classes = {}, thresholds = {} } = {}) => {
  // Merge per-class config with defaults. TECHNICAL has no default
  // anchors — its presence determines mode.
  const technical = {
    anchors:     classes.TECHNICAL?.anchors,
    description: classes.TECHNICAL?.description || DEFAULT_TECHNICAL_DESCRIPTION,
  };
  const support = {
    anchors:     classes.SUPPORT?.anchors     || DEFAULT_SUPPORT.anchors,
    description: classes.SUPPORT?.description || DEFAULT_SUPPORT.description,
  };
  const conversational = {
    anchors:     classes.CONVERSATIONAL?.anchors     || DEFAULT_CONVERSATIONAL.anchors,
    description: classes.CONVERSATIONAL?.description || DEFAULT_CONVERSATIONAL.description,
  };

  const T = { ...DEFAULT_THRESHOLDS, ...thresholds };

  // Mode detection: are TECHNICAL anchors provided?
  const hasTechnical = Array.isArray(technical.anchors) && technical.anchors.length > 0;

  // ── Build Documents for the classes that have anchors ─────────────────
  // Each Document holds one class's anchor vectors in a single section.
  // Document.score will return the max cosine across the section, which
  // is exactly the "best anchor match" we want.
  const docPromises = [
    Document.fromTexts({ documentId: "SUPPORT",        texts: support.anchors,        encode: embedQuery }),
    Document.fromTexts({ documentId: "CONVERSATIONAL", texts: conversational.anchors, encode: embedQuery }),
  ];
  if (hasTechnical) {
    docPromises.unshift(
      Document.fromTexts({ documentId: "TECHNICAL", texts: technical.anchors, encode: embedQuery })
    );
  }
  const docs = await Promise.all(docPromises);

  const store = new VectorStore();
  store.push(...docs);

  // Touch vecDim once to trigger the consistency check at boot time
  // (mixed-dim documents would throw here, immediately, instead of at
  // first classification call).
  const dim = store.vecDim;

  // ── NLI label list, in stable order ───────────────────────────────────
  // The list and the matching label-from-description map are fixed at
  // build time so the per-call NLI path doesn't allocate fresh arrays.
  const nliLabels = [technical.description, support.description, conversational.description];
  const nliLabelToClass = {
    [technical.description]:      "TECHNICAL",
    [support.description]:        "SUPPORT",
    [conversational.description]: "CONVERSATIONAL",
  };

  // ─────────────────────────────────────────────────────────────────────
  // Classifier closure
  // ─────────────────────────────────────────────────────────────────────

  const classifyQuery = async (input, originalText) => {
    // Resolve input → (queryVec, text).
    let queryVec, text;
    if (input instanceof Float32Array) {
      queryVec = input;
      text = originalText; // may be undefined; NLI fallback won't fire if so
    } else if (typeof input === "string") {
      text = input;
      queryVec = await embedQuery(input);
    } else {
      throw new Error("classifier: input must be Float32Array or string");
    }

    if (queryVec.length !== dim) {
      throw new Error(
        `classifier: query dim ${queryVec.length} does not match ` +
        `anchor dim ${dim} (encoder mismatch)`
      );
    }

    // ── Tier 1: BGE anchor classifier ──────────────────────────────────
    const hits = store.score(queryVec, -Infinity);

    // Materialize scores object. Init TECHNICAL even if absent — we'll
    // fill it in Mode 2 below.
    const scores = { TECHNICAL: 0, SUPPORT: 0, CONVERSATIONAL: 0 };
    for (const h of hits) scores[h.documentId] = h.score;

    if (!hasTechnical) {
      // Mode 2: TECHNICAL by absence. The "TECHNICAL score" is a
      // synthetic margin-below-threshold — positive when TECHNICAL wins
      // (others are weak), zero at the boundary, negative when one of
      // the others is the answer.
      const otherMax = Math.max(scores.SUPPORT, scores.CONVERSATIONAL);
      scores.TECHNICAL = T.technical - otherMax;
    }

    // Pick winner and compute margin. Sorted descending — top[0] is the
    // label, top[1] is the runner-up.
    const sortedEntries = Object.entries(scores).sort(([, a], [, b]) => b - a);
    let bgeLabel        = sortedEntries[0][0];
    let bgeWinning      = sortedEntries[0][1];
    let bgeRunnerUp     = sortedEntries[1][1];
    let bgeMargin       = bgeWinning - bgeRunnerUp;

    // ── TECHNICAL preference rule ──────────────────────────────────────
    // A non-TECHNICAL class may only win if it beats TECHNICAL's score
    // by at least the preference margin. Otherwise, flip to TECHNICAL.
    //
    // The flip leaves `scores` untouched (callers can still see the raw
    // ranking) but updates the label, winning value, runner-up, and
    // margin to reflect the corrected winner. The new bgeMargin will
    // be non-positive (TECHNICAL's score is below the prior winner's),
    // which automatically triggers the `isLowConfidence` path below
    // and lets NLI confirm the flip rather than blindly accepting it.
    if (bgeLabel !== "TECHNICAL") {
      const nonTechWinning = scores[bgeLabel];
      const techScore      = scores.TECHNICAL;
      if (nonTechWinning - techScore < T.technicalPreferenceMargin) {
        bgeLabel    = "TECHNICAL";
        bgeWinning  = techScore;
        bgeRunnerUp = nonTechWinning;
        bgeMargin   = techScore - nonTechWinning; // negative or zero
      }
    }

    // Low confidence: either thin margin OR weak absolute winner. The
    // absolute-low check applies primarily to Mode 1 (where TECHNICAL
    // score is a real cosine); in Mode 2 the TECHNICAL synthetic score
    // can be negative, so we use the original raw cosines for the
    // absolute check.
    const maxRawCosine = Math.max(scores.SUPPORT, scores.CONVERSATIONAL,
                                  hasTechnical ? scores.TECHNICAL : -Infinity);
    const isLowConfidence = bgeMargin < T.lowConfidence || maxRawCosine < T.absoluteLow;

    // ── Tier 2: NLI fallback ──────────────────────────────────────────
    // Fires when (a) low confidence and (b) we have the original
    // text. If the dispatcher passed a vector without `originalText`,
    // there's nothing to feed NLI; return the BGE result unchanged.
    if (isLowConfidence && text) {
      const nliResult = await classify(text, nliLabels);
      // classify returns labels/scores sorted descending; nliResult.labels[0]
      // is the winner.
      const nliLabel = nliLabelToClass[nliResult.labels[0]];
      const nliMargin = nliResult.scores[0] - nliResult.scores[1];

      return {
        label:         nliLabel,
        confidence:    nliMargin,
        scores,                       // BGE scores retained for debugging
        lowConfidence: false,         // NLI ran; we trust its choice
        usedNli:       true,
      };
    }

    return {
      label:         bgeLabel,
      confidence:    bgeMargin,
      scores,
      lowConfidence: isLowConfidence,
      usedNli:       false,
    };
  };

  return classifyQuery;
};

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @ignore
 * Frozen self-referential export with the default class configs and
 * thresholds attached for callers that want to extend rather than
 * replace them:
 *
 *   const { buildClassifier } = require("./buildClassifier");
 *   const classify = await buildClassifier({
 *     classes: {
 *       TECHNICAL: { anchors: [...], description: "..." },
 *       CONVERSATIONAL: {
 *         anchors: [...buildClassifier.DEFAULT_CONVERSATIONAL.anchors, "extra"],
 *         description: buildClassifier.DEFAULT_CONVERSATIONAL.description,
 *       },
 *     },
 *   });
 */
buildClassifier.DEFAULT_SUPPORT                = DEFAULT_SUPPORT;
buildClassifier.DEFAULT_CONVERSATIONAL         = DEFAULT_CONVERSATIONAL;
buildClassifier.CORE_CONVERSATIONAL_ANCHORS    = CORE_CONVERSATIONAL_ANCHORS;
buildClassifier.DEFAULT_TECHNICAL_DESCRIPTION  = DEFAULT_TECHNICAL_DESCRIPTION;
buildClassifier.DEFAULT_THRESHOLDS             = DEFAULT_THRESHOLDS;

module.exports = Object.freeze(Object.defineProperty(buildClassifier, "buildClassifier", {
  value: buildClassifier,
}));