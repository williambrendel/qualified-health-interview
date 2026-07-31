"use strict";

const extractSections = require("./extractSections");
const augmentSections = require("./augmentSections");
const encodeSections  = require("./encodeSections");

/**
 * @file index.js
 * @module actions/generate/binary
 * @description Binary-side orchestrator. Composes the three binary
 * actions (extract, augment, encode) into a single `run` function
 * so endpoints and scripts can process one markdown document with
 * one call.
 *
 * ## Pipeline shape
 *
 *   markdown
 *      ↓ extractSections (sync, pushes breadcrumb + body vec Promises)
 *   sections (with vecs: Promise<Float32Array>[])
 *      ↓ augmentSections (async, optional — runs only if prompt + runLLM provided)
 *   sections (with vecs grown by question/anchor/variant vec Promises)
 *      ↓ encodeSections (async, resolves all vecs in parallel, builds Document)
 *   Buffer
 *
 * ## Parallelism notes
 *
 * Vectorize Promises are pushed EAGERLY in extract and augment stages —
 * they begin executing the moment they're created. By the time encode
 * runs `Promise.allSettled`, most are already done or close to it.
 *
 * Across a batch (`run.batch`), all files run their pipelines in
 * parallel. The shared `limit` (passed by the caller) gates LLM calls
 * across the whole batch so total in-flight count stays bounded.
 *
 * ## Error model
 *
 * Two failure surfaces:
 *
 * 1. **Fundamental failures** (e.g., extractSections threw because
 *    markdown is empty, Document.fromSpec threw because of bad spec)
 *    propagate as a wrapped Error with `{stage, documentId, cause,
 *    attempts?, errors?}`. These represent the pipeline aborting.
 *    `run` throws; `run.batch`'s `Promise.allSettled` captures it.
 *
 * 2. **Per-section soft failures** (LLM call failed for one section
 *    after retries; vectorize Promise rejected) flow through the
 *    optional `onError(err)` callback. These DON'T abort the file —
 *    the file is still built with whatever survived. The endpoint
 *    can log them for later inspection.
 *
 * The unified `onError` callback adapts each stage's specific callback:
 *   - augmentSections's `onSectionError(i, err)` → `onError({stage:"augment", sectionIndex:i, cause:err})`
 *   - encodeSections's `onSectionError(i, err)` → `onError({stage:"encode", sectionIndex:i, cause:err})`
 */

/**
 * Wrap a stage failure into a structured Error matching the project's
 * convention (same shape used by `runWithRetry`). The error has:
 *
 *   .stage      — "extract" | "augment" | "encode"
 *   .documentId — for batch context
 *   .cause      — the original error
 *   .attempts   — copied from cause if present (retry count)
 *   .errors     — copied from cause if present (retry diagnostics)
 *
 * @param {object} input
 * @param {string} input.stage
 * @param {string} input.documentId
 * @param {Error}  input.cause
 * @returns {Error}
 */
const wrapError = ({ stage, documentId, cause }) => {
  const message = cause && cause.message ? cause.message : String(cause);
  const err = new Error(
    `binary/run: failed at "${stage}" for "${documentId}": ${message}`
  );
  err.stage      = stage;
  err.documentId = documentId;
  err.cause      = cause;
  if (cause && cause.attempts) err.attempts = cause.attempts;
  if (cause && cause.errors)   err.errors   = cause.errors;
  return err;
};

/**
 * Process one markdown document end-to-end into a VECT binary buffer.
 *
 * @async
 * @param {object}   input
 * @param {string}   input.markdown          - Already-loaded markdown text.
 * @param {string}   input.documentId        - Document ID (caller computes).
 * @param {number}   input.vecDim            - Embedding dimension (caller probes).
 * @param {Function} input.vectorize         - Async vectorizer.
 * @param {Function} [input.runLLM]          - Async LLM caller. Required for
 *   augmentation; omit to build a binary with only breadcrumb + body vectors.
 * @param {string}   [input.prompt]          - Prompt for augmentation. Required
 *   when augmentation is wanted.
 * @param {object}   [input.llmConfig]       - Provider config for runLLM.
 * @param {Function} [input.limit]           - Concurrency limiter for LLM calls.
 * @param {number}   [input.maxRetries=2]    - Per-section LLM retry budget.
 * @param {Function} [input.onSection]       - Diagnostic callback fired per
 *   section in extractSections. Signature
 *   `(index, {wordCount, bucket, bodyChunks, range}) => void`.
 * @param {Function} [input.onError]         - Unified per-section soft-error
 *   callback. Signature `({stage, sectionIndex, cause}) => void`. Called for
 *   augment failures and encode vector failures.
 *
 * @returns {Promise<Buffer>} The VECT binary, ready to write.
 *
 * @throws {Error} On fundamental failure at any stage. Error has
 *   `{stage, documentId, cause, attempts?, errors?}`.
 *
 * @example
 *   const buffer = await run({
 *     markdown,
 *     documentId: "biocides|water_chemistry",
 *     vecDim: 384,
 *     vectorize,
 *     runLLM,
 *     prompt: augmentPrompt,
 *     llmConfig: SONNET45_CONFIG,
 *     limit: makeLimit(8),
 *     onSection:   (i, info) => console.log(`section ${i}:`, info),
 *     onError:     (err)     => console.warn(`soft error:`, err),
 *   });
 */
const run = async (input) => {
  const {
    markdown,
    documentId,
    vecDim,
    vectorize,
    runLLM,
    prompt,
    llmConfig,
    limit,
    maxRetries = 2,
    onSection,
    onError,
  } = input || {};

  // ── Stage 1: extractSections (sync) ─────────────────────────────────────
  //
  // Pushes breadcrumb + body vec Promises onto each section's vecs.
  // Failures here are fundamental (malformed markdown, missing vectorize)
  // and propagate as `{stage:"extract"}`.
  let sections;
  try {
    sections = extractSections(markdown, { vectorize, onSection });
  } catch (cause) {
    throw wrapError({ stage: "extract", documentId, cause });
  }

  // ── Stage 2: augmentSections (async, optional) ──────────────────────────
  //
  // Only run when both prompt AND runLLM are provided. Without augmentation
  // the binary still gets built — just with breadcrumb + body vectors.
  //
  // Per-section LLM failures flow through onError({stage:"augment", ...}).
  // Fundamental failures (missing required params, etc.) propagate as
  // `{stage:"augment"}` error.
  if (prompt && runLLM) {
    try {
      await augmentSections({
        sections, vectorize, prompt, runLLM, llmConfig, limit, maxRetries,
        onSectionError: onError
          ? (i, err) => onError({ stage: "augment", sectionIndex: i, cause: err })
          : undefined,
      });
    } catch (cause) {
      throw wrapError({ stage: "augment", documentId, cause });
    }
  }

  // ── Stage 3: encodeSections (async) ─────────────────────────────────────
  //
  // Resolves all vec Promises in parallel via Promise.allSettled, builds
  // Document, returns Buffer. Per-vector rejections flow through
  // onError({stage:"encode", ...}); fundamental failures (Document spec
  // errors, etc.) propagate.
  try {
    return await encodeSections({
      sections, documentId, vecDim,
      onSectionError: onError
        ? (i, err) => onError({ stage: "encode", sectionIndex: i, cause: err })
        : undefined,
    });
  } catch (cause) {
    throw wrapError({ stage: "encode", documentId, cause });
  }
};

/**
 * Batch processing — runs multiple inputs in parallel.
 *
 * Uses `Promise.allSettled` so per-file failures don't abort siblings.
 * The result is an array of `{status, value}` or `{status, reason}`
 * entries (one per input, in order). Callers walk the array and react
 * to fulfilled and rejected entries separately.
 *
 * @async
 * @param {Array<object>} inputs - Array of input objects matching the
 *   `run` signature.
 * @returns {Promise<Array<{status: string, value?: Buffer, reason?: Error}>>}
 *
 * @example
 *   const results = await run.batch(inputs);
 *   const successes = results.filter(r => r.status === "fulfilled");
 *   const failures  = results.filter(r => r.status === "rejected");
 *   for (const f of failures) {
 *     console.error(`file failed at stage "${f.reason.stage}":`, f.reason.message);
 *   }
 */
run.batch = async (inputs) => {
  if (!Array.isArray(inputs)) {
    throw new Error("binary/run.batch: inputs must be an array");
  }
  return Promise.allSettled(inputs.map(run));
};

// Expose wrapError for tests and adjacent code that wants to construct
// errors in the same shape.
run.wrapError = wrapError;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(run, "run", {
  value: run,
}));
