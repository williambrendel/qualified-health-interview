"use strict";

const Anthropic             = require('@anthropic-ai/sdk').default;
const normalizeConfig       = require("./normalizeConfig");
const { Conversation, Turn} = require("../Conversation");
const Content               = require("../Content");
const Response              = require("../Response");
const { StatsItem }         = require("../Stats");
const Spinner               = require("../utilities/spinner");

/**
 * @function batch
 * @async
 * @description
 * Submits a batch of requests to the Anthropic Message Batches API at 50% cost,
 * polls with smart backoff until completion, and returns an array of {@link Response}
 * objects in the same order as the input requests — mirroring the envelope returned
 * by run().
 *
 * @param {Object}   config                        - Same config as run(), plus batch options.
 * @param {string}   config.apiKey                 - Anthropic API key. Required.
 * @param {number}   [config.pollInterval=5000]    - Initial polling interval in ms.
 * @param {Function} [config.onPoll]               - Called each poll with batch status object.
 * @param {...(Object|Array)} requests             - Variadic list of request objects or arrays.
 *   Each request: { id: string, prompt: string|Object|Conversation, documents?: Array }
 *   id must be unique within the batch. Arrays are flattened automatically.
 *
 * @returns {Promise<Response[]>} Array of Response objects in same order as requests.
 */
const batch = async (config, ...requests) => {
  const startTime = Date.now();
  
  // Flatten requests (support nested arrays)
  requests = requests.flat(Infinity);
  
  // Early exit: no requests to process
  if (requests.length === 0) {
    console.log("  No requests to process — skipping batch");
    return [];
  }

  // Validate unique IDs before any API calls
  const seenIds = new Set();
  for (const req of requests) {
    if (!req.id) {
      throw new Error("Each batch request must have a unique 'id' field");
    }
    if (seenIds.has(req.id)) {
      throw new Error(`Duplicate batch request ID: ${req.id}`);
    }
    seenIds.add(req.id);
  }

  // Normalize config and split — apiKey goes to the client, safe copy to Response.
  config = normalizeConfig(config);
  const apiKey     = config.apiKey;
  const safeConfig = config.safe;

  // Strip non-API props before sending — mirrors run.js.
  const { pollInterval = 5000, onPoll, pricing, maxRetries, ...modelParams } = safeConfig;

  if (!apiKey) {
    const error = "ANTHROPIC_API_KEY not set — create a .env file with: ANTHROPIC_API_KEY=your_key";
    console.error("🚨 Error:", error);
    throw new Error(error);
  }

  const client = new Anthropic({ apiKey, maxRetries });

  // Build Content and Conversation per request — preserve original order
  const prepared = requests.map(({ id, prompt, documents = [] }) => {
    const conversation = new Conversation(prompt, ...documents);
    const lastTurn = conversation.last;
    const content = lastTurn.content instanceof Content
      ? lastTurn.content
      : new Content(lastTurn.content);
    return { id, conversation, content };
  });

  // Build batch API payload — spread full modelParams so system, tools,
  // stop_sequences, tool_choice, thinking, etc. are all forwarded, then
  // override messages per-request (mirrors run.js).
  const batchRequests = prepared.map(({ id, conversation }) => ({
    custom_id: id,
    params: { ...modelParams, messages: conversation },
  }));

  // Submit batch
  console.log(`  Submitting batch with ${requests.length} request${requests.length === 1 ? '' : 's'}...`);
  const batchJob = await client.beta.messages.batches.create({ requests: batchRequests });
  const batchId = batchJob.id;
  console.log(`  Batch submitted: ${batchId}`);

  // Poll with smart backoff until completion
  let status = batchJob;
  let interval = pollInterval;
  let attempts = 0;
  const maxAttempts = 180; // ~15 minutes at 5s base interval
  const minInterval = 2000;
  const maxInterval = 30000;
  const spinner = Spinner.create("Batching...").start();
  
  while (status.processing_status !== "ended" && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, interval));
    
    try {
      status = await client.beta.messages.batches.retrieve(batchId);
      onPoll?.(status);
      attempts++;
      
      if (status.processing_status === "ended") break;
      
      // Dynamic interval adjustment based on batch progress
      const remaining = status.request_counts?.processing || Infinity;
      if (remaining < 10) {
        interval = Math.max(minInterval, interval * 0.8);
      } else if (remaining > 100) {
        interval = Math.min(maxInterval, interval * 1.2);
      } else {
        interval = Math.min(maxInterval, Math.max(minInterval, interval));
      }
      
    } catch (error) {
      ++attempts;
      interval = Math.min(maxInterval, interval * 1.5);
      console.warn(`  Polling error (attempt ${attempts + 1}):`, error.message);
      
      if (attempts > 10) {
        throw new Error(`Batch polling failed after ${attempts} attempts: ${error.message}`);
      }
    }
  }
  
  spinner.stop();
  
  if (status.processing_status !== "ended") {
    throw new Error(`Batch polling timed out after ${maxAttempts} attempts. Batch ID: ${batchId}`);
  }
  
  console.log(`  Batch completed: ${batchId}`);

  // Collect results into a map for O(1) lookup
  const resultsById = new Map();
  
  for await (const result of await client.beta.messages.batches.results(batchId)) {
    resultsById.set(result.custom_id, result);
  }

  // Verify all requests have results
  const missingIds = prepared.filter(p => !resultsById.has(p.id)).map(p => p.id);
  if (missingIds.length > 0) {
    console.warn(`  Warning: ${missingIds.length} request${missingIds.length === 1 ? '' : 's'} missing results:`, missingIds);
  }

  // Build responses in original order
  const responses = [];
  
  for (const { id, conversation, content } of prepared) {
    const result = resultsById.get(id);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    if (!result) {
      responses.push(new Response({
        id,
        config: safeConfig,
        input: content,
        conversation,
        output: {
          success: false,
          error: `No result received for request ${id}`,
        },
        stats: new StatsItem({
          duration,
          inputTokens: 0,
          outputTokens: 0,
          cache: false,
          succeeded: 0,
          errored: 1,
          pricing,
        }),
      }));
      continue;
    }

    if (result.result.type === "succeeded") {
      const msg = result.result.message;
      const inputTokens = msg.usage.input_tokens || 0;
      const outputTokens = msg.usage.output_tokens || 0;
      const cachedTokensRead = msg.usage.cache_read_input_tokens || 0;
      const cachedTokensCreated = msg.usage.cache_creation_input_tokens || 0;

      const text = msg.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");

      conversation.push(new Turn("assistant", text));

      const cacheStats = content.cacheEnabled ? {
        cacheHit: cachedTokensRead > 0,
        cacheMiss: cachedTokensCreated > 0,
        cachedTokensRead,
        cachedTokensCreated,
      } : {};

      responses.push(new Response({
        id,
        config: safeConfig,
        input: content,
        conversation,
        output: {
          success: true,
          text,
          stopped: msg.stop_reason || false,
        },
        stats: new StatsItem({
          duration,
          inputTokens,
          outputTokens,
          cache: content.cacheEnabled,
          ...cacheStats,
          succeeded: 1,
          errored: 0,
          pricing,
        }),
      }));
    } else {
      responses.push(new Response({
        id,
        config: safeConfig,
        input: content,
        conversation,
        output: {
          success: false,
          error: result.result.error?.message || result.result.type || "Unknown error",
        },
        stats: new StatsItem({
          duration,
          inputTokens: 0,
          outputTokens: 0,
          cache: false,
          succeeded: 0,
          errored: 1,
          pricing,
        }),
      }));
    }
  }

  // Log summary statistics
  const succeeded = responses.filter(r => r.output.success).length;
  const failed = responses.length - succeeded;
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
  
  console.log(`  Batch complete: ${succeeded} succeeded, ${failed} failed`);
  console.log(`  Total time: ${totalDuration}s`);

  return responses;
};

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(batch, "batch", {
  value: batch
}));