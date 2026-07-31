"use strict";

/**
 * @file runWithRetry.js
 * @module utilities/runWithRetry
 * @description Generic content-level retry wrapper for any async
 * function (typically an LLM call). Retries when the function's
 * output fails a caller-supplied validator OR when the function
 * itself throws.
 *
 * ## Why this exists alongside provider retry
 *
 * Provider SDKs (Anthropic, OpenAI, etc.) retry on TRANSPORT-level
 * failures: network errors, HTTP 5xx, 429 rate limits. They don't
 * retry on "200 OK with bad content" — which happens often with
 * LLMs:
 *
 *   - schema drift (string where an array was expected)
 *   - missing required fields in JSON output
 *   - LLM picked a value outside an allowed set
 *   - response wrapped in ```json fences against instructions
 *   - markdown output without the required H1
 *
 * `runWithRetry` layers content-level retry on top of provider
 * retry: the provider handles "the call failed"; this utility
 * handles "the call succeeded but the content is unusable."
 *
 * ## Contract
 *
 * `runWithRetry` is a thin wrapper. The shape of `runLLM` defines
 * the shape of `runWithRetry`:
 *
 *   - Input:  whatever positional args `runLLM` takes — this wrapper
 *             passes `(config, prompt)` through unchanged.
 *   - Output: whatever `runLLM` returns — Response envelope, string,
 *             custom object, anything. The validator sees the same
 *             value the caller will receive on success.
 *
 * Callers that need to inspect a specific shape (e.g. unwrap an
 * Anthropic Response to its text body) do that themselves after
 * `runWithRetry` returns. Validators that care about content shape
 * (does the parsed JSON have all required fields?) also do their
 * own unwrapping. Keeping `runWithRetry` opaque to response shape
 * preserves its generality across providers.
 *
 * ## Composability
 *
 * The utility is generic — it takes any `runLLM` function plus a
 * validator. It works with Claude, OpenAI, or any future provider.
 * It works for JSON outputs, markdown outputs, classification
 * results, anything the validator can score.
 *
 * The validator returns `{valid, errors?}`. Errors are accumulated
 * across attempts so the exhaustion-throw can include diagnostic
 * detail.
 */

/**
 * Default validator: always passes. Use when callers want pure
 * transport-retry semantics on top of an SDK that doesn't already
 * provide it. With a no-op validator, `runWithRetry` only retries
 * on throws from the underlying function.
 *
 * @returns {{valid: true}}
 */
const alwaysValid = () => ({ valid: true });

/**
 * Call an async function with content-level retry.
 *
 * Mirrors the call shape of `src/claude/run.js`:
 *   `runLLM(config, prompt)` → some result
 *
 * System prompts and other provider-specific options live inside
 * `config`. The caller is responsible for assembling that — this
 * wrapper does not interpret it.
 *
 * @async
 * @param {object} options
 * @param {Function} options.runLLM      - The async function to call.
 *   Invoked as `runLLM(config, prompt)`. Returns any value; the
 *   validator and caller decide what to do with it.
 * @param {object}   options.config      - Provider-specific config
 *   passed as the first arg to `runLLM`. System prompts, model
 *   selection, temperature, etc. live here.
 * @param {string}   options.prompt      - The prompt / user message
 *   passed as the second arg to `runLLM`. Matches `claude/run`'s
 *   second-arg convention.
 * @param {Function} [options.validate]  - `(raw) => {valid, errors?}`.
 *   Called on each successful return from `runLLM`. Receives whatever
 *   shape `runLLM` returned (Response, string, etc.) — unwrap inside
 *   the validator if needed. Defaults to a no-op that always passes,
 *   yielding pure transport-retry semantics.
 * @param {number}   [options.maxRetries=2] - Retry budget. Total
 *   attempts = `1 + maxRetries` (default 3).
 * @param {*}        [options.fallback]  - If provided, returned on
 *   retry exhaustion instead of throwing. Use for production-safe
 *   degradation. Omit during development to see failures loudly.
 *
 * @returns {Promise<*>} The raw value returned by `runLLM` on a
 *   successful + validated attempt.
 *
 * @throws {Error} On retry exhaustion when no `fallback` is set.
 *   The error has `.attempts` (total attempts made), `.errors`
 *   (array of validator/throw messages across attempts), and
 *   `.lastOutput` (the most recent raw output, if any).
 *
 * @example
 *   // With content validation. Validator unwraps if needed.
 *   const response = await runWithRetry({
 *     runLLM: claudeRun,
 *     config: { ...HAIKU_CONFIG, system: systemPrompt },
 *     prompt: userText,
 *     validate: (raw) => {
 *       const text = raw && raw.output ? raw.output.text : raw;
 *       return {
 *         valid: typeof text === "string" && /^# .+/m.test(text),
 *         errors: ["LLM output has no H1"],
 *       };
 *     },
 *     maxRetries: 2,
 *   });
 *
 * @example
 *   // Pure transport retry (no content validation).
 *   const raw = await runWithRetry({
 *     runLLM: claudeRun,
 *     config: { ...SONNET_CONFIG, system: prompt },
 *     prompt: userMessage,
 *   });
 */
const runWithRetry = async ({
  runLLM,
  config,
  prompt,
  validate = alwaysValid,
  maxRetries = 2,
  fallback,
} = {}) => {
  if (typeof runLLM !== "function") {
    throw new Error("runWithRetry: runLLM must be a function");
  }

  const totalAttempts = 1 + Math.max(0, maxRetries);
  const errors = [];
  let lastOutput;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    let raw;
    try {
      raw = await runLLM(config, prompt);
    } catch (err) {
      // Transport-level failure that bubbled past the provider's own
      // retries. We retry here too — different error types could be
      // transient (some 5xx the SDK doesn't retry, custom client
      // wrappers that throw on body-parse failures, etc.).
      errors.push(`attempt ${attempt + 1}: runLLM threw — ${err.message}`);
      continue;
    }

    lastOutput = raw;
    const result = validate(raw);

    if (result && result.valid) return raw;

    // Validator rejected. Accumulate error messages for diagnostics.
    const attemptErrors = result && Array.isArray(result.errors) ? result.errors : ["validation failed"];
    for (const e of attemptErrors) {
      errors.push(`attempt ${attempt + 1}: ${e}`);
    }
  }

  // ── Exhausted ──────────────────────────────────────────────────────────
  if (fallback !== undefined) return fallback;

  const err = new Error(
    `runWithRetry: failed after ${totalAttempts} attempts — ${errors.join("; ")}`
  );
  err.attempts   = totalAttempts;
  err.errors     = errors;
  err.lastOutput = lastOutput;
  throw err;
};

// Helper exports for tests and adjacent code.
runWithRetry.alwaysValid = alwaysValid;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(runWithRetry, "runWithRetry", {
  value: runWithRetry,
}));