"use strict";

const runWithRetry = require("../../../utilities/runWithRetry");

/**
 * @file augmentSections.js
 * @module actions/generate/binary/augmentSections
 * @description LLM augmentation step of the binary pipeline. Takes
 * sections produced by {@link extractSections} and, for each one,
 * calls the LLM to generate retrieval-row data (questions, anchors,
 * and variants). The resulting strings are appended to each
 * section's `texts` array so they get vectorized alongside the
 * breadcrumb and body chunks.
 *
 * ## Why this exists
 *
 * Body and breadcrumb vectors alone don't capture all the ways a
 * user might phrase a query. A user searching "green slime in my
 * tower" wouldn't match a section titled "Photosynthetic Organisms"
 * via body vectors alone — the words don't overlap. The LLM
 * generates likely user phrasings AT BUILD TIME, expanding each
 * section's retrieval surface without any runtime LLM cost.
 *
 * ## Input/output contract
 *
 * Mutates sections in place. Each section's `texts` array grows:
 *
 *   Before:
 *     texts: [breadcrumb, body-chunk-1, body-chunk-2, ...]
 *
 *   After:
 *     texts: [
 *       breadcrumb, body-chunk-1, body-chunk-2, ...,
 *       question1, anchor1a, anchor1b, ..., variant1a, variant1b, ...,
 *       question2, anchor2a, ..., variant2a, ...,
 *       ...
 *     ]
 *
 * The original section objects are returned at the end. Callers can
 * chain or just use the same reference.
 *
 * ## Failure model
 *
 * Per-section LLM failures are tolerated. When a section's LLM call
 * fails after all retries (bad JSON, validation failure, transport
 * exhaustion), the `onSectionError` callback fires and that section
 * keeps its original texts (breadcrumb + body chunks). Other
 * sections continue processing — one bad section doesn't kill the
 * whole file.
 *
 * Fundamental failures (missing prompt, missing runLLM, etc.) throw
 * synchronously before any LLM calls are issued. The orchestrator
 * wraps these with `stage: "augment"` context.
 *
 * ## Concurrency
 *
 * LLM calls are gated by the injected `limit` function — typically
 * a `makeLimit(N)` instance shared across files in a batch build.
 * Each per-section call passes through `limit` so the total
 * in-flight count stays bounded regardless of how many sections
 * fan out across how many files.
 *
 * ## Retry per section
 *
 * Each section's LLM call goes through {@link runWithRetry} with the
 * caller-supplied `maxRetries` budget. The validator parses the
 * response as JSON and checks for the expected array shape. On
 * validator failure or transport error, retry up to `maxRetries`
 * additional times.
 */

/**
 * Unwrap an LLM response to its plain text body.
 *
 * Accepts either:
 *   - a Response envelope from `src/claude/run.js` with `.output.text`
 *   - a plain string (some providers/wrappers return strings directly)
 *
 * Returns the text body in both cases. Anything else falls through
 * untouched so the validator can reject it as "not a usable response."
 *
 * @param {*} raw
 * @returns {string|*}
 */
const unwrapText = (raw) => {
  if (raw && raw.output && typeof raw.output.text === "string") {
    return raw.output.text;
  }
  return raw;
};

/**
 * Strip JSON code-fence wrapping that some LLMs add despite
 * instructions. Matches `parseJsonSafely` in `classifyMarkdown`.
 *
 * @param {string} raw
 * @returns {string}
 */
const stripJsonFences = (raw) => {
  if (typeof raw !== "string") return raw;
  return raw
    .replace(/^\s*```(?:json|JSON)?\s*\n/, "")
    .replace(/\n?\s*```\s*$/, "")
    .trim();
};

/**
 * Try to parse a Response envelope OR raw string as a JSON array of
 * rows. Returns `null` on any failure (not a string, parse error,
 * non-array result). The validator uses null as the trigger for retry.
 *
 * @param {*} raw - LLM response (Response object or string).
 * @returns {Array|null} Parsed rows, or null.
 */
const parseRowsSafely = (raw) => {
  const text = unwrapText(raw);
  if (typeof text !== "string") return null;
  const cleaned = stripJsonFences(text);
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Validator for a single section's LLM response. Confirms the
 * response is a JSON array. Per-row shape validation (question
 * string, anchors/variants arrays) happens during extraction, not
 * here — a malformed row gets skipped, while a malformed RESPONSE
 * triggers retry.
 *
 * @param {*} raw
 * @returns {{valid: boolean, errors?: string[]}}
 */
const validateRowsResponse = (raw) => {
  const parsed = parseRowsSafely(raw);
  if (parsed === null) {
    return { valid: false, errors: ["response is not a valid JSON array"] };
  }
  return { valid: true };
};

/**
 * Extract the vectorize-ready strings from a parsed rows array.
 * Per row: the question (one string), then anchors (array), then
 * variants (array). Rows missing a question are skipped.
 *
 * The string order matters for predictability: question first,
 * then anchors in source order, then variants in source order.
 * This ordering is preserved when texts get vectorized.
 *
 * @param {Array} rows
 * @returns {string[]} Flat list of strings to append to section.texts.
 */
const extractRowTexts = (rows) => {
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row || typeof row.question !== "string" || !row.question) continue;
    out.push(row.question);
    if (Array.isArray(row.anchors)) {
      for (const a of row.anchors) {
        if (typeof a === "string" && a) out.push(a);
      }
    }
    if (Array.isArray(row.variants)) {
      for (const v of row.variants) {
        if (typeof v === "string" && v) out.push(v);
      }
    }
  }
  return out;
};

/**
 * Compose the LLM user message for a section. Combines the
 * breadcrumb chain and the section's full body content. Matches
 * the format used by the original `generateKnowledgeBase` so the
 * prompt's expected input shape doesn't change.
 *
 * @param {object} section - From `extractSections`.
 * @returns {string}
 */
const formatUserMessage = (section) => {
  const breadcrumbs = section.breadcrumbs || "";
  // Old code joined breadcrumbs with " > " in the user message
  // even though it uses ", " in the breadcrumb vector. Keep both
  // — different consumers, different formats.
  const breadcrumbLine = breadcrumbs ? breadcrumbs.replace(/, /g, " > ") : "";
  const header = breadcrumbLine
    ? `section header breadcrumbs: ${breadcrumbLine}\n\nsection content:\n`
    : "";
  return `${header}${section.content || ""}`;
};

/**
 * Default no-op limiter for when callers don't provide one.
 * Matches the `makeLimit` shape: takes a thunk, awaits it,
 * returns its result.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
const noopLimit = (fn) => fn();

/**
 * Augment sections with LLM-generated question/anchor/variant
 * vectors. Mutates each section's `vecs` array by pushing
 * `vectorize(text)` Promises (NOT awaiting them — they get
 * resolved later in {@link encodeSections}).
 *
 * @async
 * @param {object} options
 * @param {Array}    options.sections          - Sections from `extractSections`.
 *   Each section must already have a `vecs: Promise<Float32Array>[]`
 *   array (extractSections populates this with breadcrumb + body chunks).
 * @param {Function} options.vectorize         - Async function
 *   `(text: string) => Promise<Float32Array>`. Called once per
 *   LLM-generated string; the Promise is pushed onto section.vecs
 *   without awaiting.
 * @param {string}   options.prompt            - System prompt content
 *   (loaded from `prompts/augment-section.ppl`).
 * @param {Function} options.runLLM            - Async LLM caller.
 *   Signature `(config, prompt) => Promise<*>`. Matches
 *   `src/claude/run.js`. May return a Response envelope or a plain
 *   string — the parser handles both. The system prompt is merged
 *   into `config.system` by this action before calling runLLM.
 * @param {object}   options.llmConfig         - Provider config.
 * @param {Function} [options.limit=noopLimit] - Concurrency limiter
 *   from `makeLimit`. Each LLM call passes through `limit` so total
 *   in-flight LLM calls stay bounded across a batch.
 * @param {number}   [options.maxRetries=2]    - Per-section retry budget.
 * @param {Function} [options.onSectionError]  - Called when a section's
 *   LLM call fails after all retries. Signature `(index, err) => void`.
 *   The section keeps the vecs it already had (breadcrumb + body) but
 *   gets no LLM augmentation.
 *
 * @returns {Promise<Array>} The same sections array, mutated in place.
 *
 * @throws {Error} On fundamental setup failures (missing required
 *   params). Per-section LLM failures are tolerated.
 *
 * @example
 *   const sections = extractSections(markdown, { vectorize });
 *   await augmentSections({
 *     sections, vectorize, prompt, runLLM, llmConfig,
 *     limit: makeLimit(8),
 *     onSectionError: (i, err) => console.error(`section ${i}:`, err.message),
 *   });
 *   // sections[i].vecs now includes LLM-derived vector Promises.
 */
const augmentSections = async ({
  sections,
  vectorize,
  prompt,
  runLLM,
  llmConfig,
  limit = noopLimit,
  maxRetries = 2,
  onSectionError,
} = {}) => {
  // ── Input validation (fundamental failures throw) ────────────────────────
  if (!Array.isArray(sections)) {
    throw new Error("augmentSections: sections must be an array");
  }
  if (typeof vectorize !== "function") {
    throw new Error("augmentSections: vectorize must be a function");
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("augmentSections: prompt must be a non-empty string");
  }
  if (typeof runLLM !== "function") {
    throw new Error("augmentSections: runLLM must be a function");
  }
  if (typeof limit !== "function") {
    throw new Error("augmentSections: limit must be a function");
  }

  // ── Fan out: one LLM call per section, gated by `limit` ──────────────────
  //
  // Each promise wraps the LLM call in runWithRetry to handle content-level
  // retry, and runs through `limit` to bound concurrency. The whole batch
  // runs in parallel (subject to the limit). Per-section failures are
  // caught here and translated into result entries so a single bad section
  // doesn't abort the file.
  //
  // The system prompt is merged into the config (Anthropic-standard
  // `system` field). claude/run.js takes `(config, prompt)` where
  // `prompt` is the user message, so runWithRetry passes the user
  // message in as `prompt` after we've baked the system prompt into
  // config.
  const callConfig = { ...llmConfig, system: prompt };

  const promises = sections.map((section, i) => {
    const userMessage = formatUserMessage(section);

    return limit(() => runWithRetry({
      runLLM,
      config:   callConfig,
      prompt:   userMessage,
      validate: validateRowsResponse,
      maxRetries,
    }))
      .then((raw) => ({ status: "fulfilled", index: i, raw }))
      .catch((err) => ({ status: "rejected",  index: i, err }));
  });

  const results = await Promise.all(promises);

  // ── Push vectorize Promises per section ──────────────────────────────────
  //
  // For each successful LLM response: parse rows, extract texts, push a
  // `vectorize(text)` Promise per string onto section.vecs. We do NOT
  // await the vectorize Promises here — they get resolved in encodeSections
  // alongside the breadcrumb and body vectors in a single Promise.allSettled
  // for maximum parallelism.
  //
  // For each failure: fire callback (if provided) and leave the section's
  // vecs unchanged (it keeps its breadcrumb + body vectors).
  for (const result of results) {
    const { index } = result;
    if (result.status === "rejected") {
      onSectionError && onSectionError(index, result.err);
      continue;
    }

    const rows = parseRowsSafely(result.raw);
    if (!rows) {
      onSectionError && onSectionError(index, new Error("validated response failed to re-parse"));
      continue;
    }

    const newTexts = extractRowTexts(rows);
    for (const text of newTexts) {
      sections[index].vecs.push(vectorize(text));
    }
  }

  return sections;
};

// Helper exports for tests.
augmentSections.unwrapText           = unwrapText;
augmentSections.stripJsonFences      = stripJsonFences;
augmentSections.parseRowsSafely      = parseRowsSafely;
augmentSections.validateRowsResponse = validateRowsResponse;
augmentSections.extractRowTexts      = extractRowTexts;
augmentSections.formatUserMessage    = formatUserMessage;
augmentSections.noopLimit            = noopLimit;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(augmentSections, "augmentSections", {
  value: augmentSections,
}));