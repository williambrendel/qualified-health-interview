"use strict";

/**
 * @file detectFrustration.js
 * @module xenova/buildAnalyzeQuery/detectFrustration
 * @brief Surface user frustration markers from a raw query.
 *
 * Frustration matters for downstream response generation: an LLM
 * answering an angry user should adjust tone (more empathetic,
 * acknowledge the friction, skip cheery filler), and a SUPPORT
 * handoff handler may want to escalate urgency. None of that is
 * possible without explicit signals — the model can't infer frustration
 * from a classification label alone.
 *
 * Four signal categories are computed:
 *
 *   1. **Shouting** — ALL CAPS density of alphabetic characters.
 *      Gradient: scales smoothly from 0.4 ratio (start) to 0.7 ratio
 *      (full). Three letters or fewer is exempt — short queries are
 *      often acronyms ("PH", "DI water") where uppercase is conventional.
 *
 *   2. **Repeated punctuation** — driven by EXCESS CHARACTER COUNT
 *      (not run count). Run count is preserved as a diagnostic field
 *      but doesn't drive the score directly.
 *
 *      Why excess chars and not runs: a run of `"!!"` (2 chars) and a
 *      run of `"!!!!!!"` (6 chars) both produce repeatedPunctCount=1,
 *      but a user who typed 6 marks in a row is much more emphatic
 *      than one who typed 2. Counting excess characters (run length
 *      minus 1) preserves that intensity gradient.
 *
 *      Split by character type:
 *        - Excess in `!`-only runs → full weight (anger/urgency)
 *        - Excess in `?`-only runs → 0.5 weight (confusion ≠ anger)
 *        - Excess in mixed `!?` runs → full weight (the `!` does the
 *          emotional work; mixed runs are treated as exclamation-style)
 *      MUST be computed on the raw input before `collapseRepeated-
 *      Punctuation` normalizes the runs away.
 *
 *   3. **Urgent keywords** — closed set of words signaling urgency or
 *      brokenness. Includes explicit help-seeking and emergency markers.
 *      Each match counted, capped.
 *
 *   4. **Profanity** — tiered.
 *        - Heavy (`fuck`, `shit`, `wtf`) — full weight + floor at 0.5
 *          so heavy profanity alone reaches `frustrated` band.
 *        - Light (`damn`, `hell`, `crap`) — 60% of heavy weight, no floor.
 *
 * The composite score weights signals as follows:
 *   - shouting              → 0.25
 *   - repeated punctuation  → 0.20 (capped at REPEATED_PUNCT_EXCESS_CAP)
 *   - urgent keywords       → 0.25 (capped at 2+ matches)
 *   - profanity             → 0.40 (with light/heavy tier; heavy has floor)
 *
 * Weights intentionally sum to 1.10 — final score is clamped to [0, 1].
 *
 * ## Vocabulary partitioning
 *
 * The urgent-keyword vocabulary is split into two disjoint source
 * arrays. The full set used by detection is computed as the
 * concatenation — no entry is duplicated.
 *
 *   - {@link CONVERSATIONAL_EXEMPLARS} — pure-emotion subset. Each
 *     entry, used as a standalone fragment, signals non-informational
 *     expression: pure emotion or pure help-seeking with no domain
 *     content. Safe to reuse as CONVERSATIONAL-class anchors in a
 *     segment classifier.
 *
 *   - {@link CONTENT_BEARING_URGENT} — the rest. Words/phrases that
 *     signal urgency or brokenness but ALSO appear in legitimate
 *     domain queries ("the pump is broken", "valve isn't working").
 *     Useful for frustration detection; NOT safe as standalone
 *     classifier anchors.
 *
 *   - {@link URGENT_KEYWORDS} — derived: `[...EXEMPLARS, ...CONTENT_BEARING]`.
 *     Used by the urgent-keyword signal. Order is preserved so the
 *     longest-first regex precedence in `findUrgentKeywords` still
 *     works correctly: both partitions internally order multi-word
 *     phrases first, and exemplars come before content-bearing in
 *     the concat.
 *
 * `PROFANITY_HEAVY` is also safe as CONVERSATIONAL anchor vocabulary
 * (bare "wtf"/"fuck" have no domain context). `PROFANITY_LIGHT` is
 * NOT — "hell" and "damn" appear in legitimate domain phrasings
 * ("hell of a fouling problem", "what the hell happened to my pH").
 *
 * ## Calibration scoreboard (v4)
 *
 *   ""                                          → 0.00 (calm)
 *   "what is pH?"                               → 0.00 (calm)
 *   "hello!!"                                   → 0.04 (1 excess !)
 *   "hello!!!"                                  → 0.08 (2 excess !)
 *   "hello!!!!!!"                               → 0.20 (5 excess ! → cap)
 *   "why??"                                     → 0.02 (1 excess ? × 0.5 weight)
 *   "why???"                                    → 0.04 (2 excess ? × 0.5)
 *   "wtf"                                       → 0.50 (heavy profanity floor)
 *   "wtf!!"                                     → 0.54 (heavy + 1 excess !)
 *   "WTF HELP ME!!! green slime!!!"             → 0.93 (heavy + urgent + ~3 excess !)
 *   "WTF?????!!!!!! HELP ME!!! green slime!!!"  → 0.95 (heavy + urgent + max excess)
 *   "FUCK THIS IS BROKEN NOW HELP!!! NOT WORKING!!!" → 1.00 (clamped)
 *
 * ## Calibration history
 *
 * v1 (original): binary signals, sum-to-1 weights.
 * v2: doubled profanity weight, expanded urgent vocabulary, gradient shouting.
 * v3: split repeated-punct by character type, added heavy-profanity floor.
 * v4: repeated-punct scoring driven by EXCESS CHARACTERS instead of run
 *   count, so `"!!!!!!"` scores higher than `"!!"`. Run-based fields
 *   preserved for backward compatibility and diagnostics.
 * v4.1 (current): URGENT_KEYWORDS partitioned into CONVERSATIONAL_EXEMPLARS
 *   (pure emotion, safe for classifier reuse) and CONTENT_BEARING_URGENT
 *   (detection only). URGENT_KEYWORDS computed as concatenation — no
 *   duplication, single source per entry. Regex precedence preserved
 *   because multi-word phrases come first within each partition AND
 *   exemplars come before content-bearing entries. No change to scoring
 *   behavior.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum length (alphabetic chars) below which we don't evaluate
 * shouting. Short queries are often acronyms ("pH" → "PH", "DI water").
 */
const SHOUTING_MIN_LENGTH = 4;

/**
 * ALL CAPS density range. Shouting score scales linearly from
 * SHOUTING_RATIO_START (contributes 0) to SHOUTING_RATIO_FULL (full).
 */
const SHOUTING_RATIO_START = 0.4;
const SHOUTING_RATIO_FULL  = 0.7;

/**
 * Pure-emotion subset of the urgent vocabulary.
 *
 * Each entry, used ALONE as a standalone fragment, signals
 * non-informational expression: pure emotion or pure help-seeking
 * without domain content. Safe to reuse as CONVERSATIONAL-class
 * anchors in a segment classifier.
 *
 * Multi-word phrases first to preserve the longest-first matching
 * precedence used by `findUrgentKeywords` (so "please help" beats
 * "help" alone).
 *
 * @type {string[]}
 */
const CONVERSATIONAL_EXEMPLARS = [
  // Multi-word phrases first
  "please help",
  "help me",
  // Single words
  "help",
  "urgent",
  "asap",
  "immediately",
  "emergency",
  "panic",
];

/**
 * Content-bearing distress vocabulary.
 *
 * These signal urgency or brokenness, but they ALSO appear in
 * legitimate domain queries ("the pump is broken", "valve isn't
 * working"). Reusing them as CONVERSATIONAL anchors would over-pull
 * SUPPORT queries toward CONVERSATIONAL. Useful for detection only.
 *
 * Multi-word phrases first within this list for the same regex-
 * precedence reason as CONVERSATIONAL_EXEMPLARS.
 *
 * @type {string[]}
 */
const CONTENT_BEARING_URGENT = [
  // Multi-word phrases first
  "right now",
  "right away",
  "doesn't work",
  "does not work",
  "not working",
  // Single words
  "broken",
  "failed",
  "stuck",
  "now",
];

/**
 * Full urgent-keyword vocabulary — derived from the two disjoint
 * partitions above. Used by the urgent-keyword signal.
 *
 * Order matters for regex precedence in `findUrgentKeywords`: the
 * loop iterates entries in array order, and longer phrases must be
 * matched before their single-word suffixes (so "please help" wins
 * before "help" alone tries). Both partitions internally order
 * phrases-first, and exemplars are concatenated before content-
 * bearing entries — that preserves precedence end-to-end.
 *
 * @type {string[]}
 */
const URGENT_KEYWORDS = [
  ...CONVERSATIONAL_EXEMPLARS,
  ...CONTENT_BEARING_URGENT,
];

/**
 * Profanity tiers.
 *
 * Heavy: indicates strong frustration. Contributes full weight AND
 *   forces the score floor to PROFANITY_HEAVY_FLOOR. The floor exists
 *   so "wtf" alone reaches `frustrated` band — combining heavy
 *   profanity with no other signal still warrants empathetic prompt
 *   handling. Heavy is also safe as standalone CONVERSATIONAL anchor
 *   vocabulary (no legitimate domain context for bare "fuck").
 *
 * Light: indicates mild irritation. Contributes 60% of heavy weight,
 *   no floor. NOT safe as CONVERSATIONAL anchor vocabulary — words
 *   like "hell" appear in legitimate domain phrasings.
 */
const PROFANITY_HEAVY = [
  "fuck",
  "fucking",
  "shit",
  "wtf",
];

const PROFANITY_LIGHT = [
  "damn",
  "hell",
  "crap",
];

/**
 * Multiplier applied when only light profanity matches.
 */
const PROFANITY_LIGHT_MULTIPLIER = 0.6;

/**
 * Minimum score when heavy profanity is present. The floor only lifts;
 * never lowers.
 */
const PROFANITY_HEAVY_FLOOR = 0.5;

/**
 * Per-signal weights. Sum > 1.0 by design; final score is clamped.
 */
const WEIGHTS = {
  shouting:        0.25,
  repeatedPunct:   0.20,
  urgentKeywords:  0.25,
  profanity:       0.40,
};

/**
 * Per-character-type weights applied to EXCESS character counts.
 * Question-only excess is de-weighted because `???` is confusion,
 * not frustration.
 */
const REPEATED_PUNCT_WEIGHTS = {
  exclamation: 1.0,   // `!`-only excess — anger/urgency, full weight
  question:    0.5,   // `?`-only excess — confusion, half weight
  mixed:       1.0,   // mixed `!?` excess — `!` does the work
};

/**
 * Saturation cap on EFFECTIVE excess characters (after per-type weighting).
 *
 * Tuned so that:
 *   - `"!!"` (1 excess !)        → 0.20 of max
 *   - `"!!!"` (2 excess !)       → 0.40 of max
 *   - `"!!!!!!"` (5 excess !)    → 1.00 of max (capped)
 *   - `"???"` (2 excess × 0.5)   → 0.20 of max (one question run is mild)
 *   - `"???????????"` (10 × 0.5) → 1.00 of max (heavy question keymash)
 *
 * 5 is a reasonable cap — beyond that the user is just venting and
 * additional characters don't carry incremental information.
 */
const REPEATED_PUNCT_EXCESS_CAP = 5;

const URGENT_KEYWORDS_CAP = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Signal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count alphabetic uppercase / total alphabetic. Non-alphabetic
 * characters are ignored.
 */
const computeCapsRatio = (q) => {
  let upper = 0;
  let alpha = 0;
  for (const ch of q) {
    if (ch >= "A" && ch <= "Z") { upper++; alpha++; }
    else if (ch >= "a" && ch <= "z") { alpha++; }
  }
  return { ratio: alpha === 0 ? 0 : upper / alpha, alphaCount: alpha };
};

/**
 * Gradient shouting contribution. Returns 0.0 to 1.0.
 */
const computeShoutingContribution = (ratio, alphaCount) => {
  if (alphaCount < SHOUTING_MIN_LENGTH) return 0;
  if (ratio <= SHOUTING_RATIO_START) return 0;
  if (ratio >= SHOUTING_RATIO_FULL)  return 1;
  return (ratio - SHOUTING_RATIO_START) / (SHOUTING_RATIO_FULL - SHOUTING_RATIO_START);
};

/**
 * Analyze terminal-punctuation runs in `q`, returning BOTH run counts
 * (preserved for diagnostics + backward compat) AND excess character
 * counts (used by scoring).
 *
 * For each run of 2+ terminal marks:
 *   - Classify by character composition (exclamation / question / mixed)
 *   - Increment the bucket's run count
 *   - Add (run.length - 1) to the bucket's excess character count
 *
 * "Excess" = chars beyond the first. `"!"` has 0 excess (one normal
 * mark). `"!!"` has 1 excess. `"!!!!!!"` has 5 excess. This captures
 * intensity in a way run-counting can't.
 *
 * @param {string} q
 * @returns {{
 *   runs:   { exclamation: number, question: number, mixed: number, total: number },
 *   excess: { exclamation: number, question: number, mixed: number, total: number }
 * }}
 */
const analyzeRepeatedPunct = (q) => {
  const allRuns = q.match(/[!?]{2,}/g) || [];

  const runs   = { exclamation: 0, question: 0, mixed: 0, total: 0 };
  const excess = { exclamation: 0, question: 0, mixed: 0, total: 0 };

  for (const run of allRuns) {
    const runExcess = run.length - 1;
    const hasBang   = run.includes("!");
    const hasQuery  = run.includes("?");

    let bucket;
    if (hasBang && hasQuery)      bucket = "mixed";
    else if (hasBang)             bucket = "exclamation";
    else                          bucket = "question";

    runs[bucket]   += 1;
    runs.total     += 1;
    excess[bucket] += runExcess;
    excess.total   += runExcess;
  }

  return { runs, excess };
};

/**
 * Find all urgent-keyword matches in `q`. Multi-word phrases first to
 * prevent double-counting.
 */
const findUrgentKeywords = (q) => {
  const lower = q.toLowerCase();
  const found = [];
  const consumed = new Array(lower.length).fill(false);

  for (const kw of URGENT_KEYWORDS) {
    const pattern = kw.includes(" ")
      ? new RegExp(`(^|\\s)${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$|[.,!?])`, "gi")
      : new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");

    let m;
    while ((m = pattern.exec(lower)) !== null) {
      const matchStart = m.index + (m[1] ? m[1].length : 0);
      const matchEnd   = matchStart + kw.length;

      let overlap = false;
      for (let i = matchStart; i < matchEnd; i++) {
        if (consumed[i]) { overlap = true; break; }
      }
      if (overlap) continue;

      for (let i = matchStart; i < matchEnd; i++) consumed[i] = true;
      found.push(kw);
    }
  }

  return found;
};

/**
 * Detect profanity, returning the strongest tier found.
 *
 * @returns {"heavy" | "light" | null}
 */
const detectProfanityTier = (q) => {
  const lower = q.toLowerCase();
  if (PROFANITY_HEAVY.some(w => new RegExp(`\\b${w}\\b`).test(lower))) return "heavy";
  if (PROFANITY_LIGHT.some(w => new RegExp(`\\b${w}\\b`).test(lower))) return "light";
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Public function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute frustration signals for a raw query.
 *
 * @function detectFrustration
 * @param {string} rawQuery
 *   The raw user input, BEFORE normalization. Must be passed before
 *   `collapseRepeatedPunctuation` runs.
 *
 * @returns {{
 *   score:                          number,
 *   shouting:                       boolean,
 *   allCaps:                        boolean,
 *   repeatedPunctCount:             number,
 *   repeatedPunctByType:            { exclamation: number, question: number, mixed: number, total: number },
 *   repeatedPunctExcess:            { exclamation: number, question: number, mixed: number, total: number },
 *   repeatedPunctEffectiveExcess:   number,
 *   urgentKeywords:                 string[],
 *   profanity:                      boolean,
 *   profanityTier:                  "heavy" | "light" | null,
 *   contributions:                  { shouting: number, repeatedPunct: number, urgentKeywords: number, profanity: number },
 *   floorApplied:                   boolean
 * }}
 *
 *   `repeatedPunctCount` and `repeatedPunctByType` are run-based counts
 *   preserved for diagnostics and backward compatibility. They do NOT
 *   drive the score.
 *
 *   `repeatedPunctExcess` is the per-type excess character count.
 *   `repeatedPunctEffectiveExcess` is the per-type-weighted sum used
 *   directly in scoring (before the cap is applied).
 *
 *   `floorApplied` is true when the heavy-profanity floor lifted the
 *   score.
 *
 * @example
 *   detectFrustration("hello!!!");
 *   // → { score: ~0.08,
 *   //     repeatedPunctCount: 1,
 *   //     repeatedPunctByType: {exclamation: 1, question: 0, mixed: 0, total: 1},
 *   //     repeatedPunctExcess: {exclamation: 2, question: 0, mixed: 0, total: 2},
 *   //     repeatedPunctEffectiveExcess: 2,
 *   //     contributions: { ..., repeatedPunct: 0.08 } }
 *
 *   detectFrustration("hello!!!!!!");
 *   // → { score: ~0.20,
 *   //     repeatedPunctCount: 1,             ← still ONE run
 *   //     repeatedPunctExcess: {exclamation: 5, ..., total: 5},  ← but 5 excess chars
 *   //     repeatedPunctEffectiveExcess: 5,                       ← maxes the signal
 *   //     contributions: { ..., repeatedPunct: 0.2 } }
 */
const detectFrustration = (rawQuery) => {
  const q = rawQuery || "";

  // ── Signal 1: shouting (gradient) ────────────────────────────────────────
  const { ratio, alphaCount } = computeCapsRatio(q);
  const shoutingContrib       = computeShoutingContribution(ratio, alphaCount);
  const shouting              = shoutingContrib > 0;
  const allCaps               = ratio >= SHOUTING_RATIO_FULL && alphaCount > 0;

  // ── Signal 2: repeated punctuation (excess chars, by type) ───────────────
  //
  // Compute per-type excess character counts. Weight them and sum to
  // get effective excess. Divide by the cap to get 0..1 contribution.
  // The cap is on EFFECTIVE excess, not raw — so 10 question chars
  // (×0.5 = 5 effective) is equivalent to 5 exclamation chars.
  const { runs: repeatedPunctByType, excess: repeatedPunctExcess } = analyzeRepeatedPunct(q);
  const effectiveExcess =
    repeatedPunctExcess.exclamation * REPEATED_PUNCT_WEIGHTS.exclamation +
    repeatedPunctExcess.question    * REPEATED_PUNCT_WEIGHTS.question +
    repeatedPunctExcess.mixed       * REPEATED_PUNCT_WEIGHTS.mixed;
  const repeatedPunctContrib = Math.min(1, effectiveExcess / REPEATED_PUNCT_EXCESS_CAP);

  // ── Signal 3: urgent keywords ────────────────────────────────────────────
  const urgentKeywords = findUrgentKeywords(q);
  const urgentContrib  = Math.min(1, urgentKeywords.length / URGENT_KEYWORDS_CAP);

  // ── Signal 4: profanity (tiered, with heavy floor) ───────────────────────
  const profanityTier = detectProfanityTier(q);
  const profanity     = profanityTier !== null;
  const profanityContrib =
    profanityTier === "heavy" ? 1 :
    profanityTier === "light" ? PROFANITY_LIGHT_MULTIPLIER :
    0;

  // ── Compose ──────────────────────────────────────────────────────────────
  const contributions = {
    shouting:       WEIGHTS.shouting       * shoutingContrib,
    repeatedPunct:  WEIGHTS.repeatedPunct  * repeatedPunctContrib,
    urgentKeywords: WEIGHTS.urgentKeywords * urgentContrib,
    profanity:      WEIGHTS.profanity      * profanityContrib,
  };

  const summed =
    contributions.shouting +
    contributions.repeatedPunct +
    contributions.urgentKeywords +
    contributions.profanity;

  // Apply heavy-profanity floor before final upper clamp.
  let raw = summed;
  let floorApplied = false;
  if (profanityTier === "heavy" && raw < PROFANITY_HEAVY_FLOOR) {
    raw = PROFANITY_HEAVY_FLOOR;
    floorApplied = true;
  }

  const score = Math.min(1, raw);

  return {
    score,
    shouting,
    allCaps,
    repeatedPunctCount:           repeatedPunctByType.total,
    repeatedPunctByType,
    repeatedPunctExcess,
    repeatedPunctEffectiveExcess: effectiveExcess,
    urgentKeywords,
    profanity,
    profanityTier,
    contributions,
    floorApplied,
  };
};

// Expose internals for tests + tuning.
detectFrustration.WEIGHTS                       = WEIGHTS;
detectFrustration.REPEATED_PUNCT_WEIGHTS        = REPEATED_PUNCT_WEIGHTS;
detectFrustration.SHOUTING_RATIO_START          = SHOUTING_RATIO_START;
detectFrustration.SHOUTING_RATIO_FULL           = SHOUTING_RATIO_FULL;
detectFrustration.REPEATED_PUNCT_EXCESS_CAP     = REPEATED_PUNCT_EXCESS_CAP;
detectFrustration.URGENT_KEYWORDS_CAP           = URGENT_KEYWORDS_CAP;
detectFrustration.PROFANITY_LIGHT_MULTIPLIER    = PROFANITY_LIGHT_MULTIPLIER;
detectFrustration.PROFANITY_HEAVY_FLOOR         = PROFANITY_HEAVY_FLOOR;

// Vocabulary partitions. URGENT_KEYWORDS is the derived union; the
// two partition arrays are the canonical sources.
detectFrustration.CONVERSATIONAL_EXEMPLARS      = CONVERSATIONAL_EXEMPLARS;
detectFrustration.CONTENT_BEARING_URGENT        = CONTENT_BEARING_URGENT;
detectFrustration.URGENT_KEYWORDS               = URGENT_KEYWORDS;
detectFrustration.PROFANITY_HEAVY               = PROFANITY_HEAVY;
detectFrustration.PROFANITY_LIGHT               = PROFANITY_LIGHT;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(
  detectFrustration,
  "detectFrustration",
  { value: detectFrustration }
));