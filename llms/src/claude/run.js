/**
 * @file run.js
 * @brief Single-request orchestrator for the Claude Messages API.
 */

"use strict";

const Anthropic             = require("@anthropic-ai/sdk").default;
const normalizeConfig       = require("./normalizeConfig");
const { Conversation, Turn} = require("../Conversation");
const Content               = require("../Content");
const Response              = require("../Response");
const { StatsItem }         = require("../Stats");

/**
 * @function run
 * @async
 * @description Sends a single prompt (with optional documents) or a pre-built
 * `Conversation` to the Claude Messages API and returns a normalized
 * {@link Response} envelope.
 *
 * Responsibilities:
 * - Merges caller config over `DEFAULT_CONFIG` via `normalizeConfig`.
 * - Accepts either `(config, prompt, ...documents)` or
 *   `(config, conversation)` — normalizes both to a `Conversation`.
 * - Validates the last turn is a user turn with non-empty content.
 * - Attaches the `"prompt-caching-2024-07-31"` beta header when any content
 *   item in the last user turn requests caching.
 * - Strips non-API config keys (`pollInterval`, `pricing`) before the SDK
 *   call; `pricing` is forwarded to the `StatsItem` for cost reporting.
 * - Appends the assistant reply to the conversation before returning so
 *   `response.conversation` is the complete exchange ready for continuation.
 * - Returns a `Response` holding the safe config, full conversation,
 *   output, and a `StatsItem`.
 *
 * @param {Object|Config}                config
 * @param {string|Content|Conversation}  promptOrConversation
 * @param {...(string|Object|Array)}      documents
 *
 * @returns {Promise<Response>}
 *
 * @throws {Error} If `config.apiKey` is absent.
 * @throws {Error} If the conversation is empty or last turn is not user.
 * @throws {Error} If the last user turn content has zero bytes.
 * @throws {Error} Re-throws any Anthropic SDK error.
 *
 * @example
 * // Single prompt
 * const response = await run(config, "What is Legionella?");
 * console.log(response.output.text);
 * console.log(response.output.json());
 * console.log(String(response));
 *
 * @example
 * // Single prompt with documents
 * const response = await run(config, "Summarize this:", doc1, doc2);
 *
 * @example
 * // Pre-built conversation
 * const response = await run(config, conversation);
 *
 * @example
 * // Multi-turn loop
 * const r1 = await run(config, "What is Legionella?");
 * r1.conversation.continue(r1, "What are the control measures?");
 * const r2 = await run(config, r1.conversation);
 *
 * @example
 * // Accumulate stats across calls
 * const stats = new Stats(r1, r2);
 * console.log(String(stats));
 */
const run = async (config, promptOrConversation, ...documents) => {
  const startTime = Date.now();

  // Normalize and split config — apiKey goes to the client, safe copy to Response.
  config = normalizeConfig(config);
  const clientConfig = { apiKey: config.apiKey };
  const safeConfig   = config.safe;

  if (!clientConfig.apiKey) {
    const error = "ANTHROPIC_API_KEY not set — create a .env file with: ANTHROPIC_API_KEY=your_key";
    console.error("🚨 Error:", error);
    throw Error(error);
  }

  // Normalize input to a Conversation.
  const conversation = promptOrConversation instanceof Conversation
    ? promptOrConversation
    : new Conversation(promptOrConversation, ...documents);

  if (!conversation.length) {
    const error = "Conversation must have at least one turn";
    console.error("🚨 Error:", error);
    throw Error(error);
  }

  const lastTurn = conversation.last;
  if (lastTurn.role !== "user") {
    const error = "Last conversation turn must be a user turn";
    console.error("🚨 Error:", error);
    throw Error(error);
  }

  // Extract Content from last user turn for cache detection and byte validation.
  const content = lastTurn.content instanceof Content
    ? lastTurn.content
    : new Content(lastTurn.content);

  if (!content.numBytes) {
    const error = "Last user turn content is empty";
    console.error("🚨 Error:", error);
    throw Error(error);
  }

  // Enable caching header if any item in the last turn requests it.
  content.cacheEnabled && (
    clientConfig.defaultHeaders = { "anthropic-beta": "prompt-caching-2024-07-31" }
  );

  // Strip non-API props before sending — mirrors run.js.
  const { pollInterval, onPoll, pricing, maxRetries, ...modelParams } = safeConfig;
  maxRetries && (clientConfig.maxRetries = maxRetries);

  const client = new Anthropic(clientConfig);

  // Strip non-API props before sending.
  modelParams.messages = conversation;

  // Call API.
  const apiResponse = await client.messages.create(modelParams);

  // Timing.
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  // Cache outcome.
  const cacheReadTokens  = apiResponse.usage.cache_read_input_tokens     || 0;
  const cacheWriteTokens = apiResponse.usage.cache_creation_input_tokens || 0;
  const cacheStats       = content.cacheEnabled ? {
    cacheHit:            cacheReadTokens  > 0,
    cacheMiss:           cacheWriteTokens > 0,
    cachedTokensRead:    cacheReadTokens,
    cachedTokensCreated: cacheWriteTokens,
  } : {};

  // Collect text response.
  const text = apiResponse.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n");

  // Append assistant reply so response.conversation is the complete exchange.
  conversation.push(new Turn("assistant", text));

  return new Response({
    config:       safeConfig,
    input:        content,
    conversation,
    output: {
      success: true,
      text,
      stopped: apiResponse.stop_reason || false,
    },
    stats: new StatsItem({
      duration,
      inputTokens:  apiResponse.usage.input_tokens  || 0,
      outputTokens: apiResponse.usage.output_tokens || 0,
      cache:        content.cacheEnabled,
      ...cacheStats,
      pricing,
    }),
  });
};

/**
 * @ignore
 */
module.exports = Object.freeze(Object.defineProperty(run, "run", {
  value: run
}));