/**
 * @file Response.js
 * @brief Normalized response container for Claude API results.
 */

"use strict";

const parseResponseJson = require("./utilities/parseResponseJson");
const Stats             = require("./Stats");
const { StatsItem }     = Stats;

/**
 * @function toStats
 * @private
 * @description Coerces any stats-shaped value into a `StatsItem` or `Stats`
 * instance. Pass-through for already-normalized instances.
 *
 * @param {StatsItem|Stats|Object|Array} stats
 * @returns {StatsItem|Stats}
 */
const toStats = stats =>
  stats instanceof StatsItem || stats instanceof Stats ? stats
  : Array.isArray(stats)                               ? new Stats(...stats)
  :                                                      new StatsItem(stats);

/**
 * @class Response
 * @description Normalized envelope for a Claude API response. Holds the safe
 * config, full conversation (including the assistant reply appended by
 * `run()`), API output, and usage statistics. Each component owns its own
 * `toString` so `String(response)` composes a full diagnostic log by
 * delegation with no duplication.
 *
 * `output.json()` parses the text response as JSON, delegating to
 * `parseResponseJson` and swallowing errors as `null` — so callers can test
 * the return value directly without additional error handling.
 *
 * Print order in `toString`:
 * 1. Response header — stop reason, caching flag.
 * 2. `config.toString()` — model, parameters, pricing.
 * 3. Last user turn content — item count, byte size, token estimate.
 * 4. `stats.toString()` — token usage, cache outcome, itemized cost.
 *
 * @param {Object}                   data
 * @param {string}                   [data.id]         - Optional request identifier (e.g. batch custom_id).
 * @param {Config}                   data.config       - Safe (apiKey-free) resolved config.
 * @param {Conversation}             data.conversation - Full conversation including
 *   the assistant reply appended by `run()`.
 * @param {Object}                   data.output          - API output.
 * @param {boolean}                  data.output.success  - `true` on successful call.
 * @param {string}                   [data.output.text]   - Concatenated text response.
 * @param {string}                   [data.output.error]  - Error message on failure.
 * @param {string}                   [data.output.stopped]- Stop reason, e.g. `"end_turn"`.
 * @param {StatsItem|Stats|Object|Array} data.stats    - Usage statistics. Plain objects
 *   are wrapped in `StatsItem`; arrays are wrapped in `Stats`.
 *
 * @property {string}          [id]
 * @property {Config}          config
 * @property {Conversation}    conversation
 * @property {Object}          output
 * @property {StatsItem|Stats} stats
 *
 * @example
 * const response = await run(config, "What is Legionella?");
 * console.log(response.output.text);
 * console.log(response.output.json());
 * console.log(String(response));
 *
 * @example
 * // Continue a conversation
 * response.conversation.continue(response, "What are the control measures?");
 * const response2 = await run(config, response.conversation);
 *
 * @example
 * // Accumulate stats across calls
 * const stats = new Stats(response1, response2);
 * console.log(String(stats));
 */
class Response {
  constructor({ id, config, input, conversation, output, stats }) {
    for (let i = conversation.length - 1; i >= 0 && !input; --i) {
      conversation[i].role === "user" && (input = conversation[i].content);
    }
    id !== undefined && (this.id = id);
    this.config       = config;
    this.conversation = conversation;
    this.stats        = toStats(stats);
    this.input        = input;

    // Build output with non-enumerable json() method.
    this.output = { ...output };
    Object.defineProperty(this.output, "json", {
      value: function() {
        try { return parseResponseJson(this.text); }
        catch { return null; }
      }
    });

    // For loggin.
    Object.defineProperty(this, "toString", {
      value: function() {
        // Collapse Stats to StatsItem for cache flag; StatsItem used directly.
        const collapsed = this.stats instanceof StatsItem
          ? this.stats
          : this.stats.collapse();

        const { stopped } = this.output;

        // Last user turn content for input stats.
        const content = this.input;

        let str = "\n✅ Response received\n";
        stopped && (str += `${stopped === "end_turn" ? "✅" : "⚠️ "} Stopped: ${stopped}\n`);
        collapsed.cache && (str += "⚡ Caching: ENABLED\n");

        str += String(this.config);
        content && (str += String(content));
        str += String(this.stats);

        return str;
      }
    });
  }
}

/**
 * @function Response.create
 * @description Factory method. Equivalent to `new Response(data)`.
 * @param {...*} args
 * @returns {Response}
 */
Response.create = (...args) => new Response(...args);

/**
 * @ignore
 */
module.exports = Object.freeze(Object.defineProperty(Response, "Response", {
  value: Response
}));