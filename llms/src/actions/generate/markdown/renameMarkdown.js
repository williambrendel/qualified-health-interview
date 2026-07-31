"use strict";

/**
 * @file renameMarkdown.js
 * @module actions/generate/markdown/renameMarkdown
 * @description Pure function: produces a clean, snake_case filename
 * for a generated markdown document by extracting its H1 title.
 *
 * The upstream {@link generateMarkdown} action is responsible for
 * producing a polished markdown document with a meaningful H1 (its
 * prompt mandates this structure). This function reads that H1 and
 * derives a filename from it — no LLM call, fully deterministic.
 *
 * ## Why H1 as the source
 *
 * The H1 is the document's authoritative title — what the LLM
 * decided this content is ABOUT. The original filename (from a
 * user-uploaded docx) is often noisy: it may have timestamps,
 * version suffixes, series prefixes ("DC Water Facts 75 of 100"),
 * or vendor metadata. By the time the document has been generated,
 * those concerns are gone — the H1 captures the meaning.
 *
 * If the markdown has no H1, that's an upstream bug. We throw
 * rather than silently fall back to messy filename rules; the
 * caller should fix the generator output instead.
 *
 * ## Transformations applied
 *
 *   1. Extract the first H1 line (matches `^# `).
 *   2. Strip markdown emphasis markers (`*`, `_`, backticks).
 *   3. Lowercase.
 *   4. Replace any non-word character with underscore.
 *   5. Collapse runs of underscores into one.
 *   6. Trim leading/trailing underscores.
 *   7. Truncate to {@link MAX_STEM_LENGTH} chars at a word boundary.
 *   8. Append `.md` extension.
 *
 * ## What this does NOT do
 *
 *   - Doesn't check for filename collisions with existing files
 *     (the caller's filesystem logic handles that).
 *   - Doesn't preserve special characters (em-dashes, accented
 *     letters); they're normalized to underscores.
 *   - Doesn't include theme prefix; that's the caller's directory
 *     placement concern.
 */

/**
 * Maximum stem length before truncation. 80 chars is roughly the
 * length most filesystems handle gracefully in directory listings,
 * with room for a `.md` extension and a theme-prefixed directory.
 * The truncation happens at a word boundary so the result reads
 * naturally even when cut short.
 *
 * @type {number}
 */
const MAX_STEM_LENGTH = 80;

/**
 * Regex for the first H1 line in a markdown document. Matches
 * `^# ` at the start of any line (multiline mode), captures
 * everything until end-of-line. Does not match `##`, `###`, etc.
 * because the `[^#]` constraint after the single `#` would require
 * a non-# character at position 2 — which fails for `##`.
 *
 * Actually using lookbehind would be cleaner; this regex uses a
 * character class instead for broader Node version compat.
 *
 * @type {RegExp}
 */
const H1_REGEX = /^#\s+(.+?)\s*$/m;

/**
 * Snake_case a string: lowercase, replace non-word chars with `_`,
 * collapse repeated `_`, trim edges.
 *
 * Punctuation, whitespace, and accented characters all map to `_`.
 * Numbers are preserved. The output is safe for filesystem use
 * across macOS, Linux, and Windows.
 *
 * @param {string} input
 * @returns {string}
 */
const toSnakeCase = (input) => {
  return input
    .toLowerCase()
    .replace(/[^\w]+/g, "_")     // non-word chars → underscore
    .replace(/_+/g, "_")          // collapse runs
    .replace(/^_+|_+$/g, "");     // trim edges
};

/**
 * Truncate a snake_case stem at a word boundary, keeping it under
 * {@link MAX_STEM_LENGTH} chars. If the input is already short
 * enough, return as-is. Otherwise, cut at the last `_` before the
 * limit; if no such boundary exists, hard-truncate at the limit.
 *
 * @param {string} stem - Already-snake_cased input.
 * @returns {string}
 */
const truncateAtWord = (stem) => {
  if (stem.length <= MAX_STEM_LENGTH) return stem;
  const cut = stem.lastIndexOf("_", MAX_STEM_LENGTH);
  if (cut > 0) return stem.slice(0, cut);
  return stem.slice(0, MAX_STEM_LENGTH);
};

/**
 * Strip markdown formatting markers from a heading. Headings often
 * include emphasis (`**bold**`, `*italic*`, `` `code` ``) that
 * shouldn't end up in filenames.
 *
 * @param {string} heading
 * @returns {string}
 */
const stripMarkdownFormatting = (heading) => {
  return heading
    .replace(/[`*_~]+/g, "")      // emphasis markers
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1")  // escaped chars
    .trim();
};

/**
 * Produce a clean filename for a generated markdown document.
 *
 * Reads the H1 from the document body, snake_cases it, applies
 * length cap, and appends `.md`. Throws when no H1 is found —
 * the upstream generator is responsible for ensuring one exists.
 *
 * @param {object} options
 * @param {string} options.markdown - The generated markdown content.
 * @returns {string} A filename with `.md` extension, e.g.
 *   `"how_much_extra_pump_pressure_do_ai_data_centers_need.md"`.
 * @throws {Error} If `markdown` is missing, not a string, has no
 *   H1, or the H1 produces an empty stem after normalization.
 *
 * @example
 *   renameMarkdown({
 *     markdown: "# How Much Extra Pump Pressure Do AI Data Centers Need?\n\n## Executive Summary\n..."
 *   });
 *   // → "how_much_extra_pump_pressure_do_ai_data_centers_need.md"
 */
const renameMarkdown = ({ markdown } = {}) => {
  if (typeof markdown !== "string" || markdown.length === 0) {
    throw new Error("renameMarkdown: markdown must be a non-empty string");
  }

  const match = markdown.match(H1_REGEX);
  if (!match) {
    throw new Error(
      "renameMarkdown: no H1 heading found in the markdown. " +
      "The upstream generator is expected to produce a document " +
      "starting with `# Title`. Check the generator's prompt or output."
    );
  }

  const rawTitle = stripMarkdownFormatting(match[1]);
  if (!rawTitle) {
    throw new Error("renameMarkdown: H1 heading is empty after stripping formatting");
  }

  const stem = truncateAtWord(toSnakeCase(rawTitle));
  if (!stem) {
    throw new Error(
      `renameMarkdown: H1 heading "${match[1]}" produced an empty stem ` +
      `after normalization (likely contained only special characters)`
    );
  }

  return `${stem}.md`;
};

// Helper exports for tests and adjacent code.
renameMarkdown.MAX_STEM_LENGTH       = MAX_STEM_LENGTH;
renameMarkdown.H1_REGEX              = H1_REGEX;
renameMarkdown.toSnakeCase           = toSnakeCase;
renameMarkdown.truncateAtWord        = truncateAtWord;
renameMarkdown.stripMarkdownFormatting = stripMarkdownFormatting;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(renameMarkdown, "renameMarkdown", {
  value: renameMarkdown,
}));
