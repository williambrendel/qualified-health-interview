/**
 * @file Stats.js
 * @brief Per-call statistics item and multi-call statistics collection with
 * per-source cost accumulation.
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// StatsItem
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @class StatsItem
 * @description Normalized statistics for a single Claude API call or batch.
 * Holds token counts, cache outcome, and timing for one call. An optional
 * `cost` method is stored non-enumerably — either a caller-supplied function
 * `(item, pricing) => ItemizedCost`, or defaulting to `pricing.cost(item)` if
 * the pricing object carries that method. Cost calculation is duck-typed —
 * no dependency on `Pricing`.
 *
 * @param {Object}   data
 * @param {string}   data.duration              - Elapsed time in seconds (e.g. `"1.23"`).
 * @param {number}   [data.inputTokens=0]       - Input tokens consumed.
 * @param {number}   [data.outputTokens=0]      - Output tokens generated.
 * @param {boolean}  [data.cache=false]         - Whether caching was active.
 * @param {boolean}  [data.cacheHit]            - `true` if served from cache.
 * @param {boolean}  [data.cacheMiss]           - `true` if a new cache entry was written.
 * @param {number}   [data.cachedTokensRead]    - Tokens read from cache on a hit.
 * @param {number}   [data.cachedTokensCreated] - Tokens written to cache on a miss.
 * @param {number}   [data.succeeded]           - Batch: successful request count.
 * @param {number}   [data.errored]             - Batch: errored request count.
 * @param {Object}   [data.pricing]             - Pricing object. If it carries a
 *   `cost(item)` method, used as the default cost function. Never stored
 *   directly — captured in the `cost` closure only.
 * @param {Function} [data.cost]                - Optional cost override. Called as
 *   `cost(item, pricing)` where `item` is this `StatsItem` and `pricing` is the
 *   pricing object. If absent, defaults to `pricing.cost.apply(pricing, [item])`.
 *   Stored non-enumerably as a no-arg method: `item.cost()`.
 *
 * @property {string}  duration
 * @property {number}  inputTokens
 * @property {number}  outputTokens
 * @property {boolean} cache
 * @property {boolean} [cacheHit]
 * @property {boolean} [cacheMiss]
 * @property {number}  [cachedTokensRead]
 * @property {number}  [cachedTokensCreated]
 * @property {number}  [succeeded]
 * @property {number}  [errored]
 *
 * @example
 * // Default cost via Pricing instance
 * const item = new StatsItem({
 *   duration: "1.23", inputTokens: 800, outputTokens: 200,
 *   cache: true, cacheHit: true, cachedTokensRead: 600,
 *   pricing: config.pricing
 * });
 * item.cost(); // → { uncachedInput, cacheRead, cacheWrite, output, total }
 *
 * @example
 * // Custom cost function
 * const item = new StatsItem({
 *   duration: "0.80", inputTokens: 400, outputTokens: 100,
 *   cost: (item, pricing) => ({ total: item.inputTokens * pricing.rate })
 * });
 */
class StatsItem {
  constructor(data) {
    const {
      duration,
      inputTokens       = 0,
      outputTokens      = 0,
      cache             = false,
      cacheHit,
      cacheMiss,
      cachedTokensRead,
      cachedTokensCreated,
      succeeded,
      errored,
      pricing,
      cost
    } = data || {};

    this.duration     = duration;
    this.inputTokens  = inputTokens;
    this.outputTokens = outputTokens;
    this.cache        = cache;

    cacheHit            !== undefined && (this.cacheHit            = cacheHit);
    cacheMiss           !== undefined && (this.cacheMiss           = cacheMiss);
    cachedTokensRead    !== undefined && (this.cachedTokensRead    = cachedTokensRead);
    cachedTokensCreated !== undefined && (this.cachedTokensCreated = cachedTokensCreated);
    succeeded           !== undefined && (this.succeeded           = succeeded);
    errored             !== undefined && (this.errored             = errored);

    // cost is a no-arg method closed over this item's pricing.
    // pricing itself is not stored — it lives only in this closure.
    const costFn = typeof cost === "function"
      && function() { return cost(this, pricing); }
      || (
        typeof pricing?.cost === "function"
        && function() { return pricing.cost.apply(pricing, [this]); }
      ) || null;

    costFn && Object.defineProperty(this, "cost", { value: costFn });

    // Object serializer.
    Object.defineProperty(this, "toString", {
      value: function() {
        const isBatch = this.succeeded !== undefined;
        const hasCost = typeof this.cost === "function";
        const cost    = hasCost && this.cost();

        let str = "\n💰 Token Usage:\n─────────────────────────────────────\n";
        str += `   Duration: ${this.duration}s\n`;

        if (isBatch) {
          str += `   Requests: ${this.succeeded} succeeded, ${this.errored} errored\n`;
        }

        const totalTokens = this.inputTokens + this.outputTokens;
        str += `   Input tokens:  ${this.inputTokens.toLocaleString()}\n`;
        str += `   Output tokens: ${this.outputTokens.toLocaleString()}\n`;
        str += `   Total tokens:  ${totalTokens.toLocaleString()}\n`;

        this.cacheHit  && (str += `   Cache hit  — ${(this.cachedTokensRead    || 0).toLocaleString()} tokens read\n`);
        this.cacheMiss && (str += `   Cache miss — ${(this.cachedTokensCreated || 0).toLocaleString()} tokens written\n`);

        if (hasCost && cost) {
          str += `   Estimated cost: $${cost.total.toFixed(4)}\n`;
          cost.uncachedInput && (str += `     Uncached input: $${cost.uncachedInput.toFixed(4)}\n`);
          cost.cacheRead     && (str += `     Cache read:     $${cost.cacheRead.toFixed(4)}\n`);
          cost.cacheWrite    && (str += `     Cache write:    $${cost.cacheWrite.toFixed(4)}\n`);
          cost.output        && (str += `     Output:         $${cost.output.toFixed(4)}\n`);
        }

        str += "─────────────────────────────────────\n";
        return str;
      }
    });

    // Json serializer.
    Object.defineProperty(this, "toJSON", {
      value: function() {
        const out = {
          duration: this.duration,
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
          cache: this.cache,
        };
        this.cacheHit            !== undefined && (out.cacheHit            = this.cacheHit);
        this.cacheMiss           !== undefined && (out.cacheMiss           = this.cacheMiss);
        this.cachedTokensRead    !== undefined && (out.cachedTokensRead    = this.cachedTokensRead);
        this.cachedTokensCreated !== undefined && (out.cachedTokensCreated = this.cachedTokensCreated);
        this.succeeded           !== undefined && (out.succeeded           = this.succeeded);
        this.errored             !== undefined && (out.errored             = this.errored);
        typeof this.cost === "function" && (out.cost = this.cost());
        return out;
      },
    });
  }
}

/**
 * @function StatsItem.create
 * @description Factory method. Equivalent to `new StatsItem(data)`.
 * @param {...*} args
 * @returns {StatsItem}
 */
StatsItem.create = (...args) => new StatsItem(...args);


// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @class Stats
 * @extends Array
 * @description Ordered collection of {@link StatsItem} instances representing
 * one or more Claude API calls. Extends `Array` so instances can be spread,
 * iterated, and passed directly where arrays are expected.
 *
 * Variadic constructor input is flattened to any depth — plain raw-data
 * objects, `StatsItem` instances, `Stats` collections, and Response-like
 * objects (with a `.stats` `StatsItem`) are all accepted and normalized to
 * `StatsItem` entries via {@link Stats.normalize}.
 *
 * `collapse()` reduces all items into a single aggregate {@link StatsItem}.
 * Cost is computed per-item by calling each item's own `cost()` method —
 * so mixed cache states (miss on call 1, hit on call 2+) and mixed models
 * are all priced correctly — then summed. `toString()` delegates entirely
 * to `collapse()`.
 *
 * @param {...(StatsItem|Stats|Object|Array)} sources - Initial sources,
 *   flattened to any depth.
 *
 * @example
 * // Single call
 * const stats = new Stats(rawData);
 * console.log(String(stats));
 *
 * @example
 * // Multiple responses in one shot
 * const stats = new Stats(response1, response2, response3);
 *
 * @example
 * // Merge two Stats collections
 * const merged = new Stats(stats1, stats2);
 *
 * @example
 * // Build incrementally
 * const stats = new Stats();
 * stats.push(...Stats.normalize(response1));
 * stats.push(...Stats.normalize(response2));
 *
 * @example
 * // Collapse to aggregate StatsItem
 * const item = stats.collapse();
 * console.log(`$${item.cost().total.toFixed(4)} for ${item.inputTokens} tokens`);
 *
 * @example
 * // Static accumulate
 * const stats = Stats.accumulate(response1, response2, response3);
 */
class Stats extends Array {
  constructor(...sources) {
    super();
    sources.length && this.push(...Stats.normalize(...sources));

    Object.defineProperty(this, "toString", {
      value: function() { return String(this.collapse()); }
    });
  }

  /**
   * @method collapse
   * @description Collapses all `StatsItem` entries into a single aggregate
   * `StatsItem`. Token counts and duration are summed. Cost is computed
   * per-item by calling each item's own `cost()` method, then summed —
   * so mixed cache states and mixed models are priced correctly. The returned
   * `StatsItem` is constructed with a pre-summed cost function that returns
   * the accumulated result directly.
   *
   * @returns {StatsItem}
   *
   * @example
   * const item = stats.collapse();
   * item.cost().total;  // → total cost across all calls
   * item.inputTokens;   // → total input tokens
   */
  collapse() {
    let inputTokens         = 0;
    let outputTokens        = 0;
    let duration            = 0;
    let cachedTokensRead    = 0;
    let cachedTokensCreated = 0;
    let cache     = false;
    let cacheHit  = false;
    let cacheMiss = false;
    let succeeded = 0, errored = 0, hasBatch = false;
    let cost = null;

    for (const item of this) {
      inputTokens  += item.inputTokens  || 0;
      outputTokens += item.outputTokens || 0;
      duration     += parseFloat(item.duration) || 0;
      cache         = cache     || !!item.cache;
      cacheHit      = cacheHit  || !!item.cacheHit;
      cacheMiss     = cacheMiss || !!item.cacheMiss;
      cachedTokensRead    += item.cachedTokensRead    || 0;
      cachedTokensCreated += item.cachedTokensCreated || 0;

      item.succeeded !== undefined && (
        hasBatch   = true,
        succeeded += item.succeeded || 0,
        errored   += item.errored   || 0
      );

      // Cost per item — each uses its own cost() so cache state and pricing
      // are correct for that specific call.
      if (typeof item.cost === "function") {
        const c = item.cost();
        cost || (cost = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 });
        cost.uncachedInput += c.uncachedInput || 0;
        cost.cacheRead     += c.cacheRead     || 0;
        cost.cacheWrite    += c.cacheWrite    || 0;
        cost.output        += c.output        || 0;
        cost.total         += c.total         || 0;
      }
    }

    // Capture summed cost in closure so the returned StatsItem's cost()
    // returns it directly without re-computing.
    const frozenCost = cost;

    return new StatsItem({
      duration: duration.toFixed(2),
      inputTokens,
      outputTokens,
      cache,
      ...(cache    && { cacheHit, cacheMiss, cachedTokensRead, cachedTokensCreated }),
      ...(hasBatch && { succeeded, errored }),
      ...(frozenCost && { cost: () => frozenCost })
    });
  }
}

/**
 * @function Stats.normalize
 * @description Flattens and normalizes variadic sources into an array of
 * `StatsItem` instances. Accepts `StatsItem`, `Stats` (flattened as-is since
 * `Stats` extends `Array`), plain raw-data objects, and Response-like objects
 * with a `.stats` property. Arrays are flattened to any depth.
 *
 * @param {...(StatsItem|Stats|Object|Array)} sources
 * @returns {StatsItem[]}
 */
Stats.normalize = (...sources) => {
  const items = [];
  for (const source of sources.flat(Infinity)) {
    if (!source) continue;
    const raw = source?.stats instanceof StatsItem ? source.stats : source;
    items.push(raw instanceof StatsItem ? raw : new StatsItem(raw));
  }
  return items;
};

/**
 * @function Stats.create
 * @description Factory method. Equivalent to `new Stats(...args)`.
 * @param {...*} args
 * @returns {Stats}
 */
Stats.create = (...args) => new Stats(...args);

/**
 * @function Stats.accumulate
 * @description Static accumulator. Equivalent to `new Stats(...sources)`.
 *
 * @param {...(StatsItem|Stats|Object|Array)} sources
 * @returns {Stats}
 *
 * @example
 * const stats = Stats.accumulate(response1, response2, response3);
 * const stats = Stats.accumulate(...responses);
 */
Stats.accumulate = (...sources) => new Stats(...sources);

/**
 * @ignore
 * StatsItem exported on Stats so callers import both from one path:
 *   const { StatsItem } = require("./Stats");
 */
Stats.StatsItem = StatsItem;

module.exports = Object.freeze(Object.defineProperty(Stats, "Stats", {
  value: Stats
}));