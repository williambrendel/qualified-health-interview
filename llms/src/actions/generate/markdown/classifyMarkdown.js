"use strict";

const runWithRetry = require("../../../utilities/runWithRetry");

/**
 * @file classifyMarkdown.js
 * @module actions/generate/markdown/classifyMarkdown
 * @description LLM action: takes a polished markdown document and
 * a fixed theme list, picks ONE theme from the list. Returns
 * `{theme, confidence, rationale}`.
 *
 * ## Two modes
 *
 * **Themes provided (non-empty object):** the LLM is called with
 * the document content + the theme list (keys and descriptions).
 * It picks one theme verbatim from the keys. The validator
 * confirms the response is well-formed JSON and the picked theme
 * exists in the input set.
 *
 * **Themes missing or empty:** returns `{theme: null, confidence: null,
 * rationale: "no themes provided"}` synchronously, no LLM call.
 * Useful when the upload tool doesn't have a theme list configured
 * — the file gets placed flat under the output directory.
 *
 * ## Schema for themes parameter
 *
 *   {
 *     "<theme-name>": {
 *       "description": "What kinds of content belong here",
 *       "examples": ["Optional example titles"]
 *     },
 *     ...
 *   }
 *
 * Keys are the canonical theme names (used as documentId prefixes
 * and folder names). The classifier returns one of these keys verbatim.
 *
 * ## Output schema
 *
 *   {
 *     "theme":      "<one of the input keys>",
 *     "confidence": 0..1,
 *     "rationale":  "One sentence explaining the choice"
 *   }
 *
 * Confidence below 0.5 indicates a forced pick — caller should log
 * a warning. The action itself does NOT reject low-confidence
 * classifications; the upload pipeline accepts whatever the
 * classifier returns and lets a human audit later.
 */

/**
 * Unwrap an LLM response to its plain text body.
 *
 * Accepts either:
 *   - a Response envelope from `src/claude/run.js` with `.output.text`
 *   - a plain string (some providers/wrappers return strings directly)
 *
 * Returns the text body in both cases. Anything else falls through
 * untouched so the parser/validator can reject it as "not a usable
 * response."
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
 * Strip JSON fences a model may wrap around its output despite
 * prompt instructions. Same pattern as `generateMarkdown` but
 * targeting ```json instead of ```markdown.
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
 * Parse the LLM's response as JSON. Accepts either a Response
 * envelope or a plain string. Returns the parsed object, or `null`
 * if parsing fails. Failure is normal during retries — the validator
 * surfaces it as a retry trigger rather than letting JSON.parse throw
 * uncaught.
 *
 * @param {*} raw
 * @returns {object|null}
 */
const parseJsonSafely = (raw) => {
  const text = unwrapText(raw);
  if (typeof text !== "string") return null;
  const cleaned = stripJsonFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
};

/**
 * Build the validator for a given theme set. The validator checks:
 *   1. Response is non-null parsed JSON
 *   2. `theme` is a string AND is one of the provided keys
 *   3. `confidence` is a number in [0, 1]
 *   4. `rationale` is a string
 *
 * @param {object} themes - The theme set; keys are valid theme names.
 * @returns {Function} Validator with signature `(raw) => {valid, errors?}`.
 */
const buildValidator = (themes) => {
  const themeKeys = new Set(Object.keys(themes));
  return (raw) => {
    const parsed = parseJsonSafely(raw);
    if (!parsed || typeof parsed !== "object") {
      return { valid: false, errors: ["response is not valid JSON"] };
    }

    const errors = [];

    if (typeof parsed.theme !== "string") {
      errors.push(`theme must be a string, got ${typeof parsed.theme}`);
    } else if (!themeKeys.has(parsed.theme)) {
      errors.push(
        `theme "${parsed.theme}" is not in the provided theme list ` +
        `(must be one of: ${Array.from(themeKeys).slice(0, 5).join(", ")}${themeKeys.size > 5 ? "..." : ""})`
      );
    }

    if (typeof parsed.confidence !== "number" ||
        Number.isNaN(parsed.confidence) ||
        parsed.confidence < 0 ||
        parsed.confidence > 1) {
      errors.push(`confidence must be a number in [0, 1], got ${parsed.confidence}`);
    }

    if (typeof parsed.rationale !== "string" || parsed.rationale.length === 0) {
      errors.push("rationale must be a non-empty string");
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }
    return { valid: true };
  };
};

/**
 * Format the user-message portion of the LLM input. Combines the
 * theme list (as a compact JSON-ish description) with the document
 * content.
 *
 * @param {object} themes
 * @param {string} content
 * @returns {string}
 */
const formatUserMessage = (themes, content) => {
  const themeLines = Object.entries(themes).map(([name, meta]) => {
    const desc = meta?.description || "";
    const examples = Array.isArray(meta?.examples) && meta.examples.length
      ? ` Examples: ${meta.examples.join("; ")}.`
      : "";
    return `- ${name}: ${desc}${examples}`;
  });

  return [
    "Available themes:",
    themeLines.join("\n"),
    "",
    "Document to classify:",
    content,
  ].join("\n");
};

/**
 * Classify a markdown document into one of the provided themes.
 *
 * @async
 * @param {object} options
 * @param {string}   options.content    - The markdown document body.
 * @param {object}   [options.themes]   - Theme set as
 *   `{name: {description, examples?}}`. If missing or empty, no
 *   LLM call is made and theme is returned as `null`.
 * @param {string}   options.prompt     - System prompt content.
 * @param {Function} options.runLLM     - LLM call function.
 * @param {object}   options.llmConfig  - Provider config.
 * @param {number}   [options.maxRetries=2] - Retry budget.
 * @param {object}   [options.fallback] - Optional fallback result
 *   on exhaustion: `{theme, confidence, rationale}` shape.
 *
 * @returns {Promise<{theme: string|null, confidence: number|null, rationale: string}>}
 *
 * @example
 *   const themes = require("../../../themes.json");
 *   const { theme, confidence, rationale } = await classifyMarkdown({
 *     content: polishedMarkdown,
 *     themes,
 *     prompt: classifyPrompt,
 *     runLLM,
 *     llmConfig: HAIKU45_CONFIG,
 *   });
 */
const classifyMarkdown = async ({
  content,
  themes,
  prompt,
  runLLM,
  llmConfig,
  maxRetries = 2,
  fallback,
} = {}) => {
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("classifyMarkdown: content must be a non-empty string");
  }

  // Mode 1: No themes → no classification.
  if (!themes || typeof themes !== "object" || Object.keys(themes).length === 0) {
    return {
      theme:      null,
      confidence: null,
      rationale:  "no themes provided",
    };
  }

  // Mode 2: Themes provided → call the LLM.
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("classifyMarkdown: prompt must be a non-empty string");
  }

  const userMessage = formatUserMessage(themes, content);
  const validate    = buildValidator(themes);

  // System prompt → config.system. claude/run.js takes (config, prompt)
  // where prompt is the user message; the system prompt lives in config.
  const callConfig = { ...llmConfig, system: prompt };

  const raw = await runWithRetry({
    runLLM,
    config:  callConfig,
    prompt:  userMessage,
    validate,
    maxRetries,
    fallback,
  });

  // If runWithRetry returned the fallback (an object shaped like
  // {theme, confidence, rationale}), pass it through unchanged.
  // Otherwise the result is a Response envelope or string — parse it.
  if (raw && typeof raw === "object" && "theme" in raw) {
    return raw;
  }

  const parsed = parseJsonSafely(raw);
  return {
    theme:      parsed.theme,
    confidence: parsed.confidence,
    rationale:  parsed.rationale,
  };
};

// Helper exports for tests.
classifyMarkdown.unwrapText       = unwrapText;
classifyMarkdown.stripJsonFences  = stripJsonFences;
classifyMarkdown.parseJsonSafely  = parseJsonSafely;
classifyMarkdown.buildValidator   = buildValidator;
classifyMarkdown.formatUserMessage = formatUserMessage;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(classifyMarkdown, "classifyMarkdown", {
  value: classifyMarkdown,
}));