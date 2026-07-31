"use strict";

/**
 * @constant
 * @readonly
 * @description
 * 
 * Main configuration object for Xenova API interactions
 * 
 * The object is frozen to prevent accidental modifications at runtime,
 * ensuring configuration consistency across the application lifecycle.
 * 
 * @property {string} featureExtractionModel - Model identifier to vectorize a dataset for fast retrieval
 *                                             | **Model**                    | **Quality**     | **Size/Speed**   | **Best for**                                       |
 *                                             | ---------------------------- | --------------- | ---------------- | -------------------------------------------------- |
 *                                             | Xenova/all-MiniLM-L6-v2      | Medium          | **Small / Fast** | Very fast, cheap compute, basic semantic search    |
 *                                             | Xenova/bge-small-en-v1.5     | Good            | Small / Fast     | Better than MiniLM while still efficient           |
 *                                             | Xenova/multilingual-e5-small | Good            | Small / Moderate | Multilingual, balanced for general semantic search |
 *                                             | Xenova/all-MiniLM-L12-v2     | Good            | Small-Moderate   | Slightly better semantic quality than L6           |
 *                                             | Xenova/all-mpnet-base-v2     | Better          | Moderate         | Mid-tier sentence embeddings                       |
 *                                             | Xenova/bge-base-en-v1.5      | Better          | Moderate         | Strong semantic search, balanced speed vs quality  |
 *                                             | Xenova/gte-small             | Good            | Small-Moderate   | Lightweight contrastive embedding family           |
 *                                             | Xenova/gte-base              | Better          | Moderate-Large   | Good general embeddings                            |
 *                                             | Xenova/multilingual-e5-base  | Better          | Larger           | High quality multilingual embeddings               |
 *                                             | Xenova/bge-large-en-v1.5     | Better / Strong | **Large**        | Strong semantic quality for deeper search tasks    |
 *                                             | Xenova/gte-large             | Strong          | **Large**        | Very expressive embeddings                         |
 *                                             | Xenova/multilingual-e5-large | **Best**        | **Largest**      | Highest quality semantic embeddings (multilingual) |
 * 
 * @property {string} questionAnsweringModel - Model identifier for fast question answering
 *                                             | **Model**                                          | **Quality** | **Size / Speed** | **Best for**                                                                                           |
 *                                             | -------------------------------------------------- | ----------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
 *                                             | Xenova/tinyroberta-squad2                          | Fair        | Tiny / Blazing   | Extreme speed. Good for mobile browsers or low-latency simple lookups.                                 |
 *                                             | Xenova/distilbert-base-cased-distilled-squad       | Good        | Small / Fast     | Recommended for Nereus. Handles chemical casing (pH vs PH) better than uncased models.                 |
 *                                             | Xenova/distilbert-base-uncased-distilled-squad     | Good        | Small / Fast     | Standard baseline. Very reliable but ignores capitalization.                                           |
 *                                             | onnx-community/tinyroberta-squad2-ONNX             | Good        | Small / Fast     | A slightly more robust version of TinyRoBERTa optimized for the ONNX runtime.                          |
 *                                             | Xenova/mobilebert-uncased-squad                    | Good        | Small            | Designed specifically for low-memory environments.                                                     |
 *                                             | Xenova/roberta-base-squad2                         | Strong      | Moderate         | Higher accuracy for complex sentences. Better at understanding the "interpretation" text in your logs. |
 *                                             | onnx-community/all-MiniLM-L12-v2-qa-all-ONNX       | Better      | Small-Moderate   | Great general-purpose QA model; very balanced for industrial technical text.                           |
 *                                             | onnx-community/bert-base-cased-squad2-ONNX         | Strong      | Moderate-Large   | High precision. Best if you need to distinguish between very similar chemical terms.                   |
 * 
 * @property {string} summarizationModel - Model identifier for fast text summarization
 *                                         | **Model**                           | **Quality** | **Size / Speed** | **Best for**                                                                                           |
 *                                         | ----------------------------------- | ----------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
 *                                         | onnx-community/t5-small-quantized   | Fair        | Ultra-Small      | Highest speed/lowest RAM. Ideal for simple, repetitive log summaries on mobile devices.                |
 *                                         | Xenova/t5-small                     | Fair        | Tiny / Blazing   | Extremely fast. Best for summarizing short log entries or individual technician notes.                 |
 *                                         | Xenova/distilbart-cnn-6-6           | Good        | Small / Fast     | Perfect balance of speed and clarity for weekly facility briefs.                                       |
 *                                         | Xenova/distilbart-cnn-12-6          | Good        | Small / Fast     | Slightly more nuanced phrasing than the 6-6 version while maintaining a small footprint.               |
 *                                         | Xenova/t5-base                      | Good        | Moderate         | Better for the "Interpretation" sections of your logs where context is more descriptive.               |
 *                                         | Xenova/led-base-16384               | Strong      | Moderate-Large   | Long Documents. Necessary if you are summarizing massive technical manuals or a full month of logs.    |
 *                                         | Xenova/bart-large-cnn               | Strong      | Large            | Highest quality abstractive summaries. Best for generating complex, professional stakeholder reports.  |
 * 
 * @property {string} text2textModel - Model for text generation
 *                                    | **Model**                    | **Quality** | **Size / Speed** | **Best for**                                                                                |
 *                                    | ---------------------------- | ----------- | ---------------- | ------------------------------------------------------------------------------------------- |
 *                                    | Xenova/LaMini-Flan-T5-77M    | Good	       | Tiny / Blazing   | Higher instruction density than Flan-T5-Small at a similar ~60MB footprint.                 |
 *                                    | Xenova/flan-t5-small         | Fair        | Tiny / Blazing	  | Standard lightweight baseline for basic reformatting and low-latency synthesis.             |
 *                                    | Xenova/t5-small              | Fair        | Tiny / Blazing	  | Original T5 (~80MB). Fast, but requires explicit task prefixes (e.g., "summarize:").        |
 *                                    | Xenova/LaMini-Flan-T5-248M   | Strong      | Small / Fast	    | Excellent reasoning-to-size ratio (~250MB). Handles complex instructions very well.         |
 *                                    | Xenova/flan-t5-base	         | Strong      | Small / Fast	    | Highly reliable and consistent (~250MB). The industry standard for balanced synthesis.      |
 *                                    | Xenova/bart-large-cnn        | Better      | Moderate         | Large-scale sequence modeling (~500MB). Superior for high-quality abstractive synthesis.    |
 *                                    | Xenova/LaMini-Flan-T5-783M   | Best	       | Large / Slower	  | High-density reasoning (~800MB). Best for "human-like" synthesis in Node.js environments.   |
 *                                    | Xenova/flan-t5-large         | Best	       | Large / Slower	  | Maximum logical precision (~800MB). Used when output accuracy is more critical than speed.  |
 *
 * @property {string} zeroShotClassificationModel - NLI-backbone model identifier for zero-shot text classification.
 *                                                  Used by `classify.js` as the fallback for the anchor-cosine classifier
 *                                                  when scores are weak or the margin is thin. Per-call cost is one model
 *                                                  forward pass per candidate label, so latency scales linearly with the
 *                                                  number of classes (3 in the analyzeQuery case → ~100-300ms total).
 *                                                  | **Model**                                          | **Quality** | **Size / Speed**  | **Best for**                                                                                              |
 *                                                  | -------------------------------------------------- | ----------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
 *                                                  | Xenova/nli-deberta-v3-xsmall                       | Good        | **Small / Fast**  | Recommended default. ~80MB DeBERTa-v3 head trained on MNLI; strong out-of-the-box zero-shot accuracy.     |
 *                                                  | Xenova/distilbert-base-uncased-mnli                | Good        | Small / Fast      | Lightweight DistilBERT MNLI head; slightly weaker than DeBERTa-xsmall but compatible across most setups.  |
 *                                                  | Xenova/bart-large-mnli                             | Strong      | Large             | High-accuracy zero-shot reasoning. Use when fallback frequency is high enough to justify the load cost.   |
 *                                                  | Xenova/nli-deberta-v3-small                        | Strong      | Moderate          | Better accuracy than xsmall at ~150MB. Solid middle ground if the xsmall starts to misclassify.           |
 *                                                  | Xenova/nli-deberta-v3-base                         | Strong+     | Moderate-Large    | Higher capacity for nuanced entailment. Useful when class descriptions overlap semantically.              |
 * 
 * @throws {Error} Implicitly throws if ANTHROPIC_API_KEY is not set in environment
 * 
 * @example
 * const CONFIG = require("./config");
 * console.log(CONFIG.featureExtractionModel); // "Xenova/bge-small-en-v1.5"
 * 
 * @example
 * // Configuration is immutable
 * const CONFIG = require("./config");
 * CONFIG.featureExtractionModel = "Xenova/all-MiniLM-L6-v2"; // 🚨 Throws TypeError in strict mode
 * 
 * @see {@link https://huggingface.co/docs/transformers.js|Transformers.js Documentation}
 */
const CONFIG = {
  featureExtractionModel:      "Xenova/bge-small-en-v1.5",                      // Feature extraction transformer model for fast retrieval
  questionAnsweringModel:      "onnx-community/all-MiniLM-L12-v2-qa-all-ONNX",  // Model for fast question answering
  summarizationModel:          "Xenova/t5-base",                                 // Model for text summarization
  text2textModel:              "Xenova/LaMini-Flan-T5-783M",                    // Model for text generation
  zeroShotClassificationModel: "Xenova/nli-deberta-v3-xsmall",                  // NLI backbone for zero-shot classification fallback
};

/**
 * @ignore
 * Default export with freezing.
 */
module.exports = Object.freeze(Object.defineProperty(CONFIG, "CONFIG", {
  value: CONFIG
}));