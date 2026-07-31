"use strict";

const Config = require("../Config");
const DEFAULT_CONFIG = require("./config");

/**
 * @function normalizeConfig
 * @description
 * Deep-merges one or more partial config objects over `DEFAULT_CONFIG`,
 * producing a fully resolved `Config` instance. Sources are applied
 * left-to-right (rightmost wins on conflict); plain objects such as
 * `pricing` are recursed so partial overrides preserve sibling keys.
 * Non-object sources are ignored by `Config`.
 *
 * @param {...Object} configs                        - Partial config objects to merge over defaults.
 * @param {string}   [configs[].apiKey]              - Anthropic API key. Non-enumerable after construction.
 * @param {string}   [configs[].model]              - Model identifier, e.g. `"claude-sonnet-4-6"`.
 * @param {number}   [configs[].max_tokens]          - Maximum tokens to generate.
 * @param {number}   [configs[].temperature]         - Sampling temperature (0.0–1.0).
 * @param {string[]} [configs[].stop_sequences]      - Sequences that halt generation.
 * @param {boolean}  [configs[].stream]              - Enable streaming responses.
 * @param {string|Array} [configs[].system]          - System prompt string or content array.
 * @param {Object}   [configs[].thinking]            - Extended thinking config,
 *   e.g. `{ type: "enabled", budget_tokens: 5000 }`.
 * @param {Array}    [configs[].tools]               - Tool definitions array.
 * @param {Object}   [configs[].tool_choice]         - Tool choice policy object.
 * @param {string}   [configs[].service_tier]        - Service tier identifier.
 * @param {Object}   [configs[].metadata]            - Request metadata passthrough.
 * @param {string}   [configs[].container_id]        - Container ID for stateful sessions.
 * @param {Object}   [configs[].context_management]  - Context management config.
 * @param {number}   [configs[].pollInterval]        - Polling interval in ms (batch/async).
 * @param {Object}   [configs[].pricing]             - Pricing overrides, deep-merged over
 *   earlier sources. Shape: `{ input: { standard, cacheWrite, cacheRead },
 *   output: { standard }, batchDiscount }`.
 *
 * @returns {Config} Fully resolved config with all defaults populated.
 *
 * @example
 * // Single override
 * const resolved = normalizeConfig({ temperature: 0.2 });
 * // resolved.model       === DEFAULT_CONFIG.model
 * // resolved.temperature === 0.2
 *
 * @example
 * // Multiple overrides — rightmost wins on conflict
 * const resolved = normalizeConfig(modelPreset, { apiKey: "sk-...", max_tokens: 2048 });
 *
 * @example
 * // Partial pricing override — sibling rates preserved from DEFAULT_CONFIG
 * const resolved = normalizeConfig({ pricing: { input: { standard: 2.00 } } });
 */
const normalizeConfig = (...configs) => new Config(DEFAULT_CONFIG, ...configs);

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(normalizeConfig, "normalizeConfig", {
  value: normalizeConfig
}));