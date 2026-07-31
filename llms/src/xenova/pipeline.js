"use strict";

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

/**
 * @file pipeline.js
 * @module core/llms/xenova/pipeline
 * @description CJS-to-ESM bridge for `@xenova/transformers`.
 *
 * `@xenova/transformers` ships as ESM-only — its `package.json` declares
 * `"type": "module"` and provides no CJS build. CommonJS code cannot
 * `require()` it (Node throws "Must use import to load ES Module"), so
 * every place in this codebase that needs a transformers.js pipeline
 * must go through dynamic `import()`.
 *
 * Rather than open-coding the dynamic import at every call site, this
 * module wraps it once. Three properties matter:
 *
 *   1. **Single import promise.** The `import("@xenova/transformers")`
 *      call resolves once and the resulting promise is cached. The
 *      heavy work (locating the package, evaluating its top-level code,
 *      initializing ONNX bindings) happens at first call only.
 *
 *   2. **Function-as-default export.** The wrapper is exported as a
 *      callable so call sites read the same way they would with a
 *      direct CJS export — `await pipeline("feature-extraction", id)`
 *      — instead of an awkward `await wrapper.pipeline(...)`.
 *
 *   3. **Mockable in Jest.** Tests can `jest.mock("./pipeline", ...)`
 *      with a synchronous fake that returns the appropriate pipeline
 *      stub per task. No CJS-requires-ESM machinery is invoked in test
 *      runs.
 *
 * Usage:
 *
 *   const pipeline = require("./pipeline");
 *   const extractor = await pipeline("feature-extraction", modelId);
 *
 * @see {@link https://huggingface.co/docs/transformers.js|Transformers.js Documentation}
 * @see {@link https://nodejs.org/api/esm.html#import-expressions|Node — Dynamic import()}
 */

/**
 * Memoized promise that resolves to the `pipeline` function exported by
 * `@xenova/transformers`. Lazily initialized on first call to {@link pipeline}.
 *
 * @type {Promise<Function>|undefined}
 */
let _pipelinePromise;

/**
 * Resolve a transformers.js pipeline for the given task and model.
 *
 * @async
 * @function pipeline
 * @param {string}   task     Pipeline task (e.g. `"feature-extraction"`,
 *                            `"zero-shot-classification"`).
 * @param {string}   modelId  Model identifier on the Hugging Face hub
 *                            (e.g. `"Xenova/bge-small-en-v1.5"`).
 * @param {Object}   [opts]   Additional options forwarded to the
 *                            underlying transformers.js `pipeline()`.
 * @returns {Promise<Function>} The initialized pipeline instance — a
 *   callable that takes the task's input and returns its output. Each
 *   call to this wrapper returns a fresh pipeline (transformers.js
 *   caches model weights internally, so the heavy load only happens
 *   once per `modelId`).
 */
const pipeline = (...args) => (
  _pipelinePromise || (_pipelinePromise = import("@xenova/transformers").then(m => m.pipeline))
).then(p => p(...args));

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(pipeline, "pipeline", {
  value: pipeline,
}));
