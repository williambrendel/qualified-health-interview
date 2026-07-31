/**
 * @file parseResponseJson.js
 * @brief JSON extraction from raw LLM text output.
 */

/**
 * @function parseResponseJson
 * @description
 * Parses the first complete JSON value from an LLM response, handling
 * common model output quirks and accepting either a raw text string or
 * a Response envelope from `src/claude/run.js`.
 *
 * **Input shapes accepted:**
 *
 * 1. **Plain string** — the raw text body of an LLM response.
 *
 * 2. **Response envelope** — an object with `.output.text` containing
 *    the text body. This is what `src/claude/run.js` returns. We unwrap
 *    to the text body and continue. Putting this fallback here keeps
 *    callers from having to write `response?.output?.text ?? response`
 *    at every site that wants JSON from a Claude response.
 *
 * **Model output quirks handled:**
 *
 * 1. **Markdown code fences** — the model sometimes wraps output in
 *    ` ```json ``` ` or ` ``` ``` `. Fences are stripped before extraction.
 *
 * 2. **Trailing text** — the model sometimes appends reasoning or commentary
 *    after the JSON (e.g. `[] **Reasoning:** the section has no facts`). Only
 *    the first complete JSON value is extracted; trailing content is discarded.
 *
 * @param {string|object} text - Raw text string OR a Response envelope
 *   with `.output.text`.
 * @returns {*} Parsed JSON value (object, array, etc.).
 * @throws {SyntaxError} If `JSON.parse` fails after extraction.
 * @throws {TypeError}   If `input` is neither a string nor a Response-shaped
 *   object with a `.output.text` string.
 *
 * @example <caption>Plain string</caption>
 * parseResponseJson('{"key":"value"}');
 * // → { key: "value" }
 *
 * @example <caption>Response envelope</caption>
 * parseResponseJson({ output: { text: '[{"a":1}]' } });
 * // → [{ a: 1 }]
 *
 * @example <caption>Strips fences</caption>
 * parseResponseJson('```json\n[{"a":1}]\n```');
 * // → [{ a: 1 }]
 *
 * @example <caption>Discards trailing commentary</caption>
 * parseResponseJson('[{"a":1}]\n\n**Reasoning:** ...');
 * // → [{ a: 1 }]
 */
const parseResponseJson = text => {

  // Pre-parsed object/array (no `output.text` to unwrap) → pass through.
  if (text && typeof text === "object" && !(text.output && typeof text.output.text === "string")) {
    return text;
  }

  // Response envelope → unwrap to its text body.
  text && typeof text === "object" && (text = text?.output?.text);
  if (!text) return null;
  if (typeof text !== "string") {
    throw new TypeError(
      "parseResponseJson: expected a string or a Response-shaped object with .output.text"
    );
  }

  // Strip markdown code fences the model sometimes wraps around JSON output.
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trimStart();

  // Extract the first complete JSON value, discarding any trailing text the
  // model appends after the JSON (e.g. "[] **Reasoning:** ...").
  const opener = stripped[0];
  let clean = stripped;
  if (opener === "[" || opener === "{") {
    const closer = opener === "[" ? "]" : "}";
    let depth = 0, inString = false, escape = false;
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped[i];
      if (escape)        { escape = false; continue; }
      if (ch === "\\")   { escape = true;  continue; }
      if (ch === '"')    { inString = !inString; continue; }
      if (inString)      continue;
      if (ch === opener) depth++;
      else if (ch === closer) {
        if (--depth === 0) { clean = stripped.slice(0, i + 1); break; }
      }
    }
  }

  try {
    return JSON.parse(clean);
  } catch (err) {
    console.error(`🚨 Failed to parse JSON:\n${clean.slice(0, 500)}`);
    throw err;
  }
};

/**
 * @ignore
 */
module.exports = Object.freeze(Object.defineProperty(parseResponseJson, "parseResponseJson", {
  value: parseResponseJson,
}));