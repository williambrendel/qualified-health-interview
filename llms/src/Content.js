/**
 * @file Content.js
 * @brief Normalized content container for Claude API message payloads.
 * Handles prompt and document serialization, cache control, and token
 * estimation statistics.
 */

"use strict";

const { getMediaType, json: JSON_MEDIA_TYPE, text: TEXT_MEDIA_TYPE, pdf: PDF_MEDIA_TYPE } = require("./utilities/getMediaType");

/**
 * @constant {RegExp} MATCH_RE
 * @description Unified segmentation regex that splits text into three mutually
 * exclusive token categories in a single pass:
 * - **Whitespace sequences** (`\s+`) — spaces, tabs, newlines grouped together.
 * - **Special characters** (`[^a-zA-Z0-9\s]`) — one at a time, each is typically
 *   a single BPE token. Captures ASCII punctuation, operators, sigils, and all
 *   non-ASCII characters including accented letters, CJK, and emoji.
 * - **Word sequences** (`[a-zA-Z0-9]+`) — contiguous alphanumeric runs, one per word.
 *
 * Replaces separate `SPACE_RE` and `SPECIAL_CHARS_RE` constants — a single
 * `.match()` call produces all three counts needed for token estimation.
 *
 * @example
 * "hello $world 🌊".match(MATCH_RE);
 * // → ["hello", " ", "$", "world", " ", "🌊"]
 */
const MATCH_RE = /\s+|[^a-zA-Z0-9\s]|[a-zA-Z0-9]+/g;

/**
 * @class Item
 * @description Normalizes a single content item — prompt text or document —
 * into the shape expected by the Claude Messages API. Handles plain strings,
 * plain objects, JSON-serializable objects, and binary Buffers (PDFs).
 *
 * Input normalization rules:
 * - **String** — used as-is, type `"text"`, media type `text/plain`.
 * - **Object with `data`** — `data` is the content; other keys are metadata.
 * - **Object without `data`** — the entire object (minus metadata keys) is
 *   treated as content and JSON-stringified.
 * - **Buffer** — serialized to base64 or UTF-8 depending on `type`, media
 *   type defaults to `application/pdf`.
 * - **Plain object (non-Buffer)** — JSON-stringified, media type defaults to
 *   `application/json`.
 *
 * Cache control:
 * - `cache_control` — passed through directly to the API payload.
 * - `enable_cache` / `enableCache` — shorthand that sets `{ type: "ephemeral" }`.
 * - For `"document"` items, `cache_control` is applied to `source.cache_control`.
 * - For `"text"` items, `cache_control` is applied as a top-level property.
 *
 * @param {string|Object} input - The content to normalize.
 * @param {*}         [input.data] - Explicit content payload. If absent, the
 *   remaining object keys are used as content.
 * @param {Object}    [input.cache_control] - Raw cache control object for the
 *   Claude API (e.g. `{ type: "ephemeral" }`).
 * @param {boolean}   [input.enable_cache] - Shorthand for ephemeral caching.
 *   Alias: `enableCache`.
 * @param {string}    [input.type] - Content type hint (`"text"`, `"base64"`).
 * @param {string}    [input.media_type] - MIME type override. Alias: `mediaType`.
 * @param {string}    [inputType="text"] - How to render this item in the API
 *   payload. `"document"` produces `{ type, source }`. Anything else produces
 *   `{ type: "text", text }`.
 *
 * @throws {Error} If the resolved content is empty after normalization.
 * @throws {Error} If JSON serialization of an object input fails.
 *
 * @property {boolean} isBinary             - True if content came from a Buffer.
 * @property {boolean} cacheEnabled         - Whether cache control is active.
 * @property {number}  size                 - Character count of the serialized payload string.
 * @property {number}  numBytes             - UTF-8 byte count of the raw content.
 *   For Buffers, equals `buffer.length`. For strings, computed via
 *   `Buffer.byteLength(str, "utf-8")` — correctly accounts for multi-byte
 *   Unicode characters (accented letters, CJK, emoji) that inflate token count
 *   beyond what character count alone captures.
 * @property {number}  numWords             - Alphanumeric word segment count.
 * @property {number}  numSpecialCharacters - Count of non-alphanumeric, non-whitespace
 *   characters. Includes ASCII punctuation, operators, sigils, and all non-ASCII
 *   characters. Each is estimated as 1 token in BPE tokenizers.
 * @property {number}  estimatedNumTokens   - Token count estimate using a three-term
 *   linear model: regular bytes at 4 bytes/token, whitespace bytes at 2 bytes/token,
 *   and special characters at 1 token each.
 * @property {Function} getSegments         - Returns raw segment array from `MATCH_RE`
 *   match. Closure over `rawText` — re-runs regex on each call.
 * @property {Function} toObject            - Returns a shallow copy of enumerable
 *   own properties as a plain object.
 *
 * @example
 * // Plain string — text item
 * new Item("What is Legionella?");
 * // → { type: "text", text: "What is Legionella?" }
 *
 * @example
 * // String — document item
 * new Item("Legionella control guide...", "document");
 * // → { type: "document", source: { type: "text", media_type: "text/plain", data: "..." } }
 *
 * @example
 * // Object with cache control
 * new Item({ data: "What is Legionella?", enableCache: true });
 * // → { type: "text", text: "...", cache_control: { type: "ephemeral" } }
 *
 * @example
 * // Buffer — PDF document
 * new Item({ data: pdfBuffer, type: "base64" }, "document");
 * // → { type: "document", source: { type: "base64", media_type: "application/pdf", data: "..." } }
 *
 * @example
 * // Plain object — JSON-serialized
 * new Item({ query: "Legionella", threshold: 0.7 });
 * // → { type: "text", text: '{"query":"Legionella","threshold":0.7}' }
 */
class Item {
  /**
   * @constructor Item
   * @description Normalizes a single content item into Claude API payload shape.
   * Resolves content from string, object, Buffer, or JSON-serializable input.
   * Applies cache control to the correct payload location depending on item type.
   * Computes size, word count, and special character count for token estimation.
   *
   * @param {string|Object} input - The content to normalize. Accepts:
   *   - **String** — used as-is, type `"text"`, media type `text/plain`.
   *   - **Object with `data`** — `data` is the content; other keys are metadata.
   *   - **Object without `data`** — entire object minus metadata keys is
   *     JSON-stringified; media type defaults to `application/json`.
   *   - **Buffer** — serialized to base64 or UTF-8 per `type`; media type
   *     defaults to `application/pdf`.
   * @param {*}       [input.data]           - Explicit content payload.
   * @param {Object}  [input.cache_control]  - Raw Claude API cache control object.
   * @param {boolean} [input.enable_cache]   - Shorthand for `{ type: "ephemeral" }`.
   *   Alias: `enableCache`.
   * @param {string}  [input.type]           - Content type hint (`"text"`, `"base64"`).
   * @param {string}  [input.media_type]     - MIME type override. Alias: `mediaType`.
   * @param {string}  [inputType]            - Render mode for the API payload.
   *   `"document"` → `{ type, source }`. Omit or any other value → `{ type: "text", text }`.
   *
   * @throws {Error} If resolved content is empty after normalization.
   * @throws {Error} Re-throws any error from JSON serialization or Buffer conversion.
   */
  constructor(input, inputType) {
    const source = {};
    let cache_control, enableCache, rawText = "", binary;
    input instanceof Content && (input = input.prompt);

    // Normalize input.
    if (typeof input === "object") {
      input || (input = {});

      // input is Item-like.
      input.source && input.type && (
        inputType || (inputType = input.type),
        input = input.source
      );

      // Get input data.
      const {
        text: _text,
        data = _text,
        cache_control: _cache_control,
        enable_cache,
        enableCache: _enableCache = enable_cache,
        type,
        media_type,
        mediaType = media_type,
        ...other
      } = input || {};
      cache_control = _cache_control;
      enableCache = _enableCache;

      // Get content.
      let text = data === undefined && other || data, md = mediaType;

      try {
        // Convert content if object.
        typeof text === "object" && (
          text = (
            text instanceof Buffer ? ( // if content is a buffer --> serialize it
              binary = text,
              md || (md = PDF_MEDIA_TYPE),
              type === "base64" && (
                rawText = text.toString("utf-8"),
                text.toString("base64")
              ) || (rawText = text.toString("utf-8"))
            ) : ( // if content is an object --> stringify it
              md || (md = JSON_MEDIA_TYPE),
              Object.keys(text || {}).length && JSON.stringify(text) || ""
            )
          )
        );
      } catch (error) {
        throw error;
      }

      source.data = text;
      source.type = type || "text";
      source.media_type = getMediaType(md || type, TEXT_MEDIA_TYPE);

    } else {
      // If input is plain text.
      source.data = `${input}`;
      source.type = "text";
      source.media_type = TEXT_MEDIA_TYPE;
    }

    if (!source.data) {
      throw Error("Input must NOT have empty content");
    }

    // Normalize caching option.
    const cacheControl = cache_control || (enableCache && { type: "ephemeral" });

    // Adjust props depending on the input type.
    inputType === "document" && (
      this.type = "document",
      cacheControl && (
        source.cache_control = cacheControl,
        Object.defineProperty(this, "cache_control", { value: cacheControl })
      ),
      this.source = source
    ) || (
      this.type = "text",
      this.text = source.data,
      cacheControl && (this.cache_control = cacheControl)
    );

    // If pure object access if required.
    Object.defineProperty(this, "toObject", { value: function() { return {...this} } });

    // For stats.
    rawText || (rawText = source.data);
    Object.defineProperty(this, "getSegments", { value: function() { return rawText.match(MATCH_RE) || [] } });
    const segments = this.getSegments();
    let numWords = 0, numSpecialCharacters = 0, numSpaceTokens = 0;
    for (let i = 0, l = segments.length, segment, c; i !== l; ++i) {
      (c = (segment = segments[i]).charCodeAt(0)) < 33 && (numSpaceTokens += segment.length)
      || ((c > 47 && c < 123 && (c > 96 || (c < 91 && ( c > 64 || c < 58)))) && (++numWords))
      || (++numSpecialCharacters)
    }
    const numBytes = binary && binary.length || Buffer.byteLength(rawText, "utf-8");
    Object.defineProperty(this, "isBinary", { value: !!binary });
    Object.defineProperty(this, "cacheEnabled", { value: !!cacheControl });
    Object.defineProperty(this, "size", { value: source.data.length });
    Object.defineProperty(this, "numBytes", { value: numBytes }),
    Object.defineProperty(this, "numWords", { value: numWords }),
    Object.defineProperty(this, "numSpecialCharacters", { value: numSpecialCharacters });
    Object.defineProperty(this, "estimatedNumTokens", {
      value: Math.ceil((numBytes - numSpecialCharacters - numSpaceTokens) / 4.0 + numSpaceTokens / 2.0 + numSpecialCharacters)
    });
  }
}

/**
 * @class Content
 * @extends Array
 * @description Ordered collection of normalized API content items — one prompt
 * followed by zero or more documents. Extends `Array` so it can be passed
 * directly as the `content` field in a Claude Messages API request.
 *
 * The first element is always the prompt (`Item` with type `"text"`). Subsequent
 * elements are document `Item` instances. Invalid documents are silently skipped
 * with a `console.warn` rather than throwing, so a partially valid document set
 * still produces a usable payload.
 *
 * Aggregate statistics across all items are exposed as non-enumerable properties
 * for use in token estimation and cost calculation.
 *
 * @param {...(string|Object|Array)} sources - Prompt followed by zero or more
 *   document inputs. The first element is the prompt; remaining elements are
 *   documents. Arrays are flattened at any depth before processing.
 *
 * @throws {Error} If `prompt` is falsy.
 *
 * @property {Item}    prompt            - The prompt item (first element).
 * @property {Item[]}  documents         - All document items (elements 1+).
 * @property {boolean} cacheEnabled      - True if any item has cache control.
 * @property {number}  numBytes          - Sum of UTF-8 byte counts across all items.
 * @property {number}  estimatedNumTokens - Sum of per-item token estimates.
 *   Suitable for pre-flight cost estimation before calling the API.
 *
 * @example
 * // Prompt only
 * const content = new Content("What is Legionella?");
 * content.length;      // → 1
 * content.prompt.text; // → "What is Legionella?"
 *
 * @example
 * // Prompt with documents
 * const content = new Content(
 *   "Summarize the key Legionella control measures",
 *   { data: guideText, enableCache: true },
 *   { data: pdfBuffer, type: "base64" }
 * );
 * content.length;          // → 3
 * content.cacheEnabled;    // → true
 * content.totalContentSize; // → sum of all char counts
 *
 * @example
 * // Factory method
 * const content = Content.create("What is Legionella?", doc1, doc2);
 *
 * @example
 * // Direct use as API content array
 * const response = await client.messages.create({
 *   model: "claude-sonnet-4-6",
 *   max_tokens: 1024,
 *   messages: [{ role: "user", content: content }]
 * });
 *
 * @example
 * // Token estimation from stats
 * const { numBytes, estimatedNumTokens } = content;
 * console.log(`~${estimatedNumTokens} tokens, ${numBytes} bytes`);
 */
class Content extends Array {
  /**
   * @constructor Content
   * @description Builds a normalized ordered content array from a prompt and
   * zero or more documents. Flattens nested document arrays, skips invalid
   * documents with a warning, and accumulates aggregate statistics across all
   * valid items.
   *
   * Construction order:
   * 1. Validates and normalizes `prompt` into a text `Item`.
   * 2. Flattens `documents` array to any depth.
   * 3. Normalizes each document into a document `Item`, skipping failures.
   * 4. Calls `super(prompt, ...documents)` to populate the Array.
   * 5. Defines non-enumerable stat properties and access getters.
   *
   * @param {...(string|Object|Array)} sources - Prompt followed by zero or more
   *   document inputs. The first element is the prompt; remaining elements are
   *   documents. Arrays are flattened at any depth before processing.
   *
   * @throws {Error} If `prompt` is falsy.
   * @throws {Error} If `prompt` normalization fails (propagated from `Item`).
   */
  constructor(...sources) {
    let [prompt, ...documents] = sources.flat(Infinity);

    if (!prompt) {
      throw Error("Input prompt must NOT be empty");
    }

    // Normalize prompt.
    prompt = new Item(prompt);

    // Collect stats.
    let cacheEnabled = prompt.cacheEnabled, numBytes = prompt.numBytes || 0, estimatedNumTokens = prompt.estimatedNumTokens || 0;

    // Documents.
    let j = 0;
    for (let i = 0, l = documents.length, document; i !== l; ++i) {
      try {
        document = documents[j] = new Item(documents[i], "document");
        cacheEnabled |= document.cacheEnabled;
        numBytes += document.numBytes || 0;
        estimatedNumTokens += document.estimatedNumTokens || 0;
        ++j;
      } catch (error) {
        console.warn(error);
      }
    }
    documents.length = j;

    super(prompt, ...documents);

    // For stats.
    Object.defineProperty(this, "cacheEnabled", { value: cacheEnabled });
    Object.defineProperty(this, "numBytes", { value: numBytes });
    Object.defineProperty(this, "estimatedNumTokens", { value: estimatedNumTokens });

    // For access.
    Object.defineProperty(this, "prompt", { get() { return this[0]; } });
    Object.defineProperty(this, "documents", { get() {
      if (this.length < 2) return [];
      const l = this.length - 1, docs = new Array(l);
      for (let i = 0; i !== l; i++) docs[i] = this[i + 1];
      return docs;
    } });

    // Define the toString for logging.
    Object.defineProperty(this, "toString", {
      value: function() {
        let str = "\n➡️  Input Content:\n─────────────────────────────────────\n";
        str += `\n   num content items: ${this.length}`;
        str += `\n   num content bytes: ${this.numBytes}`;
        str += `\n   estimated num tokens: ${this.estimatedNumTokens}`;
        str += `\n   cache enabled: ${this.cacheEnabled}\n`;
        return str;
      }
    });
  }
}

/**
 * @function Content.create
 * @description Factory method for creating a `Content` instance. Equivalent to
 * `new Content(...args)`. Useful where `new` cannot be used directly.
 *
 * @param {...*} args - Arguments forwarded to the `Content` constructor.
 * @returns {Content} A new `Content` instance.
 *
 * @example
 * const content = Content.create("What is Legionella?", doc1, doc2);
 */
Content.create = (...args) => new Content(...args);

/**
 * @ignore
 * Default export with freezing.
 */
Content.Item = Item;
module.exports = Object.freeze(Object.defineProperty(Content, "Content", {
  value: Content
}));