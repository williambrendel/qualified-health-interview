"use strict";

/**
 * @module pipeline/ingest/sniff
 * @description
 * Deterministic structural sniff. Before any AI is involved, we settle the
 * boring-but-critical structural questions with plain heuristics: which byte is
 * the delimiter, what quote character is in play, and whether the first row is a
 * header. This is the "clean grid" the AI input connector later reasons over — the
 * model never has to guess structure it cannot see.
 *
 * The sniff is conservative and explainable: every choice is a counted vote, not a
 * black box, so a human can look at the numbers and agree.
 */

const CANDIDATE_DELIMITERS = [",", "\t", ";", "|"];

/**
 * Split into physical lines while ignoring quoted line breaks, so a multi-line
 * quoted note doesn't distort delimiter counting. Used for sniffing only.
 * @param {string} text
 * @param {string} quote
 * @returns {string[]}
 */
function physicalLines(text, quote) {
  const lines = [];
  let line = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === quote) inQuotes = !inQuotes;
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      lines.push(line);
      line = "";
    } else {
      line += ch;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * Choose the delimiter whose per-line occurrence count is both high and
 * consistent (low variance) across the sampled lines — the hallmark of a true
 * column separator versus a character that merely appears in free text.
 *
 * @param {string[]} lines
 * @returns {{delimiter: string, confidence: number}}
 */
function detectDelimiter(lines) {
  const sample = lines.slice(0, 50).filter((l) => l.length > 0);
  let best = { delimiter: ",", score: -Infinity, confidence: 0 };

  for (const d of CANDIDATE_DELIMITERS) {
    const counts = sample.map((l) => l.split(d).length - 1);
    const nonZero = counts.filter((c) => c > 0).length;
    if (nonZero === 0) continue;
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    // Reward frequency and consistency; punish variance.
    const score = mean * (nonZero / sample.length) - variance;
    if (score > best.score) {
      best = { delimiter: d, score, confidence: nonZero / sample.length };
    }
  }
  return { delimiter: best.delimiter, confidence: best.confidence };
}

/**
 * Decide whether the first row looks like a header: mostly non-numeric, no blank
 * names, and distinct from the type profile of the rows beneath it.
 *
 * @param {string[][]} rows
 * @returns {boolean}
 */
function detectHeader(rows) {
  if (rows.length === 0) return false;
  const first = rows[0];
  const looksLabel = (s) => s !== "" && isNaN(Number(s));
  const firstLabelRatio = first.filter(looksLabel).length / first.length;
  if (rows.length === 1) return firstLabelRatio > 0.6;

  // Compare: if the body has numeric columns where the header has labels, it's a header.
  const body = rows.slice(1, 21);
  const bodyLabelRatio =
    body.reduce((acc, r) => acc + r.filter(looksLabel).length / (r.length || 1), 0) /
    body.length;
  return firstLabelRatio > 0.6 && firstLabelRatio >= bodyLabelRatio;
}

/**
 * Full structural sniff.
 * @param {string} text
 * @returns {{delimiter: string, quote: string, hasHeader: boolean, confidence: number}}
 */
function sniff(text) {
  const quote = "\"";
  const lines = physicalLines(text, quote);
  const { delimiter, confidence } = detectDelimiter(lines);
  const previewRows = lines
    .slice(0, 21)
    .map((l) => l.split(delimiter).map((c) => c.replace(/^"|"$/g, "")));
  const hasHeader = detectHeader(previewRows);
  return { delimiter, quote, hasHeader, confidence };
}

module.exports = { sniff, detectDelimiter, detectHeader, physicalLines };
