"use strict";

const pipeline = require("./pipeline");
const CONFIG = require("./config");

/**
 * @function answer
 * @async
 * @description
 * Executes an extractive question-answering (QA) operation over a provided
 * context. The function uses a transformer-based question-answering pipeline
 * to locate and return the most relevant answer span directly from the
 * supplied context text.
 *
 * The function supports lazy initialization of the QA pipeline: if a
 * preloaded pipeline instance is not provided, it will be created on-demand
 * using the specified model.
 *
 * This is a strictly extractive process — the returned answer must exist
 * verbatim within the context and no generative reasoning or synthesis
 * is performed.
 *
 * Loads the transformers.js pipeline via the {@link pipeline} CJS-to-ESM
 * bridge — `@xenova/transformers` is ESM-only and cannot be `require()`'d
 * directly. The bridge is transparent to callers.
 *
 * @param {string} question
 * Natural language question to be answered.
 *
 * @param {string} context
 * Text passage in which the answer will be searched. The answer must be
 * present as a contiguous span within this context.
 *
 * @param {Object} options
 * Configuration object.
 *
 * @param {*} [options.questionAnswering]
 * Preloaded @xenova/transformers question-answering pipeline instance.
 * If not provided, the pipeline will be initialized automatically.
 *
 * @param {string} [options.questionAnsweringModel=CONFIG.questionAnsweringModel]
 * Model name used to initialize the question-answering pipeline when
 * a preloaded instance is not supplied.
 *
 * @returns {Promise<Object>}
 * Resolves to an object containing the extracted answer span:
 *
 * @returns {string} return.answer
 * Extracted answer text from the context.
 *
 * @returns {number} return.score
 * Confidence score indicating how well the answer matches the question.
 *
 * @returns {number} return.start
 * Character index where the answer span begins in the context.
 *
 * @returns {number} return.end
 * Character index where the answer span ends in the context.
 *
 * @example
 * const result = await answer(
 *   "What issues do biofilms cause?",
 *   "Biofilms reduce heat transfer efficiency and increase corrosion rates.",
 *   {}
 * );
 *
 * console.log(result.answer);
 *
 * @notes
 * - Designed to be used after a retrieval step (e.g., semantic search).
 * - Does not hallucinate or generate new content.
 * - Best suited for fact-grounded, high-precision QA workflows.
 *
 * @throws {Error}
 * Throws if the question-answering pipeline cannot be initialized.
 */
// ── Singleton storage ──────────────────────────────────────────────────────
// We memoize the *promise* (not the resolved pipeline) so that concurrent
// first-callers all share the same in-flight load. See vectorize.js for
// the full design rationale.
let modelPromise;

/**
 * @function ensureQuestionAnswering
 * @description
 * Internal helper. Returns the resolved question-answering pipeline,
 * loading it lazily on first call and reusing the cached promise
 * thereafter.
 *
 * @param {string} [questionAnsweringModel] Model ID override.
 * @returns {Promise<Function>} Resolved Transformers.js pipeline.
 */
const ensureQuestionAnswering = (questionAnsweringModel) => (
  modelPromise || (modelPromise = createQuestionAnswering(questionAnsweringModel))
);

const answer = async (
  question,
  context,
  {
    questionAnswering,
    questionAnsweringModel,
    topk,
    ...other
  } = {}
) => {

  // Init question answering engine if needed.
  questionAnswering || (questionAnswering = await ensureQuestionAnswering(questionAnsweringModel));

  return await questionAnswering(
    question.normalize("NFC").trim(),
    context.normalize("NFC").trim(),
    { topk, ...other }
  );
}

const createQuestionAnswering = answer.createQuestionAnswering = async questionAnsweringModel => (
  // quantized: true selects the smaller quantized ONNX weights instead of
  // Transformers.js's full-precision default. See vectorize.js / classify.js
  // for the rationale — same tradeoff applies here.
  await pipeline("question-answering", questionAnsweringModel || CONFIG.questionAnsweringModel, {
    quantized: true,
  })
);

/**
 * @function answer.batch
 * @async
 * @description
 * Batched variant of {@link answer}. Accepts an array of `{question, context}`
 * pairs and processes them in a single forward pass.
 *
 * @param {Array<{question: string, context: string}>} pairs
 *   Array of question/context pairs to process.
 * @param {Object} options - Same options as {@link answer}.
 * @returns {Promise<Array<{answer, score, start, end}>>} Results in input order.
 *
 * @example
 * const results = await answer.batch(
 *   segments.map(s => ({ question: "What is the main topic?", context: s })),
 *   { questionAnswering }
 * );
 */
answer.batch = async (
  pairs,
  {
    questionAnswering,
    questionAnsweringModel,
    topk,
    ...other
  } = {}
) => {
  questionAnswering || (questionAnswering = await ensureQuestionAnswering(questionAnsweringModel));
  const inputs = pairs.map(({ question, context }) => ({
    question: question.normalize("NFC").trim(),
    context:  context.normalize("NFC").trim(),
  }));
  const results = await questionAnswering(inputs, { topk, ...other });
  // Pipeline returns an array of result objects for batch input.
  return Array.isArray(results[0]) ? results.map(r => r[0]) : results;
};

// ---------------------------------------------------------------------------
// answer.prewarm
// ---------------------------------------------------------------------------

/**
 * @function answer.prewarm
 * @async
 * @description
 * Eagerly populate the module-level question-answering singleton. See
 * {@link vectorize.prewarm} for full design notes — same semantics.
 *
 * @param {object} [options]
 * @param {Function} [options.questionAnswering]
 *   Pre-instantiated pipeline. If provided, no load is performed.
 * @param {string} [options.questionAnsweringModel]
 *   Model ID override. Ignored when `options.questionAnswering` is provided.
 * @returns {Promise<Function>} The resolved (or supplied) pipeline.
 */
answer.prewarm = async ({ questionAnswering, questionAnsweringModel } = {}) => {
  if (questionAnswering) {
    return await (modelPromise = Promise.resolve(questionAnswering));
  }
  return await ensureQuestionAnswering(questionAnsweringModel);
};

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(answer, "answer", {
  value: answer
}));