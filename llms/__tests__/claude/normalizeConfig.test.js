"use strict";

/**
 * @file normalizeConfig.test.js
 * @brief Unit tests for normalizeConfig.
 *
 * normalizeConfig merges variadic partial configs over DEFAULT_CONFIG,
 * producing a fully resolved Config instance. Tests verify defaults are
 * applied, overrides win on conflict, pricing is deep-merged, and the
 * result is a proper Config instance with apiKey hidden.
 */

const normalizeConfig = require("../../src/claude/normalizeConfig");
const Config          = require("../../src/Config");

// The DEFAULT_CONFIG values are imported to assert defaults — this avoids
// hardcoding values that may change when model defaults are updated.
const DEFAULT_CONFIG  = require("../../src/claude/config");

// ─────────────────────────────────────────────────────────────────────────────
// Return type
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeConfig — return type", () => {
  test("returns a Config instance", () => {
    expect(normalizeConfig()).toBeInstanceOf(Config);
  });

  test("no arguments — returns Config with DEFAULT_CONFIG values", () => {
    const c = normalizeConfig();
    expect(c.model).toBe(DEFAULT_CONFIG.model);
    expect(c.max_tokens).toBe(DEFAULT_CONFIG.max_tokens);
    expect(c.temperature).toBe(DEFAULT_CONFIG.temperature);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Default values applied
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeConfig — defaults", () => {
  test("model defaults to DEFAULT_CONFIG.model", () => {
    expect(normalizeConfig().model).toBe(DEFAULT_CONFIG.model);
  });

  test("max_tokens defaults to DEFAULT_CONFIG.max_tokens", () => {
    expect(normalizeConfig().max_tokens).toBe(DEFAULT_CONFIG.max_tokens);
  });

  test("temperature defaults to DEFAULT_CONFIG.temperature", () => {
    expect(normalizeConfig().temperature).toBe(DEFAULT_CONFIG.temperature);
  });

  test("pollInterval defaults to DEFAULT_CONFIG.pollInterval", () => {
    expect(normalizeConfig().pollInterval).toBe(DEFAULT_CONFIG.pollInterval);
  });

  test("pricing defaults to DEFAULT_CONFIG.pricing", () => {
    const c = normalizeConfig();
    expect(c.pricing.input.standard).toBe(DEFAULT_CONFIG.pricing.input.standard);
    expect(c.pricing.output.standard).toBe(DEFAULT_CONFIG.pricing.output.standard);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Single override
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeConfig — single override", () => {
  test("temperature override applied", () => {
    expect(normalizeConfig({ temperature: 0.2 }).temperature).toBe(0.2);
  });

  test("max_tokens override applied", () => {
    expect(normalizeConfig({ max_tokens: 512 }).max_tokens).toBe(512);
  });

  test("model override applied", () => {
    expect(normalizeConfig({ model: "claude-haiku-4-5-20251001" }).model).toBe("claude-haiku-4-5-20251001");
  });

  test("non-conflicting keys from default preserved alongside override", () => {
    const c = normalizeConfig({ temperature: 0.1 });
    expect(c.temperature).toBe(0.1);
    expect(c.model).toBe(DEFAULT_CONFIG.model);
    expect(c.max_tokens).toBe(DEFAULT_CONFIG.max_tokens);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multiple overrides — rightmost wins
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeConfig — multiple overrides", () => {
  test("rightmost wins on scalar conflict", () => {
    const c = normalizeConfig({ temperature: 0.1 }, { temperature: 0.9 });
    expect(c.temperature).toBe(0.9);
  });

  test("three sources — rightmost wins", () => {
    const c = normalizeConfig(
      { max_tokens: 100 },
      { max_tokens: 200 },
      { max_tokens: 300 }
    );
    expect(c.max_tokens).toBe(300);
  });

  test("non-conflicting keys from all sources preserved", () => {
    const c = normalizeConfig(
      { temperature: 0.2 },
      { max_tokens: 512 }
    );
    expect(c.temperature).toBe(0.2);
    expect(c.max_tokens).toBe(512);
  });

  test("apiKey from second source applied", () => {
    const c = normalizeConfig({ max_tokens: 512 }, { apiKey: "sk-test" });
    expect(c.apiKey).toBe("sk-test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pricing deep merge
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeConfig — pricing deep merge", () => {
  test("partial input override preserves sibling rates", () => {
    const c = normalizeConfig({ pricing: { input: { standard: 1.00 } } });
    expect(c.pricing.input.standard).toBe(1.00);
    expect(c.pricing.input.cacheWrite).toBe(DEFAULT_CONFIG.pricing.input.cacheWrite);
    expect(c.pricing.input.cacheRead).toBe(DEFAULT_CONFIG.pricing.input.cacheRead);
  });

  test("partial output override preserves input rates", () => {
    const c = normalizeConfig({ pricing: { output: { standard: 5.00 } } });
    expect(c.pricing.output.standard).toBe(5.00);
    expect(c.pricing.input.standard).toBe(DEFAULT_CONFIG.pricing.input.standard);
  });

  test("batchDiscount override preserves all rates", () => {
    const c = normalizeConfig({ pricing: { batchDiscount: 0.25 } });
    expect(c.pricing.batchDiscount).toBe(0.25);
    expect(c.pricing.input.standard).toBe(DEFAULT_CONFIG.pricing.input.standard);
  });

  test("full pricing override", () => {
    const c = normalizeConfig({
      pricing: {
        input:  { standard: 15.00, cacheWrite: 18.75, cacheRead: 1.50 },
        output: { standard: 75.00 },
        batchDiscount: 0.5,
      }
    });
    expect(c.pricing.input.standard).toBe(15.00);
    expect(c.pricing.output.standard).toBe(75.00);
    expect(c.pricing.batchDiscount).toBe(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// apiKey behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeConfig — apiKey", () => {
  test("apiKey accessible directly", () => {
    expect(normalizeConfig({ apiKey: "sk-abc" }).apiKey).toBe("sk-abc");
  });

  test("apiKey not in Object.keys", () => {
    expect(Object.keys(normalizeConfig({ apiKey: "sk-abc" }))).not.toContain("apiKey");
  });

  test("apiKey not in JSON.stringify", () => {
    expect(JSON.stringify(normalizeConfig({ apiKey: "sk-abc" }))).not.toContain("sk-abc");
  });

  test("safe config has no apiKey", () => {
    expect(normalizeConfig({ apiKey: "sk-abc" }).safe.apiKey).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Named model configs available on DEFAULT_CONFIG
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeConfig — named model configs", () => {
  test("HAIKU45_CONFIG available via DEFAULT_CONFIG", () => {
    const c = normalizeConfig(DEFAULT_CONFIG.HAIKU45_CONFIG);
    expect(c.model).toBe("claude-haiku-4-5-20251001");
  });

  test("OPUS4_CONFIG available via DEFAULT_CONFIG", () => {
    const c = normalizeConfig(DEFAULT_CONFIG.OPUS4_CONFIG);
    expect(c.model).toBe("claude-opus-4-20250514");
  });

  test("model preset + additional override — override wins", () => {
    const c = normalizeConfig(DEFAULT_CONFIG.HAIKU45_CONFIG, { temperature: 0.0 });
    expect(c.model).toBe("claude-haiku-4-5-20251001");
    expect(c.temperature).toBe(0.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Falsy sources ignored
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeConfig — falsy sources", () => {
  test("null source ignored — defaults preserved", () => {
    expect(normalizeConfig(null).model).toBe(DEFAULT_CONFIG.model);
  });

  test("undefined source ignored", () => {
    expect(normalizeConfig(undefined).model).toBe(DEFAULT_CONFIG.model);
  });

  test("mixed null and valid — valid applied", () => {
    expect(normalizeConfig(null, { temperature: 0.3 }).temperature).toBe(0.3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frozen export
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeConfig — frozen export", () => {
  test("frozen — cannot add properties", () => {
    expect(() => { normalizeConfig.foo = 1; }).toThrow();
  });

  test("named export matches default", () => {
    expect(normalizeConfig.normalizeConfig).toBe(normalizeConfig);
  });
});
