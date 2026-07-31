"use strict";

const vectorize  = require("./vectorize");
const classify   = require("./classify");
const answer     = require("./answer");
const summarize  = require("./summarize");
const synthesize = require("./synthesize");

/**
 * @file xenova/prewarm.js
 * @brief Boot-time helper that loads all five xenova model singletons in
 * parallel. Use this at server startup to amortize cold-start cost out of
 * the request path.
 *
 * Why a separate file? Each `xenova/*.js` exposes its own `prewarm()`
 * because each module owns its model singleton. This umbrella simply
 * invokes them all at once — `Promise.all` lets the loads overlap so
 * total wait time is roughly max(slowest), not sum(all).
 *
 * Granular control. Callers select which models to warm via the options
 * object. The default (no options, or `{ all: true }`) warms every model.
 * For a server that uses only a subset of capabilities, pass only the
 * keys it needs to avoid loading models that will never be called.
 *
 * Per-module options. Each section accepts the same options that the
 * corresponding `vectorize.prewarm()` / `classify.prewarm()` etc accept —
 * a pre-instantiated pipeline (test seam) or a model ID override.
 *
 * Idempotent. Each underlying `prewarm()` is itself idempotent: calling
 * this twice is safe and the second invocation is a no-op. Models stay
 * loaded for the process lifetime.
 *
 * @example <caption>Warm everything with defaults</caption>
 *   const prewarm = require("./src/xenova/prewarm");
 *   await prewarm();
 *   console.log("Models warm. Ready to serve.");
 *
 * @example <caption>Warm only what the application uses</caption>
 *   await prewarm({
 *     features:  true,                    // vectorize default model
 *     classify:  true,                    // NLI default model
 *     // answer, summarize, synthesize omitted — never loaded
 *   });
 *
 * @example <caption>Override a model</caption>
 *   await prewarm({
 *     features: { featureExtractionModel: "Xenova/bge-large-en-v1.5" },
 *     classify: true,
 *   });
 *
 * @example <caption>Test seam — inject mocks</caption>
 *   await prewarm({
 *     features: { extractor:  mockExtractor },
 *     classify: { classifier: mockClassifier },
 *   });
 */

/**
 * @function prewarm
 * @async
 * @description
 * Eagerly populate the module singletons for any/all xenova model
 * wrappers in parallel.
 *
 * @param {object} [options]
 *   When omitted, all five models are warmed with default configs.
 *   When provided, only the keys with truthy values are warmed; the rest
 *   are skipped.
 *
 * @param {boolean|object} [options.features]
 *   `true` to warm vectorize with defaults. An object is passed through
 *   to {@link vectorize.prewarm} as options (`extractor`,
 *   `featureExtractionModel`).
 *
 * @param {boolean|object} [options.classify]
 *   `true` to warm classify with defaults. An object is passed through
 *   to {@link classify.prewarm} as options (`classifier`,
 *   `zeroShotClassificationModel`).
 *
 * @param {boolean|object} [options.answer]
 *   `true` to warm answer with defaults. An object is passed through to
 *   {@link answer.prewarm} (`questionAnswering`, `questionAnsweringModel`).
 *
 * @param {boolean|object} [options.summarize]
 *   `true` to warm summarize with defaults. An object is passed through
 *   to {@link summarize.prewarm} (`summarizer`, `summarizationModel`).
 *
 * @param {boolean|object} [options.synthesize]
 *   `true` to warm synthesize with defaults. An object is passed through
 *   to {@link synthesize.prewarm} (`synthesizer`, `text2textModel`).
 *
 * @returns {Promise<object>}
 *   Resolves to a report object keyed by capability name, with each
 *   value being either the resolved pipeline instance (on success) or
 *   `null` if that capability was not requested. Useful for logging
 *   "what got loaded" at boot.
 */
const prewarm = async (options) => {
  // Default: warm every model. The `??` falls back when the caller
  // passed nothing; the explicit `true` markers below default to
  // `true` so omitting any single key (when an options object IS
  // provided) means "skip" — matching the documented behavior.
  const opts = options ?? {
    features:   true,
    classify:   true,
    answer:     true,
    summarize:  true,
    synthesize: true,
  };

  // Normalize each key: false-y → skip, `true` → use defaults, object →
  // pass through as prewarm options. Skipped entries resolve to `null`
  // in the report so callers can see what wasn't loaded.
  const tasks = [
    ["features",   opts.features,   vectorize.prewarm],
    ["classify",   opts.classify,   classify.prewarm],
    ["answer",     opts.answer,     answer.prewarm],
    ["summarize",  opts.summarize,  summarize.prewarm],
    ["synthesize", opts.synthesize, synthesize.prewarm],
  ];

  // Kick all enabled prewarms off in parallel so the loads overlap.
  // Each prewarm hits a different model file, so there's no contention.
  // We use Promise.all (not allSettled) because if any single load
  // fails, the application probably can't run correctly — surfacing
  // the error early is correct behavior.
  const results = await Promise.all(
    tasks.map(([_name, enabled, warm]) => {
      if (!enabled) return Promise.resolve(null);
      // `enabled === true` → call with no args. Object → pass through.
      return warm(enabled === true ? undefined : enabled);
    })
  );

  // Pair the keys back with the resolved values for an ergonomic
  // return shape. Callers can destructure or log this directly.
  return Object.fromEntries(
    tasks.map(([name], i) => [name, results[i]])
  );
};

module.exports = Object.freeze(Object.defineProperty(prewarm, "prewarm", {
  value: prewarm,
}));
