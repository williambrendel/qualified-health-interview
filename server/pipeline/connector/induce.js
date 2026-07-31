"use strict";

/**
 * @module pipeline/connector/induce
 * @description
 * The one place AI touches the input path. Given a *sample* of ingested source
 * records, it asks an LLM to **propose a mapping manifest** — declarative JSON that
 * says, for each source column, which canonical path it feeds and which *named*
 * transform to apply. The model chooses only from the governed vocabulary (the
 * canonical paths) and the fixed transform names; it emits data, never code.
 *
 * The LLM call is a dependency (`opts.runLLM`), defaulting to the vendored
 * `llms/src/claude` runner but injectable — so validation and apply, and these
 * tests, run fully offline with a stubbed model.
 */

const canonical = require("./canonical");
const transforms = require("./transforms");

// Lazy so the Anthropic SDK / API key are only needed when actually inducing live.
let _claudeRun, _haikuConfig, _parseResponseJson;
function lazyDefaults() {
  if (!_claudeRun) {
    _claudeRun = require("../../../llms/src/claude");
    _haikuConfig = require("../../../llms/src/claude/config").HAIKU45_CONFIG;
    _parseResponseJson = require("../../../llms/src/utilities/parseResponseJson");
  }
  return { runLLM: _claudeRun, config: _haikuConfig, parse: _parseResponseJson };
}

/** Render the canonical vocabulary compactly for the prompt. */
function renderVocabulary() {
  const lines = [];
  for (const [entity, paths] of Object.entries(canonical.ENTITIES)) {
    lines.push(`  ${entity}:`);
    for (const [p, spec] of Object.entries(paths)) {
      lines.push(`    ${p}  (${spec.type}) — ${spec.desc}`);
    }
  }
  return lines.join("\n");
}

/** Render the transform registry for the prompt. */
function renderTransforms() {
  const scalar = transforms.names().filter((n) => !transforms.isMulti(n));
  const multi = Object.entries(transforms.MULTI_EMITS)
    .map(([n, leaves]) => `${n} → emits [${leaves.join(", ")}]`)
    .join("; ");
  return `  scalar (use with "to"): ${scalar.join(", ")}\n  multi  (use with "emits"): ${multi}`;
}

const SYSTEM_PROMPT = `You map columns from an arbitrary source export onto a FIXED canonical model.

You output ONLY a JSON mapping manifest. You never output code, prose, or explanation.

Hard rules:
- Every "to" and every path in "emits" MUST be one of the canonical paths listed by the user. Never invent a path.
- "transform" MUST be one of the named transforms listed by the user. Never invent a transform.
- Use "to" with a scalar transform (or no transform to pass through). Use "emits" ONLY with a multi transform, with exactly the number of paths it emits, in order.
- If a source column does not correspond to any canonical path, map it with "to": null (it is dropped). Do not force-fit it.
- Prefer the transform that matches the target type (to_number for numbers, to_date for dates, split_bp for "150/99", parse_reference_range for "136-145").
- Choose the single "entity" this source best represents.

Manifest schema:
{
  "source": "<source name>",
  "entity": "<one entity name>",
  "record_key": ["<canonical path>", ...],   // optional: identifying field(s)
  "fields": [
    { "from": "<source path>", "to": "<canonical path>", "transform": "<name>" },
    { "from": "<source path>", "emits": ["<path>", "<path>"], "transform": "<multi name>" },
    { "from": "<source path>", "to": null }
  ]
}`;

/** Build the user prompt from a sample of ingest records. */
function buildUserPrompt(source, header, sampleRecords) {
  const samples = sampleRecords
    .map((r, i) => `  record ${i}:\n` + header.map((h) => {
      const key = Object.keys(r.values).find((k) => k.endsWith(`.${h}`)) || h;
      const v = r.values[key];
      return `    ${key} = ${v === null ? "∅" : JSON.stringify(v)}`;
    }).join("\n"))
    .join("\n");

  return `Source: ${source}
Source columns (namespaced source paths appear in the samples): ${header.join(", ")}

Sample records (source path → value):
${samples}

Canonical paths you may target:
${renderVocabulary()}

Named transforms you may use:
${renderTransforms()}

Return the JSON manifest now.`;
}

/**
 * Induce a mapping manifest for one ingested source.
 *
 * @param {{source:string, header:string[], records:Array}} ingested - Output of ingest.
 * @param {object} [opts]
 * @param {Function} [opts.runLLM]     - `(config, prompt) => Response|string`. Defaults to llms/claude.
 * @param {object}   [opts.config]     - Model config; defaults to HAIKU45.
 * @param {Function} [opts.parse]      - JSON extractor; defaults to llms parseResponseJson.
 * @param {number}   [opts.sampleSize=5]
 * @returns {Promise<{manifest:object, raw:string, usage:object|null}>}
 */
async function induceManifest(ingested, opts = {}) {
  const { source, header, records } = ingested;
  const sampleSize = opts.sampleSize || 5;

  const d = opts.runLLM ? {} : lazyDefaults();
  const runLLM = opts.runLLM || d.runLLM;
  const config = opts.config || d.config;
  const parse = opts.parse || d.parse || ((x) => JSON.parse(typeof x === "string" ? x : x.output.text));

  const userPrompt = buildUserPrompt(source, header, records.slice(0, sampleSize));

  const res = await runLLM({ ...config, system: SYSTEM_PROMPT, max_tokens: 4000 }, userPrompt);
  const text = res && res.output && typeof res.output.text === "string"
    ? res.output.text
    : (typeof res === "string" ? res : "");
  const manifest = parse(res && res.output ? res : text);

  // Stamp the source name in case the model omitted or renamed it.
  if (manifest && typeof manifest === "object" && !manifest.source) manifest.source = source;

  return {
    manifest,
    raw: text,
    usage: (res && res.stats) || null,
  };
}

module.exports = { induceManifest, SYSTEM_PROMPT, buildUserPrompt, renderVocabulary, renderTransforms };
