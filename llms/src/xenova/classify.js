"use strict";

const pipeline = require("./pipeline");
const CONFIG = require("./config");

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

/**
 * @file classify.js
 * @module core/llms/xenova/classify
 * @description Runs zero-shot text classification locally via
 * `@xenova/transformers` and an NLI (natural language inference) model.
 *
 * Companion to {@link vectorize}. Where `vectorize` produces a vector for
 * downstream cosine search, `classify` directly answers "which of these
 * labels best describes this text?" using entailment-based reasoning over
 * a small NLI model. The two are complementary primitives — `vectorize`
 * is faster and feeds the anchor-based classifier on the hot path;
 * `classify` is slower but does semantic entailment, which generalizes
 * across phrasings the anchor classifier may miss.
 *
 * A module-level singleton (`model`) caches the zero-shot pipeline after
 * the first initialization. Callers running classification in batch can
 * pass a pre-initialized pipeline via `options.classifier` to avoid
 * re-loading the model on each call.
 *
 * Loads the transformers.js pipeline via the {@link pipeline} CJS-to-ESM
 * bridge — `@xenova/transformers` is ESM-only and cannot be `require()`'d
 * directly. The bridge is transparent to callers.
 *
 * @see {@link https://huggingface.co/docs/transformers.js|Transformers.js Documentation}
 * @see {@link pipeline} for the dynamic-import wrapper.
 */

/**
 * Classify a text against a fixed set of candidate labels using zero-shot
 * NLI reasoning.
 *
 * Under the hood the pipeline runs the input text against each label as
 * an entailment hypothesis — "Does the text entail that this label
 * applies?" — and returns a probability for each label. Output is sorted
 * descending by score.
 *
 * Latency is materially higher than {@link vectorize} (one forward pass
 * per label, vs one total for an embedding). Expect ~100-300ms per call
 * for 3 labels on a small NLI model. Use as a fallback on the cheap
 * anchor-classifier's low-confidence cases rather than as the primary
 * classifier.
 *
 * @async
 * @function classify
 * @param {string} text
 *   Input string to classify. Coerced to `""` if falsy.
 * @param {string[]} labels
 *   Candidate labels. Each label is scored independently against the text.
 *   Typically 2-5 labels — the per-label cost compounds linearly.
 * @param {object} [options]
 * @param {string} [options.hypothesisTemplate="This text is about {}"]
 *   NLI hypothesis template. The `{}` placeholder is replaced with each
 *   label. The phrasing affects the model's reasoning — `"This text is
 *   about {}"` works well for topic classification, `"This example is
 *   {}"` for intent. The pipeline accepts the literal `{}` placeholder
 *   token.
 * @param {boolean} [options.multiLabel=false]
 *   When `true`, scores are independent per label (sum may exceed 1).
 *   When `false`, scores are normalized to sum to 1 (softmax over
 *   labels). Default `false` matches a single-class-pick decision.
 * @param {Function} [options.classifier]
 *   Pre-initialized `@xenova/transformers` pipeline instance. Providing
 *   this avoids reloading the model on every call — recommended for
 *   batch processing. If omitted, the module-level singleton is used or
 *   created.
 * @param {string} [options.zeroShotClassificationModel=CONFIG.zeroShotClassificationModel]
 *   Model ID used to initialize the pipeline if no classifier is provided
 *   (e.g. `"Xenova/nli-deberta-v3-xsmall"`).
 *
 * @returns {Promise<{ labels: string[], scores: number[] }>}
 *   Resolves to `{ labels, scores }` where `labels` and `scores` are
 *   parallel arrays sorted descending by score. The label at `labels[0]`
 *   has the highest entailment score; `scores[i]` is the score for
 *   `labels[i]`.
 *
 * @throws {Error} If the classifier pipeline fails to initialize.
 * @throws {Error} If the model cannot process the input.
 *
 * @example <caption>Basic usage</caption>
 *   const { labels, scores } = await classify(
 *     "Hello, how are you?",
 *     ["a greeting", "a technical question", "a support request"]
 *   );
 *   // labels: ["a greeting", "a support request", "a technical question"]
 *   // scores: [0.92, 0.05, 0.03]
 *
 * @example <caption>Pre-initialized classifier for batch processing</caption>
 *   const classifier = await createClassifier();
 *   for (const text of texts) {
 *     const result = await classify(text, labels, { classifier });
 *   }
 *
 * @example <caption>Custom hypothesis template</caption>
 *   const result = await classify("call me back later", labels, {
 *     hypothesisTemplate: "This example expresses {}",
 *   });
 */
// ── Singleton storage ──────────────────────────────────────────────────────
// We memoize the *promise* (not the resolved pipeline) so that concurrent
// first-callers all share the same in-flight load rather than each kicking
// off their own. The first caller assigns; later callers await the same
// promise. Idempotent: once set, the singleton is reused forever.
let modelPromise;

/**
 * @function ensureClassifier
 * @description
 * Internal helper. Returns the resolved classifier pipeline, loading it
 * lazily on first call and reusing the cached promise thereafter. See
 * `vectorize.js` for the design rationale — same pattern applies here.
 *
 * @param {string} [zeroShotClassificationModel] Model ID override.
 * @returns {Promise<Function>} Resolved Transformers.js pipeline.
 */
const ensureClassifier = (zeroShotClassificationModel) => (
  modelPromise || (modelPromise = createClassifier(zeroShotClassificationModel))
);

const classify = async (
  text,
  labels,
  {
    hypothesisTemplate = "This text is about {}",
    multiLabel         = false,
    classifier,
    zeroShotClassificationModel,
    ...other
  } = {}
) => {
  // ── Initialize classifier ──────────────────────────────────────────────
  // Use a caller-provided classifier if one was passed (test seam or
  // pre-warmed instance), otherwise fall through to the module singleton.

  classifier || (classifier = await ensureClassifier(zeroShotClassificationModel));

  // ── Input coercion ─────────────────────────────────────────────────────

  text || (text = "");

  // ── Inference ──────────────────────────────────────────────────────────
  // Transformers.js's zero-shot pipeline returns { sequence, labels,
  // scores } where labels/scores are already sorted descending by score.

  const result = await classifier(text, labels, {
    hypothesis_template: hypothesisTemplate,
    multi_label:         multiLabel,
    ...other,
  });

  return { labels: result.labels, scores: result.scores };
};

// ---------------------------------------------------------------------------
// classify.prewarm
// ---------------------------------------------------------------------------

/**
 * @function classify.prewarm
 * @async
 * @description
 * Eagerly populate the module-level classifier singleton so that the
 * first `classify()` call pays no model-load cost. See {@link
 * vectorize.prewarm} for full design notes — same semantics here.
 *
 * @param {object} [options]
 * @param {Function} [options.classifier]
 *   Pre-instantiated zero-shot classification pipeline. If provided, no
 *   load is performed; this instance becomes the singleton.
 * @param {string} [options.zeroShotClassificationModel]
 *   Model ID override. Ignored when `options.classifier` is provided.
 * @returns {Promise<Function>} The resolved (or supplied) pipeline.
 *
 * @example <caption>Pre-warm at server boot</caption>
 *   await classify.prewarm();
 */
const prewarm = async ({ classifier, zeroShotClassificationModel } = {}) => {
  if (classifier) {
    return await (modelPromise = Promise.resolve(classifier));
  }
  return await ensureClassifier(zeroShotClassificationModel);
};

// ---------------------------------------------------------------------------
// createClassifier
// ---------------------------------------------------------------------------

/**
 * Initialize and return a `@xenova/transformers` zero-shot classification
 * pipeline.
 *
 * Exposed as `classify.createClassifier` for callers that need to pre-warm
 * the model before processing a batch — pass the returned instance as
 * `options.classifier` to {@link classify} to avoid repeated
 * initialization.
 *
 * @async
 * @function createClassifier
 * @param {string} [zeroShotClassificationModel=CONFIG.zeroShotClassificationModel]
 *   Model ID to load (e.g. `"Xenova/nli-deberta-v3-xsmall"`). Defaults to
 *   the value configured in {@link CONFIG}.
 * @returns {Promise<Function>} Initialized Transformers.js pipeline instance.
 *
 * @example
 *   const classifier = await createClassifier();
 *   const result = await classify("hello", ["greeting", "question"], { classifier });
 */
const createClassifier = async (zeroShotClassificationModel) => (
  // quantized: true selects the ~80MB quantized ONNX weights instead of the
  // ~700MB full-precision variant that Transformers.js downloads by default.
  // For the NLI fallback path the quality delta is negligible against the
  // download/load cost saved — full precision is roughly 10x larger and 10x
  // slower to first-load with no measurable accuracy gain on our 3-class
  // entailment task.
  await pipeline("zero-shot-classification", zeroShotClassificationModel || CONFIG.zeroShotClassificationModel, {
    quantized: true,
  })
);

// Attach createClassifier and prewarm to the classify function so they
// are accessible without an additional import.
classify.createClassifier = createClassifier;
classify.prewarm          = prewarm;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(classify, "classify", {
  value: classify,
}));