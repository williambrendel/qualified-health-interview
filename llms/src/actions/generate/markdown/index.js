"use strict";

const generateMarkdown = require("./generateMarkdown");
const renameMarkdown   = require("./renameMarkdown");
const classifyMarkdown = require("./classifyMarkdown");

/**
 * @file index.js
 * @module actions/generate/markdown
 * @description Markdown-side orchestrator. Composes the three
 * markdown actions (generate, rename, classify) into a single
 * call so the endpoint can process one upload with one function.
 *
 * ## What this does
 *
 *   1. {@link generateMarkdown}: text → polished markdown via LLM
 *   2. {@link renameMarkdown}:   markdown → snake_case filename (pure)
 *   3. {@link classifyMarkdown}: markdown + themes → theme + confidence
 *
 * Returns `{markdown, filename, theme, confidence, rationale}`.
 *
 * ## What this does NOT do
 *
 *   - **No I/O.** Caller pre-loads text (via `loadFile` or `convert`)
 *     and passes the plain string in. Caller writes the result to
 *     disk after this returns.
 *   - **No batch handling.** This processes ONE document. The caller
 *     loops + collects results + handles per-file errors.
 *   - **No error catching.** Errors from any sub-action propagate.
 *     The caller decides whether to abort the batch, log + continue,
 *     or surface the error.
 *
 * ## When themes is missing or empty
 *
 * The classifier returns `{theme: null, confidence: null, rationale: "..."}`.
 * The output has the same shape; the caller's file-placement logic
 * uses `theme === null` to decide whether to put the file in a
 * theme folder or at the root.
 *
 * ## Per-action retries
 *
 * `maxRetries` applies uniformly to both LLM-calling sub-actions
 * (generate and classify). For finer control, future revisions
 * could split it into `maxRetries: { generate, classify }`.
 *
 * `fallbacks` can be a per-action map: `{generate: "...", classify: {...}}`.
 * Sub-actions use their fallback only when retries exhaust.
 */

/**
 * Run the markdown generation + naming + classification pipeline
 * for a single document.
 *
 * @async
 * @param {object} options
 * @param {string}   options.text              - Already-loaded source text.
 * @param {object}   options.prompts           - `{generate, classify}` — the
 *   two prompt strings loaded at server boot.
 * @param {string}   options.prompts.generate  - For `generateMarkdown`.
 * @param {string}   [options.prompts.classify] - For `classifyMarkdown`.
 *   Required only when `themes` is non-empty.
 * @param {Function} options.runLLM            - LLM call function shared
 *   across both LLM sub-actions.
 * @param {object}   options.llmConfigs        - `{generate, classify}` — per-action
 *   config (typically Sonnet for generate, Haiku for classify).
 * @param {object}   options.llmConfigs.generate  - For `generateMarkdown`.
 * @param {object}   [options.llmConfigs.classify] - For `classifyMarkdown`.
 *   Required only when `themes` is non-empty.
 * @param {object}   [options.themes]          - Theme set; if missing or
 *   empty, classifier returns `theme: null` without an LLM call.
 * @param {number}   [options.maxRetries=2]    - Retry budget per LLM action.
 * @param {object}   [options.fallbacks]       - `{generate?, classify?}` — per-action
 *   fallback values if retries exhaust.
 *
 * @returns {Promise<{
 *   markdown: string,
 *   filename: string,
 *   theme:    string|null,
 *   confidence: number|null,
 *   rationale: string,
 * }>}
 *
 * @throws Errors from any sub-action propagate. `generateMarkdown` may
 *   throw on retry exhaustion or invalid input; `renameMarkdown` may
 *   throw if the generated markdown has no H1; `classifyMarkdown` may
 *   throw on retry exhaustion when themes is provided.
 *
 * @example
 *   const loaded = await loadFile(uploadPath);
 *   const result = await run({
 *     text: loaded.data,
 *     prompts: { generate: generatePrompt, classify: classifyPrompt },
 *     runLLM,
 *     llmConfigs: { generate: SONNET45_CONFIG, classify: HAIKU45_CONFIG },
 *     themes,
 *   });
 *   // → { markdown, filename, theme, confidence, rationale }
 */
const run = async ({
  text,
  prompts = {},
  runLLM,
  llmConfigs = {},
  themes,
  maxRetries = 2,
  fallbacks = {},
} = {}) => {
  // ── Input validation ──────────────────────────────────────────────────────
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("actions/generate/markdown: text must be a non-empty string");
  }
  if (typeof runLLM !== "function") {
    throw new Error("actions/generate/markdown: runLLM must be a function");
  }
  if (typeof prompts.generate !== "string" || prompts.generate.length === 0) {
    throw new Error("actions/generate/markdown: prompts.generate must be a non-empty string");
  }
  if (!llmConfigs.generate || typeof llmConfigs.generate !== "object") {
    throw new Error("actions/generate/markdown: llmConfigs.generate must be an object");
  }

  // classify prompt + config only required when themes is non-empty.
  const themesProvided = themes && typeof themes === "object" && Object.keys(themes).length > 0;
  if (themesProvided) {
    if (typeof prompts.classify !== "string" || prompts.classify.length === 0) {
      throw new Error("actions/generate/markdown: prompts.classify is required when themes is non-empty");
    }
    if (!llmConfigs.classify || typeof llmConfigs.classify !== "object") {
      throw new Error("actions/generate/markdown: llmConfigs.classify is required when themes is non-empty");
    }
  }

  // ── Step 1: Generate the polished markdown ────────────────────────────────
  const markdown = await generateMarkdown({
    text,
    prompt:    prompts.generate,
    runLLM,
    llmConfig: llmConfigs.generate,
    maxRetries,
    fallback:  fallbacks.generate,
  });

  // ── Step 2: Derive filename from H1 (pure, no LLM) ────────────────────────
  const filename = renameMarkdown({ markdown });

  // ── Step 3: Classify into a theme (LLM call OR no-op when themes empty) ──
  const classification = await classifyMarkdown({
    content:   markdown,
    themes,                        // may be undefined → no-themes mode
    prompt:    prompts.classify,   // may be undefined when themes is empty
    runLLM,
    llmConfig: llmConfigs.classify,
    maxRetries,
    fallback:  fallbacks.classify,
  });

  return {
    markdown,
    filename,
    theme:      classification.theme,
    confidence: classification.confidence,
    rationale:  classification.rationale,
  };
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(run, "run", {
  value: run,
}));
