"use strict";

/**
 * @file unionHits.js
 * @module actions/query/unionHits
 * @description Merge per-segment search hit arrays into one sorted,
 * deduplicated list for downstream consumption.
 *
 * ## What this exists for
 *
 * Multi-part queries fan out into N segments at retrieval time —
 * each segment is its own search call against the VectorStore.
 * Result: an array of arrays. Before passing hits to the prompt
 * serializer, the orchestrator needs a single ranked list. That's
 * this function.
 *
 * The serializer doesn't care which segment retrieved which hit
 * (per locked design: "the LLM doesn't see parts breakdown"), so
 * once we have the union, the segment structure is discarded.
 *
 * ## Dedup key
 *
 * Two hits refer to the "same" section when they share BOTH
 * documentId and range. Two segments retrieving the same section
 * is common — e.g. "what causes biofilm" and "how do biocides
 * fail" both surface "biofilm protection" content. We keep only
 * one row in the union, with the higher of the two scores.
 *
 * Score isn't part of the key; it's the field we maximize across
 * duplicates. This matters because the LLM ranks-by-score when
 * choosing which hits to draw from — promoting the higher score
 * when the same section is retrieved by multiple segments
 * accurately reflects "this section is relevant to multiple
 * parts of the query."
 *
 * ## Ordering
 *
 * Final output is sorted by score descending. For ties (same
 * score), the original ordering within the first occurrence is
 * preserved — stable enough for deterministic tests, doesn't
 * matter much for LLM consumption since the prompt rules don't
 * depend on intra-tier ordering.
 *
 * ## Bounds
 *
 * No cap is applied. The orchestrator decides whether to truncate
 * the union before passing to the LLM (e.g. `MAX_OUTPUT_ROWS`).
 * Keeping this function unaware of caps makes it composable —
 * truncate is a separate concern.
 */

/**
 * Build the dedup key for a hit. `documentId` and the bracketed
 * `[start,end]` range, joined.
 *
 * Format chosen so collisions are impossible: documentId can
 * contain `|` (it's the structural delimiter inside the ID), but
 * cannot contain `[` or `]`. Bracketing the range therefore makes
 * the boundary between docId and range unambiguous. Same dedup
 * scheme used in {@link rerank} so the keys line up.
 *
 * @param {{documentId: string, range: [number, number]}} hit
 * @returns {string}
 */
const hitKey = (hit) => {
  if (!hit || typeof hit.documentId !== "string" || !Array.isArray(hit.range)) {
    return null;
  }
  return `${hit.documentId}[${hit.range[0]},${hit.range[1]}]`;
};

/**
 * Merge an array of per-segment hit arrays into one sorted,
 * deduplicated list.
 *
 * @param {Array<Array<{score: number, documentId: string, range: [number, number]}>>} hitArrays
 *   Output of `Promise.all(segments.map(s => search(store, s.vec)))`.
 *   Each inner array is one segment's hits, already sorted descending
 *   by the search function. May be empty; may contain empty arrays.
 * @returns {Array<{score: number, documentId: string, range: [number, number]}>}
 *   Flattened, deduplicated, score-descending merge. Hits without
 *   a valid documentId+range pair are dropped (defensive — should
 *   not occur in practice but easy to handle if it does).
 *
 * @example
 *   unionHits([
 *     [
 *       { score: 0.8, documentId: "a|x", range: [0, 100] },
 *       { score: 0.6, documentId: "a|y", range: [0, 100] },
 *     ],
 *     [
 *       { score: 0.7, documentId: "a|x", range: [0, 100] },  // dup; higher 0.8 wins
 *       { score: 0.5, documentId: "a|z", range: [0, 100] },
 *     ],
 *   ]);
 *   // → [
 *   //     { score: 0.8, documentId: "a|x", range: [0, 100] },
 *   //     { score: 0.6, documentId: "a|y", range: [0, 100] },
 *   //     { score: 0.5, documentId: "a|z", range: [0, 100] },
 *   //   ]
 */
const unionHits = (hitArrays) => {
  // Build a map keyed by documentId+range. On collision, keep the
  // higher-scoring entry. We walk all hits once and write to the
  // map, then materialize and sort once at the end — O(N log N)
  // for N total hits.
  const byKey = new Map();

  for (const segmentHits of hitArrays || []) {
    if (!Array.isArray(segmentHits)) continue;
    for (const hit of segmentHits) {
      const key = hitKey(hit);
      if (key === null) continue;  // malformed hit; drop silently
      const existing = byKey.get(key);
      if (existing === undefined || hit.score > existing.score) {
        byKey.set(key, hit);
      }
    }
  }

  // Materialize and sort descending by score. Stable sort by
  // insertion order for ties — V8's Array.prototype.sort has been
  // stable since v7.0 (Node 11+), which we assume.
  return Array.from(byKey.values()).sort((a, b) => b.score - a.score);
};

// Helper export — same key format the dedup logic uses, exposed
// for tests and adjacent code that wants to inspect dedup behavior
// without re-importing. Attached BEFORE the Object.freeze below
// (silent freeze + property-add is a common foot-gun).
unionHits.hitKey = hitKey;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(unionHits, "unionHits", {
  value: unionHits,
}));