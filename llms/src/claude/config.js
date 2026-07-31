"use strict";

require("dotenv").config();
const Pricing = require("./Pricing");

// const apiKey = process.env.ANTHROPIC_API_KEY;
const apiKey = process.env.NEREUS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

/**
 * @constant
 * @readonly
 * @description
 * Per-model pricing rates (USD per 1M tokens, as of Jan 2025).
 *
 * | Model                        | Input    | Cache Write | Cache Read | Output   |
 * |------------------------------|----------|-------------|------------|----------|
 * | claude-opus-4-20250514       | $15.00   | $18.75      | $1.50      | $75.00   |
 * | claude-sonnet-4-20250514     | $3.00    | $3.75       | $0.30      | $15.00   |
 * | claude-sonnet-4-6            | $3.00    | $3.75       | $0.30      | $15.00   |
 * | claude-haiku-4-5-20251001    | $1.00    | $1.25       | $0.10      | $5.00    |
 *
 * **Cache write** is +25% over the standard input rate.
 * **Cache read** is -90% vs the standard input rate.
 * Caching becomes cost-positive from the third request onward for all models.
 *
 * @type {Object.<string, Pricing>}
 */
const PRICING = Object.freeze({
  "claude-opus-4-20250514":    new Pricing({ input: { standard: 15.00, cacheWrite: 18.75, cacheRead: 1.50 }, output: { standard: 75.00 },  batchDiscount: 0.50 }),
  "claude-sonnet-4-20250514":  new Pricing({ input: { standard:  3.00, cacheWrite:  3.75, cacheRead: 0.30 }, output: { standard: 15.00 },  batchDiscount: 0.50 }),
  "claude-sonnet-4-6":         new Pricing({ input: { standard:  3.00, cacheWrite:  3.75, cacheRead: 0.30 }, output: { standard: 15.00 },  batchDiscount: 0.50 }),
  "claude-haiku-4-5-20251001": new Pricing({ input: { standard:  1.00, cacheWrite:  1.25, cacheRead: 0.10 }, output: { standard:  5.00 },  batchDiscount: 0.50 }),
});

/**
 * @constant
 * @readonly
 * @description
 * Base configuration for **Claude Opus 4** (`claude-opus-4-20250514`).
 *
 * Highest capability model. Best for complex reasoning, nuanced writing,
 * and tasks where accuracy outweighs cost. Roughly 5× more expensive than
 * Sonnet 4 per token.
 *
 * @property {string}  model        - `"claude-opus-4-20250514"`
 * @property {number}  max_tokens   - `16000`
 * @property {number}  temperature  - `0.5`
 * @property {number}  pollInterval - `5000`
 * @property {Pricing} pricing      - See {@link PRICING} entry for this model.
 */
const OPUS4_CONFIG = Object.freeze({
  apiKey,
  model: "claude-opus-4-20250514",
  max_tokens: 16000,
  temperature: 0.5,
  pollInterval: 5000,
  maxRetries: 5,
  pricing: PRICING["claude-opus-4-20250514"]
});

/**
 * @constant
 * @readonly
 * @description
 * Base configuration for **Claude Sonnet 4.5** (`claude-sonnet-4-20250514`).
 *
 * Prior Sonnet generation. Use when targeting the stable 4.5 checkpoint
 * specifically. Same pricing as Sonnet 4.6.
 *
 * @property {string}  model        - `"claude-sonnet-4-20250514"`
 * @property {number}  max_tokens   - `20000`
 * @property {number}  temperature  - `0.65`
 * @property {number}  pollInterval - `5000`
 * @property {Pricing} pricing      - See {@link PRICING} entry for this model.
 */
const SONNET45_CONFIG = Object.freeze({
  apiKey,
  model: "claude-sonnet-4-20250514",
  max_tokens: 20000,
  temperature: 0.65,
  pollInterval: 5000,
  maxRetries: 5,
  pricing: PRICING["claude-sonnet-4-20250514"],
});

/**
 * @constant
 * @readonly
 * @description
 * Base configuration for **Claude Sonnet 4.6** (`claude-sonnet-4-6`).
 *
 * Latest Sonnet generation. Best price-to-performance for most production
 * workloads. Recommended default. Roughly 5× cheaper than Opus 4.
 *
 * @property {string}  model        - `"claude-sonnet-4-6"`
 * @property {number}  max_tokens   - `40000`
 * @property {number}  temperature  - `0.5`
 * @property {number}  pollInterval - `5000`
 * @property {Pricing} pricing      - See {@link PRICING} entry for this model.
 */
const SONNET46_CONFIG = Object.freeze({
  apiKey,
  model: "claude-sonnet-4-6",
  max_tokens: 40000,
  temperature: 0.5,
  thinking: { type: "disabled" },
  pollInterval: 5000,
  maxRetries: 5,
  pricing: PRICING["claude-sonnet-4-6"],
});

/**
 * @constant
 * @readonly
 * @description
 * Base configuration for **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`).
 *
 * Fastest and most cost-efficient model. Ideal for high-throughput, latency-sensitive
 * tasks such as classification, extraction, and summarisation at scale. Roughly
 * 4× cheaper than Sonnet 4 per input token.
 *
 * @property {string}  model        - `"claude-haiku-4-5-20251001"`
 * @property {number}  max_tokens   - `32000`
 * @property {number}  temperature  - `0.3`
 * @property {number}  pollInterval - `5000`
 * @property {Pricing} pricing      - See {@link PRICING} entry for this model.
 */
const HAIKU45_CONFIG = Object.freeze({
  apiKey,
  model: "claude-haiku-4-5-20251001",
  max_tokens: 32000,
  temperature: 0.3,
  pollInterval: 5000,
  maxRetries: 5,
  pricing: PRICING["claude-haiku-4-5-20251001"],
});

/**
 * @constant
 * @readonly
 * @description
 * Main configuration object for Claude API interactions.
 *
 * `DEFAULT_CONFIG` re-exports {@link SONNET46_CONFIG} as the application default and
 * attaches all named model configs and the shared `PRICING` table as sub-properties,
 * giving callers a single import path for any model.
 *
 * ---
 *
 * ### Model comparison
 *
 * | Config              | Model                      | Temp  | max_tokens | Best for                              |
 * |---------------------|----------------------------|-------|------------|---------------------------------------|
 * | `OPUS4_CONFIG`      | claude-opus-4-20250514     | 0.50  | 16 000     | Complex reasoning, high-stakes output |
 * | `SONNET46_CONFIG`   | claude-sonnet-4-6          | 0.50  | 40 000     | General production workloads (default)|
 * | `SONNET45_CONFIG`   | claude-sonnet-4-20250514   | 0.65  | 20 000     | Stable 4.5 checkpoint                 |
 * | `HAIKU45_CONFIG`    | claude-haiku-4-5-20251001  | 0.30  | 32 000     | High-throughput, low-latency tasks    |
 *
 * ### Pricing summary (USD / 1M tokens, as of Jan 2025)
 *
 * | Model        | Input  | Cache Write | Cache Read | Output  |
 * |--------------|--------|-------------|------------|---------|
 * | Opus 4       | $15.00 | $18.75      | $1.50      | $75.00  |
 * | Sonnet 4.5   | $3.00  | $3.75       | $0.30      | $15.00  |
 * | Sonnet 4.6   | $3.00  | $3.75       | $0.30      | $15.00  |
 * | Haiku 4.5    | $1.00  | $1.25       | $0.10      | $5.00   |
 *
 * @property {string}  apiKey            - Anthropic API key from `ANTHROPIC_API_KEY` env var.
 * @property {string}  model             - Active model identifier (defaults to Sonnet 4.6).
 * @property {number}  max_tokens        - Max response tokens for the default model.
 * @property {number}  temperature       - Sampling temperature for the default model.
 * @property {Pricing} pricing           - Pricing rates for the default (Sonnet 4.6) model.
 *
 * @property {Object}               OPUS4_CONFIG         - Full config for Claude Opus 4. See {@link OPUS4_CONFIG}.
 * @property {Object}               SONNET46_CONFIG      - Full config for Claude Sonnet 4.6. See {@link SONNET46_CONFIG}.
 * @property {Object}               SONNET45_CONFIG      - Full config for Claude Sonnet 4.5. See {@link SONNET45_CONFIG}.
 * @property {Object}               HAIKU45_CONFIG       - Full config for Claude Haiku 4.5. See {@link HAIKU45_CONFIG}.
 * @property {Object}               HAIKU45_PASS1_CONFIG - Full config for Haiku 4.5 pass 1. See {@link HAIKU45_PASS1_CONFIG}.
 * @property {Object}               HAIKU45_PASS2_CONFIG - Full config for Haiku 4.5 pass 2. See {@link HAIKU45_PASS2_CONFIG}.
 * @property {Object.<string, Pricing>} PRICING          - Shared pricing table for all models. See {@link PRICING}.
 */
const DEFAULT_CONFIG = {
  ...SONNET46_CONFIG
};
Object.defineProperty(DEFAULT_CONFIG, "OPUS4_CONFIG", { value: OPUS4_CONFIG });
Object.defineProperty(DEFAULT_CONFIG, "SONNET45_CONFIG", { value: SONNET45_CONFIG });
Object.defineProperty(DEFAULT_CONFIG, "SONNET46_CONFIG", { value: SONNET46_CONFIG });
Object.defineProperty(DEFAULT_CONFIG, "HAIKU45_CONFIG", { value: HAIKU45_CONFIG });
Object.defineProperty(DEFAULT_CONFIG, "PRICING", { value: PRICING });

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(DEFAULT_CONFIG, "DEFAULT_CONFIG", {
  value: DEFAULT_CONFIG
}));