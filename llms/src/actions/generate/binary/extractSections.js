"use strict";

const segmentTextSections = require("../../../utilities/textSegmentation/segmentTextSections");

/**
 * @file extractSections.js
 * @module actions/generate/binary/extractSections
 * @description Synchronous pure function. Segments markdown into
 * sections and extracts every retrieval-ready signal from each:
 * the breadcrumb string, the full body content, and the
 * vector-ready text chunks produced by the bucket strategy.
 *
 * Output is the substrate for the rest of the binary pipeline:
 * {@link augmentSections} appends LLM-derived texts (questions,
 * anchors, variants); {@link encodeSections} vectorizes everything
 * and packs it into a VECT binary.
 *
 * ## Per-section output shape
 *
 *   {
 *     range:       [start, end],          // half-open offsets into markdown
 *     breadcrumbs: "A, B, Section Title", // joined string for LLM context
 *     content:     "Full body text...",    // the section's body, unchunked
 *     texts:       [                       // vector-ready strings, in order:
 *       "A, B, Section Title",             //   breadcrumb (if non-empty)
 *       "First chunk of body",             //   body chunks per bucket
 *       "Second chunk of body",
 *       ...
 *     ],
 *   }
 *
 * `breadcrumbs` is the string form of the joined ancestor+header chain.
 * It's stored separately from `texts` because downstream
 * {@link augmentSections} needs the breadcrumb to compose the LLM
 * user message (which combines breadcrumb + content for context),
 * while `texts` is the flat list of strings to be vectorized.
 *
 * `content` is the unchunked body, separate from the chunked entries
 * in `texts`. The LLM needs the coherent full content to generate
 * meaningful questions/anchors/variants — the chunked pieces are
 * for retrieval, not for prompting.
 *
 * ## Bucket strategy
 *
 * Body chunking depends on word count:
 *   - short  (<150 words): emit the full content as one chunk
 *   - long   (>400 words): emit each sentence as its own chunk
 *   - medium (else):        group sentences targeting GROUP_TARGET words
 *
 * Constants are inline because they're heuristic knobs used here
 * and nowhere else. If retrieval quality demands tuning, change
 * them in this file.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Bucket strategy constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Below this word count, the whole section is one vector.
 * Tuned for 384-dim sentence encoders — chunks below ~50-200 words
 * are most discriminative.
 *
 * @type {number}
 */
const SHORT_THRESHOLD = 150;

/**
 * Above this word count, each sentence becomes its own vector.
 * The content as a whole is too compressed by the encoder for
 * specific facts to surface reliably from one embedding.
 *
 * @type {number}
 */
const LONG_THRESHOLD = 400;

/**
 * For medium-bucket sections, target this many words per grouped-
 * sentence chunk. Sentences accumulate into a group until the next
 * one would exceed this target.
 *
 * @type {number}
 */
const GROUP_TARGET = 80;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count whitespace-separated tokens in a string. Used by the
 * bucket strategy and the medium-bucket grouping.
 *
 * @param {string} str
 * @returns {number}
 */
const wordCount = (str) => (str.match(/\S+/g) || []).length;

/**
 * Decide which bucket a section falls into.
 *
 * @param {number} words
 * @returns {"short"|"medium"|"long"}
 */
const bucketFor = (words) =>
    words < SHORT_THRESHOLD ? "short"
  : words > LONG_THRESHOLD  ? "long"
  : "medium";

/**
 * Produce the body text chunks for a section according to the bucket.
 *
 *   - short:  [content] (one chunk)
 *   - long:   [sentence1, sentence2, ...] (one per non-empty sentence)
 *   - medium: [group1, group2, ...] (grouped sentences targeting GROUP_TARGET)
 *
 * Empty-word sentences are filtered out before chunking (in all buckets).
 *
 * @param {string}   content         - Full body text
 * @param {string[]} sentences       - Pre-extracted sentence strings
 * @param {"short"|"medium"|"long"} bucket
 * @returns {string[]}
 */
const chunkBody = (content, sentences, bucket) => {
  if (bucket === "short") {
    return content ? [content] : [];
  }

  if (bucket === "long") {
    const out = [];
    for (const text of sentences) {
      if (wordCount(text) > 0) out.push(text);
    }
    return out;
  }

  // Medium: accumulate sentences into groups targeting GROUP_TARGET words.
  const out = [];
  let current = [];
  let currentWords = 0;
  for (const text of sentences) {
    const w = wordCount(text);
    if (w === 0) continue;
    if (currentWords > 0 && currentWords + w > GROUP_TARGET) {
      out.push(current.join(". "));
      current = [];
      currentWords = 0;
    }
    current.push(text);
    currentWords += w;
  }
  if (current.length) out.push(current.join(". "));
  return out;
};

/**
 * Build the breadcrumb string for a chunk returned by
 * `Section.contentSections()`. Follows the documented usage pattern
 * (see `Section.js` "Breadcrumb semantics"): `ancestors` lists header
 * ancestors NOT including the chunk's own header; `chunk.header`
 * returns the chunk's own header OR the inherited header for
 * headerless paragraph chunks.
 *
 * @param {Section} chunk      - From `contentSections()`.
 * @param {string}  markdown   - Source text (for `extractTitle`).
 * @returns {string} Joined breadcrumb, or `""` when nothing applies.
 */
const extractBreadcrumb = (chunk, markdown) => {
  const ancestors = (chunk.ancestors || []).map(h => h.extractTitle(markdown));
  const ownTitle  = chunk.header ? chunk.header.extractTitle(markdown) : "";
  return [...ancestors, ownTitle].filter(Boolean).join(", ");
};

/**
 * Extract the body sentences (non-header segments) of a chunk as
 * plain strings, plus the body's byte range. Follows the documented
 * filtering pattern from `Section.js`:
 *
 *   section.content.filter(x => typeof x[0] === "number")
 *
 * which keeps body Segments and drops nested Sections (whose first
 * element is itself a Segment-or-Section, not a number).
 *
 * `chunk.content` is the array of elements AFTER the chunk's own
 * Header (or all elements when there is no own header). Its
 * `.start` / `.end` getters give the body's byte range — narrower
 * than the chunk's full range when a header is present.
 *
 * @param {Section} chunk
 * @param {string}  markdown
 * @returns {{ content: string, range: [number, number], sentenceTexts: string[] }}
 */
const extractBody = (chunk, markdown) => {
  const view = chunk.content;
  const segments = view.filter(x => typeof x[0] === "number");

  // Range: use the body's own span. Fall back to chunk's own range
  // when the body view has nothing (defensive — shouldn't happen
  // because contentSections() excludes empty-body chunks).
  const start = view.start ?? chunk.start ?? 0;
  const end   = view.end   ?? chunk.end   ?? 0;
  const range = [start, end];

  // Body text: the slice of the markdown from body start to body end.
  // This excludes any header byte range that sits before view.start.
  const content = markdown.slice(start, end);

  // Sentence texts: each body Segment as a string.
  const sentenceTexts = segments.map(s => s.extract(markdown));

  return { content, range, sentenceTexts };
};

// ─────────────────────────────────────────────────────────────────────────────
// Main: extractSections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract retrieval signals from a markdown document. Synchronous;
 * pushes `vectorize(text)` Promises onto each section's `vecs`
 * array eagerly — these Promises are awaited later by
 * {@link encodeSections} in one big `Promise.allSettled` for
 * maximum parallelism.
 *
 * The texts that get vectorized:
 *   - Breadcrumb string (if non-empty)
 *   - Body chunks per the bucket strategy
 *
 * No async work happens here — `vectorize` returns a Promise
 * which we push without awaiting. The function itself stays sync.
 *
 * @param {string}    markdown   - Source text (typically polished
 *   output from {@link generateMarkdown}).
 * @param {object}    options
 * @param {Function}  options.vectorize - Required. Async function
 *   `(text: string) => Promise<Float32Array>`. Called once per
 *   text; the Promise is pushed onto `section.vecs` without
 *   awaiting.
 * @param {Function}  [options.onSection] - Optional callback
 *   invoked per section with diagnostic info. Signature:
 *   `(index, {wordCount, bucket, bodyChunks, range}) => void`.
 *   Useful for build-time logging without coupling this module
 *   to a logger.
 *
 * @returns {Array<{
 *   range:       [number, number],
 *   breadcrumbs: string,
 *   content:     string,
 *   vecs:        Promise<Float32Array>[],
 * }>}
 *   One entry per content section. `vecs[0]` is the breadcrumb
 *   vector Promise when breadcrumbs is non-empty; subsequent
 *   entries are body chunk vector Promises in order.
 *
 *   `breadcrumbs` and `content` are kept as plain strings — they
 *   are needed by {@link augmentSections} for composing the LLM
 *   user message.
 *
 * @throws {Error} When `markdown` is missing/empty, when
 *   `vectorize` isn't a function, or when `segmentTextSections`
 *   can't parse the input.
 *
 * @example
 *   const sections = extractSections(generatedMarkdown, { vectorize });
 *   // sections[0] = {
 *   //   range: [0, 350],
 *   //   breadcrumbs: "Biofilm Control",
 *   //   content: "The biofilm matrix...",
 *   //   vecs: [Promise<Float32Array>, Promise<Float32Array>, ...]
 *   // }
 */
const extractSections = (markdown, { vectorize, onSection } = {}) => {
  if (typeof markdown !== "string" || markdown.length === 0) {
    throw new Error("extractSections: markdown must be a non-empty string");
  }
  if (typeof vectorize !== "function") {
    throw new Error("extractSections: vectorize must be a function");
  }

  const chunks = segmentTextSections(markdown).contentSections();

  const output = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    const breadcrumbs = extractBreadcrumb(chunk, markdown);
    const { content, range, sentenceTexts } = extractBody(chunk, markdown);

    const words = wordCount(content);
    const bucket = bucketFor(words);
    const bodyChunks = chunkBody(content, sentenceTexts, bucket);

    // Push vectorize Promises eagerly. Order: breadcrumb (if any),
    // then body chunks. Same order as the strings would have been
    // in `texts` in the previous design — preserves vector ordering.
    const vecs = [];
    if (breadcrumbs) vecs.push(vectorize(breadcrumbs));
    for (const ch of bodyChunks) vecs.push(vectorize(ch));

    onSection && onSection(i, {
      wordCount:  words,
      bucket,
      bodyChunks: bodyChunks.length,
      range,
    });

    output.push({ range, breadcrumbs, content, vecs });
  }

  return output;
};

// ─────────────────────────────────────────────────────────────────────────────
// Exposed helpers + constants (tests + visibility into the heuristic)
// ─────────────────────────────────────────────────────────────────────────────

extractSections.SHORT_THRESHOLD     = SHORT_THRESHOLD;
extractSections.LONG_THRESHOLD      = LONG_THRESHOLD;
extractSections.GROUP_TARGET        = GROUP_TARGET;
extractSections.wordCount           = wordCount;
extractSections.bucketFor           = bucketFor;
extractSections.chunkBody           = chunkBody;
extractSections.extractBreadcrumb   = extractBreadcrumb;
extractSections.extractBody         = extractBody;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(extractSections, "extractSections", {
  value: extractSections,
}));