/**
 * @file Pricing.js
 * @brief Normalized pricing container for Claude API cost calculation.
 */

"use strict";

/**
 * @constant {Object} PRICING_DEFAULTS
 * @description Fallback rates used when a pricing field is absent. Values
 * reflect Sonnet 4.6 public pricing as of mid-2025.
 * @property {Object} input
 * @property {number} input.standard   - $3.00 / 1M uncached input tokens.
 * @property {number} input.cacheWrite - $3.75 / 1M cache-write tokens.
 * @property {number} input.cacheRead  - $0.30 / 1M cache-read tokens.
 * @property {Object} output
 * @property {number} output.standard  - $15.00 / 1M output tokens.
 * @property {number} batchDiscount    - 1.0 = no discount (safe fallback).
 */
const PRICING_DEFAULTS = Object.freeze({
  input:         Object.freeze({ standard: 3.00, cacheWrite: 3.75, cacheRead: 0.30 }),
  output:        Object.freeze({ standard: 15.00 }),
  batchDiscount: 1.0
});

/**
 * @typedef {Object} ItemizedCost
 * @property {number} uncachedInput - Cost of uncached input tokens.
 * @property {number} cacheRead     - Cost of cache-read tokens.
 * @property {number} cacheWrite    - Cost of cache-write tokens.
 * @property {number} output        - Cost of output tokens.
 * @property {number} total         - Sum of all cost components.
 */

/**
 * @class Pricing
 * @description Normalized container for Claude API token pricing rates.
 * Merges caller-provided rates over `PRICING_DEFAULTS` so partial overrides
 * are safe at any depth. Exposes a `cost(stat)` method that returns an
 * itemized breakdown, and a `toString` suitable for config logging.
 *
 * @param {Object} [data={}]                  - Pricing rates (all optional).
 * @param {Object} [data.input]               - Input token rates.
 * @param {number} [data.input.standard]      - Uncached input rate ($/1M tokens).
 * @param {number} [data.input.cacheWrite]    - Cache-write rate ($/1M tokens).
 * @param {number} [data.input.cacheRead]     - Cache-read rate ($/1M tokens).
 * @param {Object} [data.output]              - Output token rates.
 * @param {number} [data.output.standard]     - Output rate ($/1M tokens).
 * @param {number} [data.batchDiscount]       - Multiplier applied to all rates
 *   for batch requests. `0.5` = 50% off; `1.0` = no discount.
 *
 * @property {Object} input          - Resolved input rates.
 * @property {number} input.standard
 * @property {number} input.cacheWrite
 * @property {number} input.cacheRead
 * @property {Object} output         - Resolved output rates.
 * @property {number} output.standard
 * @property {number} batchDiscount  - Batch multiplier.
 *
 * @example
 * // Full override
 * const pricing = new Pricing({
 *   input:  { standard: 2.00, cacheWrite: 2.50, cacheRead: 0.20 },
 *   output: { standard: 10.00 },
 *   batchDiscount: 0.5
 * });
 *
 * @example
 * // Partial override — sibling rates filled from defaults
 * const pricing = new Pricing({ input: { standard: 2.00 } });
 * pricing.input.cacheWrite; // → 3.75
 * pricing.batchDiscount;    // → 1.0
 *
 * @example
 * // Cost calculation from a Stat
 * const cost = pricing.cost(stat);
 * // → { uncachedInput: 0.0024, cacheRead: 0, cacheWrite: 0, output: 0.003, total: 0.0054 }
 */
class Pricing {
  constructor(data) {
    const d = (typeof data === "object" && data) || {};

    this.input = {
      standard:   d.input?.standard   ?? PRICING_DEFAULTS.input.standard,
      cacheWrite: d.input?.cacheWrite ?? PRICING_DEFAULTS.input.cacheWrite,
      cacheRead:  d.input?.cacheRead  ?? PRICING_DEFAULTS.input.cacheRead
    };

    this.output = {
      standard: d.output?.standard ?? PRICING_DEFAULTS.output.standard
    };

    this.batchDiscount = d.batchDiscount ?? PRICING_DEFAULTS.batchDiscount;

    Object.defineProperty(this, "toString", {
      value: function() {
        return (
          `input:\n` +
          `  standard:   $${this.input.standard.toFixed(2)}/1M\n` +
          `  cacheWrite: $${this.input.cacheWrite.toFixed(2)}/1M\n` +
          `  cacheRead:  $${this.input.cacheRead.toFixed(2)}/1M\n` +
          `output:\n` +
          `  standard:   $${this.output.standard.toFixed(2)}/1M\n` +
          `batchDiscount: ${this.batchDiscount}`
        );
      }
    });

    /**
     * @method cost
     * @description Computes an itemized cost breakdown for a given `Stat`.
     * Applies the batch discount multiplier when `stat.succeeded` is present.
     *
     * @param {Stat} stat - Usage statistics to price.
     * @returns {ItemizedCost} Itemized cost object with a `total` field.
     *
     * @example
     * const { total, uncachedInput, cacheRead, output } = pricing.cost(stat);
     * console.log(`Estimated cost: $${total.toFixed(4)}`);
     */
    Object.defineProperty(this, "cost", {
      value: function(stat) {
        const discount         = stat.succeeded !== undefined ? this.batchDiscount : 1.0;
        const cacheReadTokens  = stat.cacheHit  ? (stat.cachedTokensRead    ?? 0) : 0;
        const cacheWriteTokens = stat.cacheMiss ? (stat.cachedTokensCreated ?? 0) : 0;

        const uncachedInput = ((stat.inputTokens  || 0) / 1_000_000) * this.input.standard   * discount;
        const cacheRead     = (cacheReadTokens     / 1_000_000)       * this.input.cacheRead  * discount;
        const cacheWrite    = (cacheWriteTokens    / 1_000_000)       * this.input.cacheWrite * discount;
        const output        = ((stat.outputTokens || 0) / 1_000_000)  * this.output.standard  * discount;

        return { uncachedInput, cacheRead, cacheWrite, output, total: uncachedInput + cacheRead + cacheWrite + output };
      }
    });

    // Freeze to prevent later changes.
    // Pricing are fixed and should not be change once declared.
    Object.freeze(this.input);
    Object.freeze(this.output);
    Object.freeze(this);
  }
}

/**
 * @function Pricing.create
 * @description Factory method. Equivalent to `new Pricing(data)`.
 * @param {...*} args
 * @returns {Pricing}
 */
Pricing.create = (...args) => new Pricing(...args);

/**
 * @ignore
 */
module.exports = Object.freeze(Object.defineProperty(Pricing, "Pricing", {
  value: Pricing
}));