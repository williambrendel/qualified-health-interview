/**
 * @file Config.js
 * @brief Configuration container with variadic deep merge, hidden API key,
 * and safe serialization support.
 */

"use strict";

const formatObject = require("./utilities/object/formatObject");
const deepAssign   = require("./utilities/object/deepAssign");

/**
 * @class Config
 * @description Immutable-friendly configuration container for Claude API clients.
 * Accepts any number of config objects and deep-merges them left-to-right
 * (rightmost wins), mirroring `Object.assign` semantics for scalars and
 * recursing into nested plain objects (e.g. `pricing`) to preserve sibling
 * keys. The API key is hidden from enumeration and serialization, and a `safe`
 * getter exposes a logging-safe view with `apiKey` omitted.
 *
 * Key behaviors:
 * - **Variadic merge** — all `...configs` are deep-merged left-to-right via
 *   `deepAssign`. Later sources override earlier ones for scalar keys; plain
 *   objects (including `pricing`) are recursed so partial overrides preserve
 *   sibling keys at every depth.
 * - **Hidden API key** — `apiKey` is stored as a non-enumerable,
 *   non-configurable own property via `Object.defineProperty`. It never
 *   appears in `toString`, `JSON.stringify`, or `for...in` iteration.
 * - **Safe config** — the `safe` getter returns a new `Config` instance built
 *   from the merged config with `apiKey` already excluded, suitable for
 *   logging or passing to untrusted consumers.
 * - **toString** — returns a human-readable string representation of all
 *   enumerable config properties formatted via `formatObject`, prefixed with
 *   a header line. Never includes `apiKey`.
 *
 * @param {...Object} configs - Config objects merged left-to-right. All keys
 *   are optional; recognized keys are listed below. Unknown keys pass through.
 *
 * @param {string}   [configs[].apiKey]           - API key. Non-enumerable after construction.
 * @param {string}   [configs[].model]            - Model ID, e.g. `"claude-sonnet-4-6"`.
 * @param {number}   [configs[].max_tokens]       - Maximum tokens per request.
 * @param {number}   [configs[].temperature]      - Sampling temperature (0–1).
 * @param {string[]} [configs[].stop_sequences]   - Sequences that stop generation.
 * @param {boolean}  [configs[].stream]           - Enable streaming responses.
 * @param {string|Array} [configs[].system]       - System prompt string or content array.
 * @param {Object}   [configs[].thinking]         - Extended thinking config,
 *   e.g. `{ type: "enabled", budget_tokens: 5000 }`.
 * @param {Array}    [configs[].tools]            - Tool definitions array.
 * @param {Object}   [configs[].tool_choice]      - Tool choice policy object.
 * @param {string}   [configs[].service_tier]     - Service tier identifier.
 * @param {Object}   [configs[].metadata]         - Request metadata passthrough.
 * @param {string}   [configs[].container_id]     - Container ID for stateful sessions.
 * @param {Object}   [configs[].context_management] - Context management config.
 * @param {number}   [configs[].pollInterval]     - Polling interval in ms (batch/async).
 * @param {Object}   [configs[].pricing]          - Pricing overrides, deep-merged over
 *   earlier sources. Shape: `{ input: { standard, cacheWrite, cacheRead },
 *   output: { standard }, batchDiscount }`.
 *
 * @example
 * // Variadic — three sources, rightmost wins on conflict
 * const config = new Config(
 *   { max_tokens: 500, temperature: 0.7 },
 *   { max_tokens: 1000 },
 *   { apiKey: "sk-..." }
 * );
 * config.max_tokens;  // → 1000
 * config.temperature; // → 0.7
 * config.apiKey;      // → "sk-..." (accessible but non-enumerable)
 *
 * @example
 * // Deep pricing merge — partial override preserves sibling rates
 * const config = new Config(
 *   { pricing: { input: { standard: 3.00, cacheWrite: 3.75, cacheRead: 0.30 }, batchDiscount: 0.5 } },
 *   { pricing: { input: { standard: 2.00 } } }
 * );
 * config.pricing;
 * // → { input: { standard: 2.00, cacheWrite: 3.75, cacheRead: 0.30 }, batchDiscount: 0.5 }
 *
 * @example
 * // Generation params
 * const config = new Config({
 *   model:          "claude-sonnet-4-6",
 *   max_tokens:     4096,
 *   temperature:    0.5,
 *   stop_sequences: ["\n\nHuman:"],
 *   stream:         true,
 *   system:         "You are a helpful assistant.",
 *   thinking:       { type: "enabled", budget_tokens: 5000 },
 * });
 *
 * @example
 * // Safe config — no apiKey
 * const config = new Config({ apiKey: "sk-..." });
 * console.log(config.safe.apiKey); // → undefined
 * console.log(String(config.safe)); // never prints apiKey
 *
 * @example
 * // Factory method
 * const config = Config.create(defaults, overrides);
 */
class Config {
  constructor(...configs) {
    configs = configs.flat(Infinity).filter(Boolean);

    // Deep-merge all sources left-to-right; later sources win on conflict.
    const merged = deepAssign({}, ...configs);

    // Extract and hide apiKey before assigning enumerable props.
    const { apiKey, ...rest } = merged;

    apiKey && Object.defineProperty(this, "apiKey", { value: apiKey });

    // Extract cost calculation method.
    let cost = merged.pricing?.cost;
    for (let i = configs.length - 1; i >= 0 && !cost; --i) cost = configs[i].pricing?.cost;

    // Assign all remaining non-null, non-undefined values.
    for (const k in rest) {
      const v = rest[k];
      v !== undefined && v !== null && (this[k] = v);
    }

    // Assign cost if needed.
    cost && this.pricing && typeof this.pricing.cost !== "function" && (
      Object.defineProperty(this.pricing, "cost", {
        value:        function(...args) { return cost.apply(this, args); },
        enumerable:   false,
        writable:     false,
        configurable: false
      })
    );

    // Safe getter — new Config from the apiKey-free merged object.
    Object.defineProperty(this, "safe", { get() {
      return apiKey && (
        cost && rest.pricing && typeof rest.pricing.cost !== "function" &&
          Object.defineProperty(rest.pricing, "cost", {
            value:        function(...args) { return cost.apply(this, args); },
            enumerable:   false,
            writable:     false,
            configurable: false
          }),
        new Config(rest)
      ) || this;
    } });

    // toString for logging.
    Object.defineProperty(this, "toString", {
      value: function() {
        return "\n⚙️  Config:\n─────────────────────────────────────\n" + formatObject(this, 3);
      }
    });
  }
}

/**
 * @function Config.create
 * @description Factory method for creating a `Config` instance. Equivalent to
 * `new Config(...args)`. Useful for functional composition patterns where
 * `new` cannot be used directly.
 *
 * @param {...Object} args - Config objects forwarded to the `Config` constructor.
 * @returns {Config} A new `Config` instance.
 *
 * @example
 * const config = Config.create(defaults, overrides, patch);
 */
Config.create = (...args) => new Config(...args);

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(Config, "Config", {
  value: Config
}));