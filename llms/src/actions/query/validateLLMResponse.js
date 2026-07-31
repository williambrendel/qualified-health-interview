"use strict";

/**
 * @file validateLLMResponse.js
 * @module actions/query/validateLLMResponse
 * @description Shape validation for the second-pass reasoning LLM's
 * output. Defines the query pipeline's contract for what a valid
 * synthesized response looks like.
 *
 * Lives under `src/actions/query/` rather than `src/xenova/` because the
 * validator has nothing to do with embedding/transformer models —
 * it validates JSON shape against a contract defined by the query
 * endpoint. The serializer that produces the LLM's INPUT lives
 * under `xenova/` (see {@link serializeQueryContext}) because its
 * inputs are xenova-domain (analyzer output, search hits); this
 * validator works on the LLM's OUTPUT, which is pure query-domain
 * data.
 *
 * The new output shape (sections-only, no parts breakdown):
 *
 *     {
 *       "answer": [
 *         { "text": "string",
 *           "source": { "documentId": "string", "range": [start, end] } },
 *         { "text": "string" }
 *       ],
 *       "followUpQuestions": ["string", "string", "string"]
 *     }
 *
 * ## What it returns
 *
 * `{ valid: boolean, errors: string[] }` — never throws on
 * malformed input. The caller's retry loop reads `.valid`;
 * logging reads `.errors` to see exactly what was wrong.
 *
 *     const result = validateLLMResponse(llmOut);
 *     if (!result.valid) {
 *       console.warn("LLM output invalid:", result.errors.join(", "));
 *       // retry, fall back, etc.
 *     }
 *
 * ## Why detailed errors
 *
 * During prompt iteration, the LLM produces malformed output
 * occasionally — wrong field names, missing source fields, ranges
 * as strings instead of arrays. A simple boolean tells us "bad"
 * but not "what's bad," forcing manual inspection of the JSON
 * each time. The detailed errors point straight at the problem
 * so prompt fixes can be targeted.
 *
 * ## What gets validated
 *
 *   - Top-level structure: object, has `answer` (non-empty array)
 *     and `followUpQuestions` (array, possibly empty).
 *   - Each answer chunk: object with non-empty `text`; optional
 *     `source` that, when present, must have valid `documentId`
 *     (non-empty string) and `range` ([int, int] with end >= start).
 *   - Each follow-up question: non-empty string.
 *
 * Anything not in this list is NOT validated — extra fields are
 * tolerated. The LLM may include diagnostic or reasoning fields
 * we didn't ask for; we ignore them.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plain-object check. Excludes arrays and null. Used in places
 * where we want to confirm "this is a JSON object, not an array
 * or scalar."
 *
 * @param {*} v
 * @returns {boolean}
 */
const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Non-empty string check. Whitespace-only strings are NOT
 * considered valid — a chunk with `text: "   "` has no content
 * for the user to read, and we don't want the LLM filling slots
 * with whitespace to satisfy a validator.
 *
 * @param {*} v
 * @returns {boolean}
 */
const isNonEmptyString = (v) =>
  typeof v === "string" && v.trim().length > 0;

/**
 * Validate a `source` object on an answer chunk. Returns an array
 * of error messages — empty when valid.
 *
 * @param {*} source - Value of `chunk.source`.
 * @param {string} chunkPath - Path prefix for error messages,
 *   e.g. "answer[2].source".
 * @returns {string[]}
 */
const validateSource = (source, chunkPath) => {
  const errors = [];

  if (!isPlainObject(source)) {
    errors.push(`${chunkPath} must be an object`);
    return errors;
  }

  if (!isNonEmptyString(source.documentId)) {
    errors.push(`${chunkPath}.documentId must be a non-empty string`);
  }

  if (!Array.isArray(source.range) || source.range.length !== 2) {
    errors.push(`${chunkPath}.range must be a two-element array [start, end]`);
    return errors;  // can't validate elements if shape is wrong
  }

  const [start, end] = source.range;

  if (!Number.isInteger(start) || start < 0) {
    errors.push(`${chunkPath}.range[0] must be a non-negative integer (got ${start})`);
  }
  if (!Number.isInteger(end) || end < 0) {
    errors.push(`${chunkPath}.range[1] must be a non-negative integer (got ${end})`);
  }
  // Order check only runs if both are valid integers — avoids
  // a noisy "end < start" error stacked on top of "start is not
  // an integer" when the real problem is the type.
  if (Number.isInteger(start) && Number.isInteger(end) && end < start) {
    errors.push(`${chunkPath}.range[1] (${end}) must be >= range[0] (${start})`);
  }

  return errors;
};

/**
 * Validate a single answer chunk. Returns an array of error
 * messages — empty when valid.
 *
 * @param {*} chunk
 * @param {number} index - Position in `answer` array.
 * @returns {string[]}
 */
const validateChunk = (chunk, index) => {
  const errors = [];
  const chunkPath = `answer[${index}]`;

  if (!isPlainObject(chunk)) {
    errors.push(`${chunkPath} must be an object`);
    return errors;
  }

  if (!isNonEmptyString(chunk.text)) {
    errors.push(`${chunkPath}.text must be a non-empty string`);
  }

  // source is optional. Only validate when present. Use
  // hasOwnProperty so an explicit `source: undefined` is treated
  // as absent (not as "I tried to set a source but it broke").
  if ("source" in chunk && chunk.source !== undefined) {
    errors.push(...validateSource(chunk.source, `${chunkPath}.source`));
  }

  return errors;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate the second-pass LLM's response shape.
 *
 * Returns a result object — never throws, even on null/undefined
 * input. The result has:
 *
 *   - `valid` (boolean): `true` when all checks passed.
 *   - `errors` (string[]): list of error messages, empty when
 *     valid. Multiple errors accumulate — we don't short-circuit
 *     on the first failure, so the caller sees the full picture
 *     of what's wrong.
 *
 * ## Why we collect all errors instead of failing fast
 *
 * During prompt iteration, the LLM may produce output with
 * several issues at once (missing field + bad range type + empty
 * answer chunk). Reporting just the first failure forces multiple
 * iteration cycles to discover them all. Reporting all at once
 * lets us fix the prompt comprehensively in one pass.
 *
 * @function validateLLMResponse
 * @param {*} response - Parsed JSON from the LLM. May be null,
 *   undefined, primitive, array, or object — all handled gracefully.
 * @returns {{valid: boolean, errors: string[]}}
 *
 * @example <caption>Valid response</caption>
 *   validateLLMResponse({
 *     answer: [
 *       { text: "Biofilm forms when...", source: { documentId: "x", range: [0, 100] } },
 *       { text: "The matrix protects..." }
 *     ],
 *     followUpQuestions: ["How fast does biofilm grow?"]
 *   });
 *   // → { valid: true, errors: [] }
 *
 * @example <caption>Invalid response — missing field</caption>
 *   validateLLMResponse({ answer: [{ text: "..." }] });
 *   // → { valid: false, errors: ["followUpQuestions must be an array"] }
 *
 * @example <caption>Invalid response — multiple errors</caption>
 *   validateLLMResponse({
 *     answer: [{ text: "" }, { text: "ok", source: { documentId: "x", range: "bad" } }],
 *     followUpQuestions: ["", "valid"]
 *   });
 *   // → {
 *   //     valid: false,
 *   //     errors: [
 *   //       "answer[0].text must be a non-empty string",
 *   //       "answer[1].source.range must be a two-element array [start, end]",
 *   //       "followUpQuestions[0] must be a non-empty string"
 *   //     ]
 *   //   }
 */
const validateLLMResponse = (response) => {
  const errors = [];

  // Top-level structure.
  if (!isPlainObject(response)) {
    errors.push("response must be an object");
    return { valid: false, errors };  // can't drill further
  }

  // answer must be a non-empty array.
  if (!Array.isArray(response.answer)) {
    errors.push("answer must be an array");
  } else if (response.answer.length === 0) {
    errors.push("answer must contain at least one chunk");
  } else {
    // Validate each chunk. All errors accumulate.
    for (let i = 0; i < response.answer.length; i++) {
      errors.push(...validateChunk(response.answer[i], i));
    }
  }

  // followUpQuestions must be an array, but may be empty.
  // Empty is acceptable for conversational responses, off-topic
  // dismissals, or any case where no follow-ups make sense.
  if (!Array.isArray(response.followUpQuestions)) {
    errors.push("followUpQuestions must be an array");
  } else {
    for (let i = 0; i < response.followUpQuestions.length; i++) {
      if (!isNonEmptyString(response.followUpQuestions[i])) {
        errors.push(`followUpQuestions[${i}] must be a non-empty string`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
};

// Helper exports for callers/tests that want piece-by-piece access.
validateLLMResponse.validateChunk  = validateChunk;
validateLLMResponse.validateSource = validateSource;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(validateLLMResponse, "validateLLMResponse", {
  value: validateLLMResponse,
}));
