"use strict";

const runWithRetry = require("../../../utilities/runWithRetry");

/**
 * @file generateMarkdown.js
 * @module actions/generate/markdown/generateMarkdown
 * @description LLM action: takes raw text from a source document
 * and produces a polished Markdown document ready for the knowledge
 * base. Composes {@link runWithRetry} for content-level retry on
 * malformed or H1-less output.
 *
 * Single responsibility: text → markdown string. The output IS the
 * full markdown document body, starting with `# Title`. Downstream
 * actions ({@link renameMarkdown}, {@link classifyMarkdown}) read
 * the returned string.
 *
 * ## Output contract
 *
 * The returned string:
 *   - Is non-empty
 *   - Begins with a single H1 (`# Title`) on the first non-blank line
 *   - Is NOT wrapped in code fences (` ```markdown ... ``` `).
 *     Even when LLMs produce fence-wrapped output despite prompt
 *     instructions, this action strips them as a safety net.
 *
 * The prompt mandates a fuller structure (Executive Summary,
 * Overview, Content sections, Key Takeaways), but this action only
 * validates the H1 — checking the rest would require parsing the
 * entire markdown structure on every call. The H1 alone is the
 * critical contract because {@link renameMarkdown} depends on it.
 *
 * ## Retry behavior
 *
 * Up to `1 + maxRetries` attempts (default 3). Validator failures
 * (no H1, empty output) and `runLLM` throws both trigger retry.
 * Final failure throws unless `fallback` is provided.
 */

/**
 * Regex matching the opening fence of a `\`\`\`markdown` (or
 * `\`\`\`md`, or plain `\`\`\``) wrapper around the response body.
 * Captures the marker so we can match the corresponding close
 * fence at the end.
 *
 * @type {RegExp}
 */
const OPEN_FENCE_REGEX = /^\s*```(?:markdown|md)?\s*\n/;

/**
 * Regex matching the closing fence at the end of the response.
 *
 * @type {RegExp}
 */
const CLOSE_FENCE_REGEX = /\n?\s*```\s*$/;

/**
 * Strip any code-fence wrapping around the LLM's response.
 *
 * Defensive: the prompt explicitly says NOT to wrap, but LLMs
 * occasionally do anyway. Removing the fences here keeps the
 * validator happy and produces clean markdown for downstream
 * actions.
 *
 * @param {string} raw - The raw LLM response text.
 * @returns {string}
 */
const stripCodeFences = (raw) => {
  let result = raw;
  if (OPEN_FENCE_REGEX.test(result)) {
    result = result.replace(OPEN_FENCE_REGEX, "");
    result = result.replace(CLOSE_FENCE_REGEX, "");
  }
  return result.trim();
};

/**
 * Regex matching an H1 line anywhere in the document. Same one
 * used by `renameMarkdown` — kept here so the validator is
 * self-contained (no cross-action import).
 *
 * @type {RegExp}
 */
const H1_REGEX = /^#\s+.+/m;

/**
 * Validate that the LLM's output is a usable markdown document.
 * Returns `{valid, errors}` per the {@link runWithRetry} contract.
 *
 * Two checks:
 *   1. The output is a non-empty string.
 *   2. The output contains an H1 heading.
 *
 * Fence-stripping happens BEFORE validation, so this validator
 * sees the cleaned content.
 *
 * @param {*} raw - The (already fence-stripped) LLM output.
 * @returns {{valid: boolean, errors?: string[]}}
 */
const validateMarkdown = (raw) => {
  const errors = [];
  if (typeof raw !== "string" || raw.length === 0) {
    errors.push("LLM returned empty or non-string output");
    return { valid: false, errors };
  }
  if (!H1_REGEX.test(raw)) {
    errors.push("LLM output has no H1 heading");
    return { valid: false, errors };
  }
  return { valid: true };
};

/**
 * Generate a polished markdown document from raw text.
 *
 * @async
 * @param {object} options
 * @param {string}   options.text       - Source text (already loaded
 *   from disk, converted from docx if applicable). The LLM transforms
 *   this into a structured markdown document.
 * @param {string}   options.prompt     - The system prompt content
 *   (loaded once at boot from `prompts/generate-markdown.ppl`). Merged
 *   into `config.system` before calling runLLM.
 * @param {Function} options.runLLM     - LLM call function. Signature
 *   `(config, prompt) => Promise<*>` matching `src/claude/run.js`.
 *   May return a Response envelope (with `.output.text`) or a plain
 *   string — this action handles both.
 * @param {object}   options.llmConfig  - Provider config (e.g.
 *   SONNET45_CONFIG, HAIKU45_CONFIG). The system prompt is merged in
 *   internally; do not set `config.system` yourself.
 * @param {number}  [options.maxRetries=2] - Content-level retry budget.
 * @param {string}  [options.fallback]    - Optional fallback markdown
 *   if retries exhaust. Must itself contain an H1.
 *
 * @returns {Promise<string>} The polished markdown document body (a
 *   plain string with fences stripped, ready for downstream actions).
 *
 * @throws {Error} On retry exhaustion without fallback. Error has
 *   `.attempts`, `.errors`, and `.lastOutput` per {@link runWithRetry}.
 *
 * @example
 *   const markdown = await generateMarkdown({
 *     text: loadedFile.data,
 *     prompt: generateMarkdownPrompt,
 *     runLLM: claudeRun,
 *     llmConfig: SONNET45_CONFIG,
 *   });
 *   const filename = renameMarkdown({ markdown });
 */
const generateMarkdown = async ({
  text,
  prompt,
  runLLM,
  llmConfig,
  maxRetries = 2,
  fallback,
} = {}) => {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("generateMarkdown: text must be a non-empty string");
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("generateMarkdown: prompt must be a non-empty string");
  }

  // The wrapped LLM caller unwraps Response envelopes AND strips code
  // fences before runWithRetry sees the response. Validators (and the
  // final return value) operate on cleaned strings. This way retries
  // fire on "200 OK with bad content" — empty response, missing H1,
  // etc. — caused by the model emitting only fences or omitting the
  // required heading.
  const wrappedRunLLM = async (config, p) => {
    const raw = await runLLM(config, p);
    const text = (raw && raw.output && typeof raw.output.text === "string")
      ? raw.output.text
      : raw;
    if (typeof text !== "string") return text;
    return stripCodeFences(text);
  };

  // System prompt goes into config.system (Anthropic-standard field).
  // claude/run.js has no separate system parameter — it lives in config.
  const callConfig = { ...llmConfig, system: prompt };

  return runWithRetry({
    runLLM:  wrappedRunLLM,
    config:  callConfig,
    prompt:  text,
    validate: validateMarkdown,
    maxRetries,
    fallback,
  });
};

// Helper exports for tests and adjacent code.
generateMarkdown.validateMarkdown  = validateMarkdown;
generateMarkdown.stripCodeFences   = stripCodeFences;
generateMarkdown.H1_REGEX          = H1_REGEX;
generateMarkdown.OPEN_FENCE_REGEX  = OPEN_FENCE_REGEX;
generateMarkdown.CLOSE_FENCE_REGEX = CLOSE_FENCE_REGEX;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(generateMarkdown, "generateMarkdown", {
  value: generateMarkdown,
}));