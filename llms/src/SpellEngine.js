"use strict";

/**
 * @file SpellEngine.js
 * @brief Spell-correction engine for user query strings. Normalizes
 * punctuation, applies a corrections dictionary, and uses a Hunspell-based
 * spell checker to fix misspelled words while preserving punctuation,
 * numbers, and whitespace.
 */

const nspell = require("nspell");

// ─────────────────────────────────────────────────────────────────────────────
// Module-level regexes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @constant {RegExp} SPACE_RE
 * @ignore
 * Matches one or more whitespace characters for internal whitespace
 * normalization within non-word tokens.
 */
const SPACE_RE = /\s+/g;

/**
 * @constant {RegExp} SPLIT_PUNC_RE
 * @ignore
 * Capturing split pattern that isolates word tokens from non-word tokens.
 * A "word" is a sequence of 2+ letters optionally containing mid-word
 * apostrophes (e.g. `don't`), or a single letter.
 */
const SPLIT_PUNC_RE = /([a-zA-Z][a-zA-Z']*[a-zA-Z]|[a-zA-Z])/;

/**
 * @constant {RegExp} TEST_WORD_RE
 * @ignore
 * Tests whether a token begins with a letter — only such tokens are
 * eligible for spell correction.
 */
const TEST_WORD_RE = /^[a-zA-Z]/;

/**
 * @constant {RegExp} RE_NORM_PUNC
 * @ignore
 * Normalizes irregular punctuation:
 * - Repeated `,` `!` `?` → single character
 * - `....` or `..` → `...`
 * - `_` or `~` → `-`
 * - `--` or more → `—`
 */
const RE_NORM_PUNC = /([,!?])\1+|\.{4,}|\.{2}|[_~]|--+/g;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const normalizePunctuation = str => str.replace(RE_NORM_PUNC, (match, char) => (
  char ? char :
  (match[0] === "." && "...") ||
  (match[0] === "-" && "—") ||
  "-"
));

const splitWords = text =>
  (text || "").trim()
    .split(SPLIT_PUNC_RE)
    .filter(x => x)
    .map(x => x.replace(SPACE_RE, " "));

// ─────────────────────────────────────────────────────────────────────────────
// SpellEngine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @class SpellEngine
 * @description Spell-correction engine for user query strings. Accepts a
 * pre-loaded `nspell` dictionary instance and any number of augmentation
 * sources — arrays of domain words to add to the dictionary, and plain
 * objects mapping lowercase misspellings to their corrections.
 *
 * Sources are processed left-to-right. Later correction objects override
 * earlier ones on key conflict. Domain word arrays are additive — all words
 * from all array sources are added to the dictionary.
 *
 * Use {@link SpellEngine.createEnglish} for the common case of loading the
 * standard English dictionary asynchronously. Use {@link SpellEngine.create}
 * when you already hold a loaded `nspell` instance (e.g. in tests).
 *
 * @param {Object}    dic        - A pre-initialized `nspell` instance.
 * @param {...(string[]|Object)} sources - Augmentation sources:
 *   - **`string[]`** — words added to the dictionary via `dic.add()`.
 *   - **`Object`**   — corrections map merged into the internal lookup
 *     table. Keys are lowercase misspellings; values are replacements.
 *
 * @example
 * // Via async factory (typical usage)
 * const engine = await SpellEngine.createEnglish(domainWords, corrections);
 * engine.correct("teh quikc brwon fox");
 * // → "the quick brown fox"
 *
 * @example
 * // Via sync factory (test usage with mock dic)
 * const engine = SpellEngine.create(mockDic, { teh: "the" });
 * engine.correct("teh");
 * // → "the"
 *
 * @example
 * // Multiple interleaved sources
 * const engine = await SpellEngine.createEnglish(
 *   domainWords,    // string[] from JSON
 *   corrections,    // {} from JSON
 *   extraWords,     // string[]
 *   overrides       // {}
 * );
 */
class SpellEngine {
  /**
   * @param {...(string|string[]|Object|Object[])} sources - Domain word arrays and/or
   *   corrections objects, applied left-to-right.
   */

  #dic;
  #corrections = new Map;

  constructor(...sources) {
    sources = sources.flat(Infinity);
    const dic = new Set, dics = [];

    for (const source of sources) {
      if (!source) continue;

      if (typeof source === "object") {
        if (source instanceof Set || typeof source.add === "function") {
          const arr = Array.from(source);
          for (let i = 0, l = arr.length; i !== l; ++i) {
            dic.add(arr[i]);
          }
          continue;
        }

        if (source instanceof Map) {
          source.forEach((v, k) => this.#corrections.set(k, v));
          continue;
        }

        // Check if source is already a normalized dictionary.
        const { dic: _dic, aff } = source;
        if (_dic && aff && typeof _dic === "object" && typeof aff === "object" || source instanceof nspell) {
          dics.push(source);
          continue;
        }

        for (const k in source) this.#corrections.set(k, source[k]);
      } else typeof source === "string" && dic.add(source);
    }

    this.#dic = nspell(dics.length && dics || {
      aff: Buffer.from("SET UTF-8\n"),
      dic: Buffer.from("0\n")
    });
    dic.size && (this.#dic.personal(Array.from(dic).join("\n")));

    Object.freeze(this);
  }

  /**
   * @method correct
   * @description Corrects spelling in a query string. Normalizes punctuation
   * first, then tokenizes and corrects each word token. Non-word tokens
   * (punctuation, numbers, whitespace) are passed through unchanged.
   *
   * Correction priority:
   * 1. Falsy input — returned as-is immediately.
   * 2. Punctuation normalization applied to whole string.
   * 3. CORRECTIONS lookup (case-insensitive key match).
   * 4. `nspell.correct()` — if already correct, returned as-is.
   * 5. `nspell.suggest()[0]` — first suggestion, or original if none.
   *
   * @param {string} query - Raw user query string.
   * @returns {string} Corrected query, or original value if falsy.
   *
   * @example
   * engine.correct("teh quikc brwon fox");
   * // → "the quick brown fox"
   *
   * @example
   * engine.correct("too many commas,,,");
   * // → "too many commas,"
   *
   * @example
   * engine.correct(null);
   * // → null
   */
  correct(query) {
    if (!query) return query;

    query = normalizePunctuation(query);

    return splitWords(query).map(part => {
      if (!TEST_WORD_RE.test(part)) return part;
      const correction = this.#corrections.get(part.toLowerCase());
      if (correction !== undefined) return correction;
      return this.#dic.correct(part) ? part : this.#dic.suggest(part)[0] || part;
    }).join("");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Static factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @function SpellEngine.create
 * @description Sync factory. Equivalent to `new SpellEngine(dic, ...sources)`.
 * Use when you already hold a loaded `nspell` instance (e.g. in tests or when
 * loading a non-English dictionary manually).
 *
 * @param {...(string|string[]|Object|Object[])} sources - Augmentation sources.
 * @returns {SpellEngine}
 *
 * @example
 * const engine = SpellEngine.create(mockDic, { teh: "the" }, domainWords);
 */
SpellEngine.create = (...sources) => new SpellEngine(...sources);

/**
 * @function SpellEngine.createEnglish
 * @description Async factory that loads the standard English dictionary
 * (`dictionary-en`) and returns a new `SpellEngine` augmented with the
 * provided sources. This is the typical production entry point.
 *
 * @param {...(string|string[]|Object|Object[])} sources - Augmentation sources applied
 *   left-to-right. Arrays add words to the dictionary; objects are merged
 *   into the corrections lookup.
 * @returns {Promise<SpellEngine>}
 *
 * @example
 * const engine = await SpellEngine.createEnglish(domainWords, corrections);
 *
 * @example
 * // No augmentation
 * const engine = await SpellEngine.createEnglish();
 *
 * @example
 * // Multiple interleaved sources
 * const engine = await SpellEngine.createEnglish(
 *   wordsA, correctionsA, wordsB, correctionsB
 * );
 */
SpellEngine.createEnglish = async (...sources) => {
  const dic = (await import("dictionary-en")).default;
  return new SpellEngine(dic, ...sources);
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * @ignore
 */
module.exports = Object.freeze(Object.defineProperty(SpellEngine, "SpellEngine", {
  value: SpellEngine
}));
