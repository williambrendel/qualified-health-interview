/**
 * @file Conversation.js
 * @brief Multi-turn conversation container mirroring the Claude Messages API
 * messages array, with normalized turn construction and response continuation.
 */

"use strict";

const Content = require("./Content");

// ─────────────────────────────────────────────────────────────────────────────
// Turn
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @class Turn
 * @description Normalized single conversation turn. Wraps a `role` and
 * `content` into the shape expected by the Claude Messages API. User turns
 * with a prompt and optional documents are normalized to a `Content` instance.
 * Assistant turns carry a plain string. The object is plain and enumerable
 * so it serializes correctly when passed as a messages array entry.
 *
 * @param {string}              role    - `"user"` or `"assistant"`.
 * @param {string|Content|Array} content - Turn content. For user turns with
 *   documents, pass a `Content` instance. For assistant turns, a plain string.
 *
 * @property {string}          role
 * @property {string|Content}  content
 *
 * @example
 * new Turn("user", new Content("What is Legionella?", doc1));
 * new Turn("assistant", "Legionella is a genus of gram-negative bacteria...");
 */
class Turn {
  constructor(role, content) {
    this.role    = role;
    this.content = content;
  }
}

/**
 * @function Turn.create
 * @param {...*} args
 * @returns {Turn}
 */
Turn.create = (...args) => new Turn(...args);


// ─────────────────────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @class Conversation
 * @extends Array
 * @description Ordered collection of {@link Turn} instances mirroring the
 * Claude Messages API `messages` array. Extends `Array` so it can be passed
 * directly as the `messages` field in an API request.
 *
 * Accepts either a pre-built sequence of turns or a single user prompt with
 * optional documents — the same signature as `run()` — so `run()` can accept
 * either a `Conversation` or a raw `(prompt, ...documents)` call and normalize
 * via `new Conversation(promptOrConversation, ...documents)`.
 *
 * Turn normalization rules (via {@link Conversation.normalize}):
 * - `{ role, content }` plain object → wrapped in `Turn`, `content` left as-is.
 * - `Response`-like (with `output.text`) → `Turn("assistant", output.text)`.
 * - `string` / `Content` / spread documents → `Turn("user", new Content(...))`.
 *
 * @param {...(Turn|Object|string|Content|Response)} sources - Initial turns or
 *   a prompt + documents spread. Flattened and normalized via
 *   {@link Conversation.normalize}.
 *
 * @example
 * // Single prompt — mirrors run() signature
 * const conversation = new Conversation("What is Legionella?", doc1, doc2);
 *
 * @example
 * // Pre-built multi-turn
 * const conversation = new Conversation(
 *   { role: "user",      content: "What is Legionella?" },
 *   { role: "assistant", content: "Legionella is..." },
 *   { role: "user",      content: new Content("Based on this...", doc1) }
 * );
 *
 * @example
 * // Incremental construction
 * const conversation = new Conversation("What is Legionella?");
 * const response = await run(config, conversation);
 * conversation.continue(response, "What are the control measures?");
 * const response2 = await run(config, conversation);
 *
 * @example
 * // Direct use as messages array
 * const response = await client.messages.create({
 *   model: "claude-sonnet-4-6",
 *   max_tokens: 1024,
 *   messages: conversation
 * });
 */
class Conversation extends Array {
  constructor(...sources) {
    super();
    sources.length && this.push(...Conversation.normalize(...sources));
  }

  /**
   * @getter last
   * @description Returns the most recent {@link Turn} in the conversation.
   * Provides a convenient shorthand for accessing the tail of the messages
   * array without manual length calculations.
   *
   * @returns {Turn|undefined} The final turn in the collection, or `undefined`
   * if the conversation is empty.
   *
   * @example
   * const conversation = new Conversation("Hello!");
   * const lastTurn = conversation.last; // Accessed as a property
   * // lastTurn.role -> "user"
   */
  get last() {
    return this[this.length - 1];
  }

  /**
   * @method continue
   * @description Appends an assistant turn from a `Response` and a new user
   * turn in one atomic operation, guaranteeing strict role alternation.
   * Returns `this` for chaining.
   *
   * @param {Object}               response      - Response-like object with `output.text`.
   * @param {string|Content}       nextPrompt     - Next user prompt.
   * @param {...(string|Object)}   documents      - Optional documents for the next turn.
   * @returns {Conversation} `this`
   *
   * @example
   * conversation
   *   .continue(response1, "What are the control measures?")
   *   .continue(response2, "Summarize the key points.", doc1);
   */
  continue(response, nextPrompt, ...documents) {
    this.push(
      ...Conversation.normalize(response),
      ...Conversation.normalize(nextPrompt, ...documents)
    );
    return this;
  }
}

/**
 * @function Conversation.normalize
 * @description Normalizes variadic sources into an array of {@link Turn}
 * instances. Handles all input shapes:
 *
 * - **`{ role, content }`** — plain turn object, wrapped in `Turn` as-is.
 * - **Response-like** (has `output.text`) — `Turn("assistant", output.text)`.
 * - **`Turn`** — passed through unchanged.
 * - **`Conversation`** — flattened as-is (already `Turn` entries).
 * - **`string` / `Content` / spread with documents** — collected and wrapped
 *   as a single `Turn("user", new Content(prompt, ...documents))`.
 *
 * When the first non-turn argument is a string or `Content`, all remaining
 * arguments are treated as documents for that user turn.
 *
 * @param {...(Turn|Conversation|Object|string|Content)} sources
 * @returns {Turn[]}
 *
 * @example
 * Conversation.normalize({ role: "user", content: "Hello" });
 * // → [Turn("user", "Hello")]
 *
 * @example
 * Conversation.normalize(response);
 * // → [Turn("assistant", response.output.text)]
 *
 * @example
 * Conversation.normalize("Summarize this", doc1, doc2);
 * // → [Turn("user", Content("Summarize this", doc1, doc2))]
 */
Conversation.normalize = (...sources) => {
  const turns = [];
  let prompt = sources[0];

  // Pass through.
  if (prompt instanceof Content && sources.length === 1) {
    turns.push(new Turn("user", prompt));
    return turns;
  }

  // Normalize sources and prompt.
  sources = sources.flat(Infinity);
  prompt = sources[0];

  if (prompt && (
    typeof prompt === "string"
    || (
      typeof prompt === "object"
      && !(prompt instanceof Turn)
      && typeof prompt.role !== "string"
      && typeof prompt.output === "undefined"
    )
  )) {
    turns.push(new Turn("user", new Content(...sources)));
    return turns;
  }

  // Otherwise normalize each source individually.
  for (const source of sources) {
    if (!source) continue;

    // Pass-through.
    if (source instanceof Turn) {
      turns.push(source);
      continue;
    }

    // Response-like → assistant turn.
    if (typeof source?.output?.text === "string") {
      turns.push(new Turn("assistant", source.output.text));
      continue;
    }

    // Plain { role, content } object → wrap in Turn.
    if (typeof source?.role === "string" && source?.content !== undefined) {
      turns.push(new Turn(source.role, source.content));
      continue;
    }

    console.warn("Conversation.normalize: unrecognized source, skipping", source);
  }

  return turns;
};

/**
 * @function Conversation.create
 * @description Factory method. Equivalent to `new Conversation(...args)`.
 * @param {...*} args
 * @returns {Conversation}
 */
Conversation.create = (...args) => new Conversation(...args);

/**
 * @ignore
 * Turn exported on Conversation so callers import both from one path:
 *   const { Turn } = require("./Conversation");
 */
Conversation.Turn = Turn;

module.exports = Object.freeze(Object.defineProperty(Conversation, "Conversation", {
  value: Conversation
}));