"use strict";

const pipeline = require("./pipeline");
const CONFIG = require("./config");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Matches any character that is not a word character (`\w`), whitespace
 * (`\s`), or a hyphen. Used to strip punctuation from text before embedding
 * while preserving hyphenated compound terms (e.g. `"Legionella-prevention"`,
 * `"bio-film"`) that carry semantic meaning as a unit.
 *
 * Punctuation is replaced with a space rather than deleted outright to prevent
 * adjacent words from merging (e.g. `"treatment.Plan"` → `"treatment Plan"`
 * rather than `"treatmentPlan"`).
 *
 * @type {RegExp}
 * @example
 * "What is water treatment?".replace(RE_PUNCTUATION, " ")
 * // => "What is water treatment "
 */
const RE_PUNCTUATION = /[^\w\s-]/g;

/**
 * Matches one or more consecutive whitespace characters. Applied after
 * {@link RE_PUNCTUATION} substitution to collapse any resulting multi-space
 * runs back to a single space before trimming.
 *
 * @type {RegExp}
 * @example
 * "water  treatment  definition".replace(RE_WHITESPACE, " ")
 * // => "water treatment definition"
 */
const RE_WHITESPACE = /\s+/g;

// ---------------------------------------------------------------------------
// defaultTextNormalization
// ---------------------------------------------------------------------------

/**
 * Default text normalization applied to input strings before embedding.
 *
 * Strips punctuation (except hyphens) via {@link RE_PUNCTUATION}, collapses
 * whitespace runs via {@link RE_WHITESPACE}, and trims leading and trailing
 * whitespace. Casing is intentionally left unchanged — the underlying model
 * (`all-MiniLM-L12-v2`) lowercases internally during tokenization, so manual
 * lowercasing here would be redundant. If the model is ever replaced with a
 * cased variant, this assumption must be revisited.
 *
 * Applied symmetrically at both dataset vectorization time and query time to
 * ensure the embedding space is consistent — punctuation differences between
 * stored vectors and incoming queries never cause asymmetric drift.
 *
 * Exposed as {@link vectorize.defaultTextNormalization} so callers that
 * pre-process text outside of `vectorize` can apply identical normalization
 * and maintain a symmetric embedding space.
 *
 * Can be overridden per-call by passing a custom function as
 * `options.normalizeText`.
 *
 * @function defaultTextNormalization
 * @param {string} text - Raw input string to normalize.
 * @returns {string} Normalized string with punctuation stripped, whitespace
 *   collapsed, and leading/trailing whitespace removed.
 *
 * @example
 * defaultTextNormalization("What is water treatment?")
 * // => "What is water treatment"
 *
 * @example <caption>Hyphens are preserved</caption>
 * defaultTextNormalization("Legionella-prevention — best practices.")
 * // => "Legionella-prevention best practices"
 */
const defaultTextNormalization = text => text
  .replace(RE_PUNCTUATION, " ")  // strip punctuation except hyphens
  .replace(RE_WHITESPACE,  " ")  // collapse whitespace runs to a single space
  .trim()                        // remove leading and trailing whitespace

// ---------------------------------------------------------------------------
// vectorize
// ---------------------------------------------------------------------------

/**
 * @file vectorize.js
 * @module core/llms/xenova/vectorize
 * @description Generates dense vector embeddings from text using a locally
 * running Transformer model via `@xenova/transformers` and ONNX Runtime.
 *
 * This module is the single entry point for all text-to-vector operations in
 * the pipeline — used at dataset build time (in `vectorize.js`) and at query
 * time (in the `/query` endpoint). Both paths pass through
 * {@link defaultTextNormalization} by default, ensuring the embedding space
 * is symmetric.
 *
 * A module-level singleton (`model`) caches the extractor pipeline after the
 * first initialization. Callers that build the dataset in batch should pass a
 * pre-initialized extractor via `options.extractor` to avoid re-loading the
 * model on each call.
 *
 * Loads the transformers.js pipeline via the {@link pipeline} CJS-to-ESM
 * bridge — `@xenova/transformers` is ESM-only and cannot be `require()`'d
 * directly. The bridge is transparent to callers.
 *
 * @see {@link https://huggingface.co/docs/transformers.js|Transformers.js Documentation}
 * @see {@link pipeline} for the dynamic-import wrapper.
 */

/**
 * Generates a dense vector embedding from a text string or array of strings.
 *
 * Maps discrete text tokens into a continuous vector space where semantically
 * similar concepts are mathematically closer to one another. Runs locally via
 * ONNX Runtime, ensuring data privacy and eliminating external API latency.
 *
 * **Text normalization:** by default, punctuation is stripped and whitespace
 * is normalized via {@link defaultTextNormalization} before the text reaches
 * the tokenizer. This can be disabled (`normalizeText: false`) or replaced
 * with a custom function (`normalizeText: myFn`) per call.
 *
 * **Vector normalization:** the output vector is L2-normalized by default
 * (`normalizeVector: true`), which is required for dot product to equal
 * cosine similarity. Disable only if you need raw un-normalized embeddings.
 *
 * The resulting `Float32Array` is suitable for:
 * - **Semantic search** — finding relevant documents by meaning rather than
 *   keywords.
 * - **Clustering** — grouping semantically similar items.
 * - **Classification** — providing dense features for downstream classifiers.
 *
 * @async
 * @function vectorize
 * @param {string|string[]} text
 *   Input string or array of strings to embed. Coerced to `""` if falsy.
 * @param {object}             [options={}]
 *   Configuration for the feature extraction process.
 * @param {string}             [options.pooling="mean"]
 *   Token aggregation strategy. `"mean"` averages all token embeddings into
 *   one sentence vector; `"cls"` uses the first (classification) token.
 * @param {boolean}            [options.normalizeVector=true]
 *   Whether to L2-normalize the output vector. Required when using dot
 *   product as a proxy for cosine similarity.
 * @param {boolean|Function}   [options.normalizeText=true]
 *   Text pre-processing applied before tokenization. `true` uses
 *   {@link defaultTextNormalization}. Pass a custom `function(string):string`
 *   to override. `false` disables normalization entirely.
 * @param {Function}           [options.extractor]
 *   Pre-initialized `@xenova/transformers` pipeline instance. Providing this
 *   avoids reloading the model on every call — recommended for batch
 *   processing. If omitted, the module-level singleton is used or created.
 * @param {string}             [options.featureExtractionModel=CONFIG.featureExtractionModel]
 *   Model ID used to initialize the pipeline if no extractor is provided
 *   (e.g. `"Xenova/all-MiniLM-L12-v2"`).
 * @param {Object}             [options.other]
 *   Additional parameters passed directly to the underlying
 *   Transformers.js pipeline call.
 * @returns {Promise<Float32Array>}
 *   Resolves to a typed array of floats representing the text embedding.
 *   Length depends on the model (384 for MiniLM, 768 for BERT-base).
 *
 * @throws {Error} If the extractor pipeline fails to initialize.
 * @throws {Error} If the model cannot process the input text.
 *
 * @example <caption>Basic usage</caption>
 * const vector = await vectorize("What is water treatment?");
 * // => Float32Array [ 0.012, -0.045, ... ]  (384 dimensions)
 *
 * @example <caption>Pre-initialized extractor for batch processing</caption>
 * const extractor = await createExtractor();
 * for (const text of texts) {
 *   const vec = await vectorize(text, { extractor });
 * }
 *
 * @example <caption>Custom text normalization</caption>
 * const vec = await vectorize("What is pH?", {
 *   normalizeText: (t) => t.toLowerCase().trim(),
 * });
 *
 * @example <caption>Disable normalization for raw embeddings</caption>
 * const rawVec = await vectorize("Quantum computing", {
 *   normalizeVector: false,
 *   normalizeText:   false,
 *   featureExtractionModel: "Xenova/bert-base-uncased",
 * });
 *
 * @see {@link defaultTextNormalization} for the default text pre-processing applied.
 * @see {@link createExtractor} for pre-initializing the pipeline.
 */
// ── Singleton storage ──────────────────────────────────────────────────────
// We memoize the *promise* (not the resolved pipeline) so that concurrent
// first-callers all share the same in-flight load rather than each kicking
// off their own. The first caller assigns; later callers await the same
// promise. Idempotent: once set, the singleton is reused forever.
let modelPromise;

/**
 * @function ensureExtractor
 * @description
 * Internal helper. Returns the resolved extractor pipeline, loading it
 * lazily on first call and reusing the cached promise thereafter. All
 * code paths that need a model go through this — the public function,
 * the public `prewarm`, and any future variants — so the singleton
 * semantics live in exactly one place.
 *
 * Safe against concurrent calls: the promise is assigned synchronously
 * before any await, so simultaneous callers see the same in-flight
 * promise and the model loads exactly once.
 *
 * @param {string} [featureExtractionModel] Model ID override.
 * @returns {Promise<Function>} Resolved Transformers.js pipeline.
 */
const ensureExtractor = (featureExtractionModel) => (
  modelPromise || (modelPromise = createExtractor(featureExtractionModel))
);

const vectorize = async (
  text,
  {
    pooling          = "mean",
    normalizeVector  = true,
    normalize        = normalizeVector,
    normalizeText    = true,
    extractor,
    featureExtractionModel,
    ...other
  } = {}
) => {
  // ── Initialize extractor ──────────────────────────────────────────────────
  // Use a caller-provided extractor if one was passed (test seam or
  // pre-warmed instance), otherwise fall through to the module singleton.

  extractor || (extractor = await ensureExtractor(featureExtractionModel));

  // ── Text normalization ────────────────────────────────────────────────────
  // Coerce falsy input to empty string, then apply normalization.
  // If normalizeText is a function, use it directly; otherwise fall back to
  // defaultTextNormalization. Pass normalizeText: false to skip entirely.

  text || (text = "");
  normalizeText && (
    typeof normalizeText === "function" || (normalizeText = defaultTextNormalization),
    text = normalizeText(text)
  );

  // ── Feature extraction ────────────────────────────────────────────────────

  const result = await extractor(text, { pooling, normalize, ...other });

  // ── Output ────────────────────────────────────────────────────────────────
  // Wrap result data in a Float32Array for consistent typed output regardless
  // of what the underlying pipeline returns.

  return new Float32Array(result.data);
};

// ---------------------------------------------------------------------------
// vectorize.prewarm
// ---------------------------------------------------------------------------

/**
 * @function vectorize.prewarm
 * @async
 * @description
 * Eagerly populate the module-level extractor singleton so that the first
 * `vectorize()` call pays no model-load cost. Call this at server boot to
 * move the ~6s cold start out of the request path.
 *
 * Idempotent: subsequent calls are no-ops that return the same resolved
 * pipeline. Safe to call concurrently — all callers share the in-flight
 * load promise.
 *
 * Two modes:
 *
 *   1. Default model (or override via `featureExtractionModel`): performs
 *      the actual load through `createExtractor`.
 *
 *   2. Pre-instantiated `extractor`: bypasses the load entirely and
 *      installs the supplied instance as the singleton. Useful for tests
 *      that want to inject a mock pipeline, or for callers that have
 *      already loaded a model via a different code path.
 *
 * @param {object} [options]
 * @param {Function} [options.extractor]
 *   Pre-instantiated Transformers.js pipeline. If provided, no load is
 *   performed; this instance becomes the singleton.
 * @param {string} [options.featureExtractionModel]
 *   Model ID override. Ignored when `options.extractor` is provided.
 * @returns {Promise<Function>} The resolved (or supplied) pipeline.
 *
 * @example <caption>Pre-warm at server boot</caption>
 * await vectorize.prewarm();
 * // The next vectorize() call is instant.
 *
 * @example <caption>Inject a custom model</caption>
 * await vectorize.prewarm({ featureExtractionModel: "Xenova/bge-large-en" });
 *
 * @example <caption>Test seam: inject a mock</caption>
 * await vectorize.prewarm({ extractor: mockPipeline });
 */
const prewarm = async ({ extractor, featureExtractionModel } = {}) => {
  // Caller supplied a pre-instantiated pipeline: install it directly as
  // the resolved promise. Wrapping in Promise.resolve(...) preserves the
  // promise-shaped singleton invariant — ensureExtractor always sees a
  // promise, never a raw value.
  if (extractor) {
    return await (modelPromise = Promise.resolve(extractor));
  }
  // Otherwise route through the lazy initializer. If a load is already
  // in flight, this awaits the same promise; if no load has started yet,
  // it kicks one off and memoizes it.
  return await ensureExtractor(featureExtractionModel);
};

// ---------------------------------------------------------------------------
// createExtractor
// ---------------------------------------------------------------------------

/**
 * Initializes and returns a `@xenova/transformers` feature-extraction pipeline
 * for the specified model.
 *
 * Exposed as `vectorize.createExtractor` for callers that need to pre-warm
 * the model before processing a batch — pass the returned instance as
 * `options.extractor` to {@link vectorize} to avoid repeated initialization.
 *
 * @async
 * @function createExtractor
 * @param {string} [featureExtractionModel=CONFIG.featureExtractionModel]
 *   Model ID to load (e.g. `"Xenova/all-MiniLM-L12-v2"`). Defaults to the
 *   value configured in {@link CONFIG}.
 * @returns {Promise<Function>} Initialized Transformers.js pipeline instance.
 *
 * @example
 * const extractor = await createExtractor();
 * const vec = await vectorize("water treatment", { extractor });
 */
const createExtractor = async (featureExtractionModel) => (
  // quantized: true selects the ~25MB quantized ONNX weights for BGE-small
  // instead of the ~80MB full-precision variant. Quality difference on
  // sentence-embedding retrieval is well below the noise floor of cosine
  // ranking; the download/load saving is material on first run.
  await pipeline("feature-extraction", featureExtractionModel || CONFIG.featureExtractionModel, {
    quantized: true,
  })
);

// Attach createExtractor, prewarm, and defaultTextNormalization to the
// vectorize function so they are accessible without additional imports.
vectorize.createExtractor          = createExtractor;
vectorize.prewarm                  = prewarm;
vectorize.defaultTextNormalization = defaultTextNormalization;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(vectorize, "vectorize", {
  value: vectorize,
}));