"use strict";

const vectorize = require("./vectorize");

/**
 * @file embedQuery.js
 * @brief Asymmetric query embedding for BGE-family retrieval encoders.
 *
 * Wraps `vectorize` with the BGE-v1.5 query-side instruction prefix so the
 * resulting embedding lands in the model's query subspace, properly aligned
 * with bare-text passage embeddings in the index. Passages are encoded
 * without a prefix; only the user query is prefixed.
 *
 * Idempotent. Calling `embedQuery` on a string that already begins with the
 * configured prefix does NOT double-prefix it — the existing prefix is
 * stripped and a single prefix is applied. This lets downstream callers
 * (a classifier, a logger, a debugger) pass through query strings without
 * having to track whether the prefix has already been added.
 *
 * @see https://huggingface.co/BAAI/bge-small-en-v1.5
 */

/**
 * @constant {string} QUERY_PREFIX
 * @brief BGE-v1.5 query-side instruction.
 *
 * Prepended to user queries at retrieval time. Must NOT be applied to
 * passages during ingestion — doing so collapses the query/passage
 * asymmetry the model was trained to exploit and degrades recall.
 */
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

/**
 * Escape regex-special characters in a string so it can be embedded in a
 * RegExp source as a literal. Used to build the dedup pattern from the
 * (caller-supplied) prefix.
 */
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @function embedQuery
 * @brief Embed a user query for cosine-similarity retrieval.
 *
 * Prepends the BGE query instruction to @p userQuery (if not already
 * present) and forwards the resulting string to `vectorize`. The returned
 * vector is in the query subspace and is intended to be compared against
 * bare-text passage vectors stored in the knowledge base.
 *
 * Idempotency. If `userQuery` begins with one or more copies of `prefix`,
 * they are ALL stripped before a single prefix is applied. This handles
 * accidental nesting (e.g. `embedQuery(embedQuery_input)`, or any other
 * pipeline layering where the string passes through more than one
 * prefixing stage). The result is always exactly one prefix at the head.
 *
 * @param {string} userQuery
 *   The user query. May or may not already include any number of leading
 *   `prefix` copies. Leading and trailing whitespace is trimmed; internal
 *   whitespace is preserved.
 * @param {string} [prefix=QUERY_PREFIX]
 *   Override for the instruction prefix. Defaults to the BGE-v1.5
 *   instruction. Override only if switching to a different encoder
 *   family with a different query convention (e.g. E5's "query: ").
 * 
 * @param {string} [encode=vectorize]
 *   Encoder to embed the query.
 *
 * @returns {Promise<Float32Array>}
 *   Resolves to the query embedding. Dimensionality matches the
 *   underlying encoder (384 for bge-small-en-v1.5).
 *
 * @example
 *   const queryVec = await embedQuery("bugs keep coming back after shock");
 *
 * @example <caption>Idempotent — all three produce the same vector</caption>
 *   const a = await embedQuery("how do I prevent scale?");
 *   const b = await embedQuery(`${embedQuery.QUERY_PREFIX}how do I prevent scale?`);
 *   const c = await embedQuery(`${embedQuery.QUERY_PREFIX}${embedQuery.QUERY_PREFIX}how do I prevent scale?`);
 *   // a, b, and c are identical: any leading prefix run is collapsed to one.
 */
const embedQuery = (userQuery, prefix = QUERY_PREFIX, encode = vectorize) => {
  userQuery = (userQuery || "").trim();

  // Collapse any leading run of `prefix` copies down to zero. We strip
  // them all here, then re-apply exactly one below. Using a regex with
  // `+` (one-or-more) handles arbitrary nesting in a single pass, no
  // matter how many layers of accidental re-prefixing the string went
  // through. The prefix may be empty (the caller-override case); the
  // guard avoids building a zero-length regex which would match the
  // empty string infinitely.
  prefix && (
    userQuery = userQuery.replace(new RegExp(`^(?:${escapeRegex(prefix)})+`), "").trim()
  );
  return encode(`${prefix || ""}${userQuery}`);
};

// Expose the prefix on the function so callers can detect or inspect it
// without re-importing the constant. This is the same pattern other
// modules in the codebase use for their self-referential properties.
embedQuery.QUERY_PREFIX = QUERY_PREFIX;

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(embedQuery, "embedQuery", {
  value: embedQuery,
}));