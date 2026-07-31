"use strict";

/**
 * @file retrievalDiagnostics.js
 * @module actions/query/retrievalDiagnostics
 * @description Trace collection + formatting for retrieval diagnostics.
 * See module-level docs in the prior version for usage. This update
 * adds rendering for:
 *   - "skipped" segments (CONVERSATIONAL filter at orchestrator level)
 *   - Richer rerank diagnostics: top-5 overlap, meaningfulness label,
 *     before/after top-K snapshots
 */

// ─────────────────────────────────────────────────────────────────────────────
// Trace collector
// ─────────────────────────────────────────────────────────────────────────────

const makeTraceCollector = () => {
  const segments = [];
  let union = null;

  return {
    forSegment(index, segmentText) {
      if (!segments[index]) {
        segments[index] = {
          index,
          segmentText: segmentText || "",
          stages:      [],
        };
      }
      return (event) => {
        segments[index].stages.push(event);
      };
    },

    recordUnion(unionedHits, finalResults) {
      union = {
        unionedCount:    unionedHits.length,
        finalCount:      finalResults.length,
        finalTopScores:  finalResults.slice(0, 12).map(h => h.score),
        distribution:    computeDistributionStats(finalResults),
        thresholds:      suggestThresholds(finalResults),
      };
    },

    collect() {
      return { segments, union };
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Distribution statistics
// ─────────────────────────────────────────────────────────────────────────────

const computeDistributionStats = (hits) => {
  const n = hits.length;
  if (n === 0) return null;
  if (n === 1) {
    return { mean: hits[0].score, stddev: 0, entropy: 0, maxEntropy: 0, label: "peaky" };
  }

  let sum = 0;
  for (const h of hits) sum += h.score;
  const mean = sum / n;

  let sqDiffSum = 0;
  for (const h of hits) sqDiffSum += (h.score - mean) ** 2;
  const stddev = Math.sqrt(sqDiffSum / n);

  let entropy = 0;
  if (sum > 0) {
    for (const h of hits) {
      const p = h.score / sum;
      if (p > 0) entropy -= p * Math.log2(p);
    }
  }
  const maxEntropy = Math.log2(n);

  let label;
  const ratio = maxEntropy > 0 ? entropy / maxEntropy : 0;
  if (ratio < 0.5)       label = "peaky";
  else if (ratio < 0.85) label = "moderate";
  else                   label = "flat";

  return { mean, stddev, entropy, maxEntropy, label };
};

// ─────────────────────────────────────────────────────────────────────────────
// Threshold analyzers
// ─────────────────────────────────────────────────────────────────────────────

const suggestThresholds = (hits) => {
  const n = hits.length;
  if (n < 2) return null;

  let largestDrop = 0;
  let dropAt = -1;
  for (let i = 0; i < n - 1; ++i) {
    const drop = hits[i].score - hits[i + 1].score;
    if (drop > largestDrop) {
      largestDrop = drop;
      dropAt = i;
    }
  }
  const meaningfulThreshold = hits[0].score * 0.10;
  const knee = largestDrop >= meaningfulThreshold
    ? {
        wouldKeep:     dropAt + 1,
        dropAt,
        dropMagnitude: largestDrop,
        reason:        `score drop ${largestDrop.toFixed(3)} at index ${dropAt}→${dropAt + 1}`,
      }
    : {
        wouldKeep:     null,
        dropAt:        -1,
        dropMagnitude: largestDrop,
        reason:        `no meaningful knee (largest drop ${largestDrop.toFixed(3)} < threshold ${meaningfulThreshold.toFixed(3)})`,
      };

  const ratio = hits[1].score > 0 ? hits[0].score / hits[1].score : Infinity;
  let label;
  if (ratio >= 1.5)      label = "clear winner";
  else if (ratio >= 1.2) label = "moderate winner";
  else                   label = "no dominant winner";

  const stats = computeDistributionStats(hits);
  const sigmaThreshold = stats.mean + stats.stddev;
  let zScoreCount = 0;
  for (const h of hits) if (h.score >= sigmaThreshold) ++zScoreCount;

  let meanCount = 0;
  for (const h of hits) if (h.score >= stats.mean) ++meanCount;

  return {
    knee,
    scoreGap:   { ratio, label },
    zScore:     { wouldKeep: zScoreCount, sigma: 1.0 },
    meanCutoff: { wouldKeep: meanCount, mean: stats.mean },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a single hit's identity for display. Truncates long
 * documentIds to keep lines under terminal width.
 */
const formatHitId = (hit, maxLen = 60) => {
  const id = hit.documentId || "?";
  const r  = Array.isArray(hit.range) ? `[${hit.range[0]},${hit.range[1]}]` : "";
  const full = `${id}${r}`;
  if (full.length <= maxLen) return full;
  // Truncate the documentId part, keep the range visible.
  const idMaxLen = maxLen - r.length - 3;
  return `${id.slice(0, idMaxLen)}...${r}`;
};

const formatStageEvent = (event) => {
  switch (event.stage) {
    case "skipped": {
      const conf = event.confidence !== null && event.confidence !== undefined
        ? ` conf=${event.confidence.toFixed(2)}`
        : "";
      return `  skipped:        ${event.reason}${conf}`;
    }

    case "scored": {
      if (!event.scoreStats) return `  scored:         0 hits`;
      const s = event.scoreStats;
      return `  scored:         ${event.hitCount} hits, score range [${s.min.toFixed(3)}..${s.max.toFixed(3)}] floor=${event.floor}`;
    }

    case "adaptivePrune": {
      const dropped = event.beforeCount - event.afterCount;
      const cliff = event.nextScore !== null && event.cutScore !== null
        ? ` (cut@${event.cutScore.toFixed(3)} → next ${event.nextScore.toFixed(3)})`
        : "";
      return `  adaptivePrune:  ${event.beforeCount} → ${event.afterCount} (dropped ${dropped})${cliff}`;
    }

    case "pivot": {
      if (event.triggered) {
        return `  pivot:          fired, +${event.pivotAdded} (anchor=${event.anchorScore.toFixed(3)}, ${event.beforeSize}→${event.afterSize})`;
      }
      return `  pivot:          skipped (${event.reason})`;
    }

    case "rerank": {
      if (!event.triggered)  return `  rerank:         disabled (${event.reason})`;
      if (event.skipped)     return `  rerank:         skipped (${event.reason})`;

      const lines = [];
      const changes = event.positionChanges.length === 0
        ? "no top-5 position changes"
        : event.positionChanges.map(c => `${c.from}→${c.to}`).join(", ");
      lines.push(`  rerank:         ran, ${event.beforeCount}→${event.afterCount} (${changes})`);
      lines.push(`                  meaningfulness: ${event.meaningfulness} (top-5 overlap ${event.top5Overlap}/5)`);

      // Show pre→post top-5 transitions for visibility into WHICH
      // documents surfaced.
      if (event.preTopK && event.postTopK) {
        lines.push(`                  pre-rerank top-5:`);
        for (const h of event.preTopK) {
          lines.push(`                    ${h.rank}. ${formatHitId(h)} [${h.score.toFixed(3)}]`);
        }
        lines.push(`                  post-rerank top-5:`);
        for (const h of event.postTopK) {
          lines.push(`                    ${h.rank}. ${formatHitId(h)} [${h.score.toFixed(3)}]`);
        }
      }
      return lines.join("\n");
    }

    case "safetyRails": {
      if (event.mode === "emptyPruneFallback") {
        return `  safetyRails:    empty-prune fallback, restored ${event.restored}`;
      }
      if (event.beforeCount === event.afterCount) {
        return `  safetyRails:    no-op (${event.afterCount} within bounds)`;
      }
      return `  safetyRails:    ${event.beforeCount} → ${event.afterCount}`;
    }

    case "userCap":
      return `  userCap:        ${event.from} → ${event.to} (cap=${event.maxRows})`;

    default:
      return `  ${event.stage}: ${JSON.stringify(event)}`;
  }
};

const formatTraceReport = (collected) => {
  const lines = [];
  lines.push("[retrieval] ──────────────────────────────────────────");

  if (collected.segments.length === 0) {
    lines.push("[retrieval] (no segments traced)");
  }

  for (const seg of collected.segments) {
    if (!seg) continue;
    const truncated = seg.segmentText.length > 60
      ? seg.segmentText.slice(0, 57) + "..."
      : seg.segmentText;
    lines.push(`[retrieval] segment[${seg.index}] "${truncated}"`);
    for (const event of seg.stages) {
      lines.push(`[retrieval] ${formatStageEvent(event)}`);
    }
  }

  if (collected.union) {
    const u = collected.union;
    lines.push(`[retrieval] union: ${u.unionedCount} unique hits (final=${u.finalCount})`);

    if (u.distribution) {
      const d = u.distribution;
      lines.push(`[retrieval] distribution:`);
      lines.push(`  mean=${d.mean.toFixed(3)} stddev=${d.stddev.toFixed(3)} entropy=${d.entropy.toFixed(2)}/${d.maxEntropy.toFixed(2)} (${d.label})`);
    }

    if (u.thresholds) {
      const t = u.thresholds;
      lines.push(`[retrieval] threshold suggestions:`);
      const kneeStr = t.knee.wouldKeep !== null
        ? `keep ${t.knee.wouldKeep} (${t.knee.reason})`
        : t.knee.reason;
      lines.push(`  knee:        ${kneeStr}`);
      lines.push(`  scoreGap:    top/2nd ratio ${t.scoreGap.ratio.toFixed(2)} (${t.scoreGap.label})`);
      lines.push(`  zScore≥1σ:   keep ${t.zScore.wouldKeep}`);
      lines.push(`  meanCutoff:  keep ${t.meanCutoff.wouldKeep} (mean=${t.meanCutoff.mean.toFixed(3)})`);
    }
  }

  lines.push("[retrieval] ──────────────────────────────────────────");
  return lines.join("\n");
};

module.exports = Object.freeze({
  makeTraceCollector,
  computeDistributionStats,
  suggestThresholds,
  formatTraceReport,
  formatStageEvent,
});