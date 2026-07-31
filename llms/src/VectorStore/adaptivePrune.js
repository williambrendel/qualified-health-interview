"use strict";

const entropyEffectiveCount         = require("./entropyEffectiveCount");
const ratioEffectiveCount           = require("./ratioEffectiveCount");
const { RATIO_MIN_GAP, MAX_CUT_INDEX } = require("./constants");

/**
 * @file adaptivePrune.js
 * @module VectorStore/adaptivePrune
 * @description In-place truncation of a sorted hit list at the
 * composite effective count derived from two complementary measures.
 *
 * Composition strategy. Adaptive prune runs both
 * {@link entropyEffectiveCount} and {@link ratioEffectiveCount} and
 * uses the *more aggressive* cut. The two measures answer the same
 * question — "how far down the sorted list is still signal?" — but
 * with different sensitivities:
 *
 *   - **Entropy** measures normalized probability mass. It catches
 *     "the distribution has fanned out, the tail isn't carrying
 *     meaningful mass." Strong on distributions where mass is
 *     concentrated relative to the spread.
 *
 *   - **Ratio** measures consecutive score drops. It catches "there
 *     is a visible cliff in the raw scores." Strong on cosine
 *     distributions where probability mass is broad (after
 *     normalization) but the raw curve has clear elbows.
 *
 * Either signal is sufficient to prune — the composition takes
 * `min(entropy, ratio)`. An item survives only when BOTH measures
 * think it's above the cliff.
 *
 * Bounded scan optimization. Rather than running the two measures
 * independently and taking `min` post-hoc, we run entropy first and
 * pass its result as `maxCutIndex` to ratio. Ratio's scan is then
 * bounded to entropy's window:
 *
 *   - If entropy's cut is tighter than what ratio would find,
 *     ratio's loop terminates early and the entropy result wins.
 *   - If ratio finds a tighter cut within entropy's window, the
 *     ratio result wins.
 *
 * Either way the combined measure costs O(n) total instead of two
 * independent O(n) passes followed by an explicit `min`. The
 * mathematical result is identical: a hit survives iff both measures
 * vote to keep it.
 *
 * Cosine-tuned defaults. Empirically, real-world cosine score
 * distributions produce consecutive ratios in the [1.0, 2.0] range —
 * even on visually peaky distributions. The `ratioEffectiveCount`
 * function's own default `minGap = 3` is therefore too conservative
 * for cosine: it almost never fires. Adaptive prune overrides this
 * default to {@link RATIO_MIN_GAP} (currently 1.5), tuned so the
 * ratio measure activates on the moderate cliffs typical of cosine
 * retrieval distributions. Callers can override per-call via
 * `options.minGap`.
 *
 * Caller must pre-sort `hits` descending by score. Both measure
 * primitives rely on this precondition.
 */

/**
 * Prune a sorted hit list in place at the composite effective count.
 *
 * @function adaptivePrune
 *
 * @param {Array<{ score: number }>} hits
 *   Pre-sorted descending by `.score`. Truncated in place.
 *
 * @param {object} [options]
 *   Forwarded to the underlying measure primitives. Common knobs:
 *
 *   - `minGap` — ratio threshold. Defaults to {@link RATIO_MIN_GAP}
 *     (1.5, cosine-tuned) when not provided. Caller's value wins
 *     when provided.
 *   - `minLogGap` — log-space equivalent of `minGap`. Ignored if
 *     `minGap` is provided.
 *   - `eps` — noise floor for ratio. Defaults to `1e-10`.
 *   - `maxCutIndex` — defensive upper bound on the cut index.
 *     Defaults to {@link MAX_CUT_INDEX} (currently 30). Caps the
 *     work done by downstream stages (rerank, pivot, safety rails)
 *     and the eventual LLM context. Non-positive values fall back
 *     to the default rather than producing an empty result.
 *
 * @returns {Array<{ score: number }>}
 *   The same `hits` reference, now truncated in place to the
 *   composite effective count.
 *
 * @example
 *   const hits = [
 *     { score: 0.85, ... }, { score: 0.82, ... }, { score: 0.80, ... },
 *     { score: 0.20, ... }, { score: 0.15, ... },
 *   ];
 *   adaptivePrune(hits);
 *   // hits.length === 3 (the cliff at 0.80→0.20 cut the tail)
 */
const adaptivePrune = (hits, options) => {
  options = options || {};

  // Honor caller's maxCutIndex when positive; otherwise default to
  // MAX_CUT_INDEX (the defensive bound on what adaptive prune
  // considers). Using `> 0` rather than `?? MAX_CUT_INDEX` so that
  // explicit non-positive values are also treated as "use default"
  // — passing 0 or -1 to mean "drop everything" is rarely the intent
  // and would silently break callers.
  const maxCutIndex = options.maxCutIndex > 0 ? options.maxCutIndex : MAX_CUT_INDEX;

  // Run entropy first, capped at caller's maxCutIndex. Its result
  // bounds ratio's scan window for the O(n) composition.
  const entropyCount = entropyEffectiveCount(hits, { maxCutIndex });

  // Short-circuit: when entropy says "drop everything" (no positive
  // scores at all), there's nothing for ratio to find. Truncate to
  // zero and return — ratio's own internal clamp would otherwise
  // resurrect the result to 1.
  if (entropyCount === 0) {
    hits.length = 0;
    return hits;
  }

  // Apply cosine-tuned default for minGap only when the caller
  // supplied neither minGap nor minLogGap. Specifying either form
  // counts as opting out of the default — silently overriding
  // caller's `minLogGap` with our `minGap=1.5` would drop their
  // intent.
  const callerSuppliedGap =
    options.minGap    !== undefined && options.minGap    !== null ||
    options.minLogGap !== undefined && options.minLogGap !== null;

  const ratioOptions = {
    ...(callerSuppliedGap ? {} : { minGap: RATIO_MIN_GAP }),
    ...options,
    // Cap ratio's scan at entropy's effective count. This is the
    // O(n)-composition trick: entropy bounds ratio's window, so
    // their combined cost is one entropy pass plus one bounded
    // ratio pass, never more.
    maxCutIndex: Math.min(entropyCount, maxCutIndex),
  };

  hits.length = ratioEffectiveCount(hits, ratioOptions);
  return hits;
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(adaptivePrune, "adaptivePrune", {
  value: adaptivePrune,
}));