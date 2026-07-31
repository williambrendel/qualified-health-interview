"use strict";

const adaptivePrune    = require("./adaptivePrune");
const rerank           = require("./rerank");
const applySafetyRails = require("./applySafetyRails");
const {
  ABSOLUTE_FLOOR,
  MIN_OUTPUT_ROWS,
  RERANK_ENABLED,
  RERANK_THRESHOLD,
  PIVOT_ENABLED,
  PIVOT_MIN_RESULTS,
  PIVOT_MIN_ANCHOR_SCORE,
  PIVOT_MAX_RESULTS,
  MAX_CUT_INDEX,
} = require("./constants");

/**
 * @file search.js
 * @module VectorStore/search
 *
 * (Pipeline docstring unchanged — see prior version.)
 *
 * ## Tracing
 *
 * Optional `onTrace` callback fires at each pipeline stage with
 * structured events. Events have shape `{ stage, ...fields }` where
 * stage is one of: "scored", "adaptivePrune", "pivot", "rerank",
 * "safetyRails", "userCap".
 *
 * The rerank event includes top-5 sets (documentId+range pairs)
 * before and after, plus an overlap measure (count of items present
 * in both sets). This lets callers distinguish between meaningful
 * reordering (low overlap — different documents promoted) and
 * cosmetic shuffling (high overlap — same documents in slightly
 * different order).
 */

const stripInternals = hits => {
  for (let i = 0, l = hits.length; i !== l; ++i) delete hits[i].bestVec;
};

const scoreStats = (hits) => {
  if (hits.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0, l = hits.length; i !== l; ++i) {
    const s = hits[i].score;
    if (s < min) min = s;
    if (s > max) max = s;
    sum += s;
  }
  return { min, max, mean: sum / hits.length, count: hits.length };
};

/**
 * Build a deduplication key for a hit. Lets us compare hit sets
 * across the rerank boundary by documentId + range pair.
 */
const hitKey = (hit) =>
  `${hit.documentId}|${hit.range[0]}|${hit.range[1]}`;

/**
 * Capture the top-K hits as a structured summary (documentId, range,
 * score, rank). Used to snapshot pre-rerank and post-rerank states
 * for the trace event.
 *
 * @param {Array<object>} hits
 * @param {number} k
 * @returns {Array<{rank: number, documentId: string, range: [number, number], score: number}>}
 */
const captureTopK = (hits, k = 5) => {
  const out = [];
  const limit = Math.min(hits.length, k);
  for (let i = 0; i < limit; ++i) {
    out.push({
      rank:       i,
      documentId: hits[i].documentId,
      range:      hits[i].range,
      score:      hits[i].score,
    });
  }
  return out;
};

const search = (target, queryVec, {
  maxRows         = Infinity,
  rerank: rerankEnabled = RERANK_ENABLED,
  rerankThreshold = RERANK_THRESHOLD,
  usePivot              = PIVOT_ENABLED,
  pivotMinResults       = PIVOT_MIN_RESULTS,
  pivotMinAnchorScore   = PIVOT_MIN_ANCHOR_SCORE,
  pivotMaxResults       = PIVOT_MAX_RESULTS,
  maxCutIndex           = MAX_CUT_INDEX,
  onTrace,
} = {}) => {
  if (!(queryVec instanceof Float32Array)) {
    throw new Error("search: queryVec must be a Float32Array");
  }

  const store = Array.isArray(target) ? target : [target];
  if (store.length === 0) return [];

  const dim = queryVec.length;

  // ── 1-3. Score every document ──────────────────────────────────
  const allHits = [];
  for (let i = 0, l = store.length; i !== l; ++i) {
    allHits.push(...store[i].score(queryVec, ABSOLUTE_FLOOR));
  }

  if (allHits.length === 0) {
    onTrace?.({ stage: "scored", hitCount: 0, scoreStats: null, floor: ABSOLUTE_FLOOR });
    return [];
  }

  // ── 4. Sort + snapshot ─────────────────────────────────────────
  allHits.sort((a, b) => b.score - a.score);
  const savedCosine = allHits.slice();

  onTrace?.({
    stage:      "scored",
    hitCount:   allHits.length,
    scoreStats: scoreStats(allHits),
    floor:      ABSOLUTE_FLOOR,
    topScores:  allHits.slice(0, 5).map(h => h.score),
  });

  // ── 5. Adaptive prune ──────────────────────────────────────────
  let candidateSet = allHits.slice();
  const beforePruneCount = candidateSet.length;
  adaptivePrune(candidateSet, { maxCutIndex });

  onTrace?.({
    stage:       "adaptivePrune",
    beforeCount: beforePruneCount,
    afterCount:  candidateSet.length,
    cutScore:    candidateSet.length > 0 ? candidateSet[candidateSet.length - 1].score : null,
    nextScore:   beforePruneCount > candidateSet.length
      ? allHits[candidateSet.length]?.score ?? null
      : null,
    maxCutIndex,
  });

  if (candidateSet.length === 0) {
    const out = savedCosine.slice(0, MIN_OUTPUT_ROWS);
    onTrace?.({
      stage:    "safetyRails",
      mode:     "emptyPruneFallback",
      restored: out.length,
    });
    stripInternals(out);
    return out.slice(0, maxRows);
  }

  // ── 6. Pivot expansion ─────────────────────────────────────────
  const pivotEligibleBySize   = candidateSet.length <= pivotMinResults;
  const pivotEligibleByAnchor = candidateSet[0].score >= pivotMinAnchorScore;
  const pivotShouldRun = usePivot && pivotEligibleBySize && pivotEligibleByAnchor;

  if (pivotShouldRun) {
    const anchor      = candidateSet[0];
    const anchorScore = anchor.score;
    const beforePivotSize = candidateSet.length;

    const rawPivot = [];
    for (let i = 0, l = store.length; i !== l; ++i) {
      rawPivot.push(...store[i].score(anchor.bestVec, ABSOLUTE_FLOOR));
    }
    rawPivot.sort((a, b) => b.score - a.score);

    if (rawPivot.length > pivotMaxResults) rawPivot.length = pivotMaxResults;

    const seen = new Set(candidateSet.map(hitKey));
    let pivotAdded = 0;
    for (const hit of rawPivot) {
      const key = hitKey(hit);
      if (seen.has(key)) continue;
      hit.score *= anchorScore;
      candidateSet.push(hit);
      seen.add(key);
      ++pivotAdded;
    }

    candidateSet.sort((a, b) => b.score - a.score);

    onTrace?.({
      stage:         "pivot",
      triggered:     true,
      reason:        "candidateSet sparse and anchor strong",
      anchorScore,
      beforeSize:    beforePivotSize,
      pivotPoolSize: rawPivot.length,
      pivotAdded,
      afterSize:     candidateSet.length,
    });
  } else {
    let reason;
    if (!usePivot)                 reason = "pivot disabled by option";
    else if (!pivotEligibleBySize) reason = `candidate set (${candidateSet.length}) above sparse threshold (${pivotMinResults})`;
    else                           reason = `anchor score (${candidateSet[0].score.toFixed(3)}) below threshold (${pivotMinAnchorScore})`;

    onTrace?.({
      stage:     "pivot",
      triggered: false,
      reason,
    });
  }

  // ── 7. Rerank ──────────────────────────────────────────────────
  //
  // Capture pre-rerank top-5 for diagnostic comparison. We capture
  // BEFORE the rerank call mutates `candidateSet`'s score field.
  // Without this snapshot the trace can only show position numbers
  // ("20→0") — useful but doesn't answer "did rerank actually surface
  // different documents, or just shuffle near-ties?".
  const preRerankTopK = captureTopK(candidateSet, 5);

  let working = candidateSet;
  let savedForFinalPrune = candidateSet.slice();

  if (rerankEnabled) {
    const { reranked, skipped } = rerank(queryVec, candidateSet, allHits, dim, rerankThreshold);

    if (skipped) {
      onTrace?.({
        stage:     "rerank",
        triggered: true,
        skipped:   true,
        reason:    "too many weak dimensions (centroid disagrees with query)",
      });
    } else {
      working = reranked;
      savedForFinalPrune = savedCosine;

      // Build position-change diagnostics: for each reranked hit, find
      // its position in the pre-rerank list.
      const preIndex = new Map();
      for (let i = 0; i !== preRerankTopK.length; ++i) {
        preIndex.set(hitKey(preRerankTopK[i]), i);
      }
      // Also build a wider preIndex from the full pre-rerank set so we
      // can show positions for items that came from below top-5.
      const preFullIndex = new Map();
      for (let i = 0; i !== candidateSet.length; ++i) {
        preFullIndex.set(hitKey(candidateSet[i]), i);
      }

      const positionChanges = [];
      for (let i = 0; i < Math.min(reranked.length, 5); ++i) {
        const r = reranked[i];
        const k = hitKey(r);
        const before = preFullIndex.has(k) ? preFullIndex.get(k) : "new";
        if (before !== i) {
          positionChanges.push({ from: before, to: i, score: r.score });
        }
      }

      // Compute the meaningfulness measure: how many of the pre-rerank
      // top-5 documents (by hitKey) are STILL in the post-rerank top-5?
      // Low overlap (1-2) → rerank meaningfully surfaced new documents.
      // High overlap (4-5) → rerank reshuffled near-ties without
      // changing what surfaced.
      const postRerankTopK = captureTopK(reranked, 5);
      const preKeys  = new Set(preRerankTopK.map(hitKey));
      const postKeys = new Set(postRerankTopK.map(hitKey));
      let overlap = 0;
      for (const k of preKeys) if (postKeys.has(k)) ++overlap;

      let meaningfulness;
      if (overlap >= 4)      meaningfulness = "cosmetic (same docs reshuffled)";
      else if (overlap >= 2) meaningfulness = "partial (mix of original + new)";
      else                   meaningfulness = "substantive (new docs surfaced)";

      onTrace?.({
        stage:           "rerank",
        triggered:       true,
        skipped:         false,
        beforeCount:     candidateSet.length,
        afterCount:      reranked.length,
        positionChanges,
        topReranked:     reranked.slice(0, 5).map(h => h.score),
        preTopK:         preRerankTopK,
        postTopK:        postRerankTopK,
        top5Overlap:     overlap,
        meaningfulness,
      });
    }
  } else {
    onTrace?.({
      stage:     "rerank",
      triggered: false,
      reason:    "rerank disabled by option",
    });
  }

  // ── 8. Safety rails ────────────────────────────────────────────
  const beforeRailsCount = working.length;
  applySafetyRails(working, savedForFinalPrune);

  onTrace?.({
    stage:       "safetyRails",
    mode:        "normal",
    beforeCount: beforeRailsCount,
    afterCount:  working.length,
  });

  // ── 9. User cap ────────────────────────────────────────────────
  const beforeCapCount = working.length;
  if (working.length > maxRows) working.length = maxRows;

  if (beforeCapCount !== working.length) {
    onTrace?.({
      stage:    "userCap",
      from:     beforeCapCount,
      to:       working.length,
      maxRows,
    });
  }

  // ── 10. Strip internal fields ─────────────────────────────────
  stripInternals(working);
  return working;
};

module.exports = Object.freeze(Object.defineProperty(search, "search", {
  value: search,
}));