"use strict";

/**
 * @file Config.test.js
 * @brief Unit tests for the Config configuration container.
 *
 * Covers variadic deep merge, apiKey hiding, safe getter, cost method
 * propagation, toString formatting, Config.create factory, and frozen export.
 */

const Config = require("../src/Config");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a fresh plain pricing object with an enumerable cost method. */
const Pricing = require("../src/claude/Pricing");

const makePricing = (overrides = {}) => new Pricing({
  input:  { standard: 3.00, cacheWrite: 3.75, cacheRead: 0.30, ...overrides.input },
  output: { standard: 15.00, ...overrides.output },
  batchDiscount: overrides.batchDiscount ?? 0.5,
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic construction
// ─────────────────────────────────────────────────────────────────────────────

describe("Config — basic construction", () => {
  test("single source — scalar values assigned", () => {
    const config = new Config({ max_tokens: 1000, temperature: 0.5 });
    expect(config.max_tokens).toBe(1000);
    expect(config.temperature).toBe(0.5);
  });

  test("no arguments — empty config", () => {
    const config = new Config();
    expect(Object.keys(config)).toHaveLength(0);
  });

  test("all falsy sources — empty config", () => {
    const config = new Config(null, undefined, false, 0);
    expect(Object.keys(config)).toHaveLength(0);
  });

  test("null values not assigned", () => {
    const config = new Config({ a: null });
    expect(config.a).toBeUndefined();
  });

  test("undefined values not assigned", () => {
    const config = new Config({ a: undefined });
    expect(config.a).toBeUndefined();
  });

  test("unknown keys pass through", () => {
    const config = new Config({ customKey: "customValue" });
    expect(config.customKey).toBe("customValue");
  });

  test("nested array in configs flattened", () => {
    const config = new Config([{ max_tokens: 500 }]);
    expect(config.max_tokens).toBe(500);
  });

  test("falsy entries inside nested array skipped", () => {
    const config = new Config([null, { max_tokens: 500 }, undefined]);
    expect(config.max_tokens).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Variadic merge
// ─────────────────────────────────────────────────────────────────────────────

describe("Config — variadic merge", () => {
  test("two sources — rightmost wins on conflict", () => {
    const config = new Config({ max_tokens: 500 }, { max_tokens: 1000 });
    expect(config.max_tokens).toBe(1000);
  });

  test("two sources — non-conflicting keys preserved from both", () => {
    const config = new Config({ max_tokens: 500 }, { temperature: 0.7 });
    expect(config.max_tokens).toBe(500);
    expect(config.temperature).toBe(0.7);
  });

  test("three sources — rightmost wins on conflict", () => {
    const config = new Config(
      { max_tokens: 500, temperature: 0.7 },
      { max_tokens: 1000 },
      { apiKey: "sk-..." }
    );
    expect(config.max_tokens).toBe(1000);
    expect(config.temperature).toBe(0.7);
  });

  test("deep pricing merge — partial override preserves sibling rates", () => {
    const config = new Config(
      { pricing: { input: { standard: 3.00, cacheWrite: 3.75, cacheRead: 0.30 }, batchDiscount: 0.5 } },
      { pricing: { input: { standard: 2.00 } } }
    );
    expect(config.pricing.input.standard).toBe(2.00);
    expect(config.pricing.input.cacheWrite).toBe(3.75);
    expect(config.pricing.input.cacheRead).toBe(0.30);
    expect(config.pricing.batchDiscount).toBe(0.5);
  });

  test("falsy source in variadic skipped", () => {
    const config = new Config({ max_tokens: 500 }, null, { temperature: 0.7 });
    expect(config.max_tokens).toBe(500);
    expect(config.temperature).toBe(0.7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// apiKey — hidden from enumeration and serialization
// ─────────────────────────────────────────────────────────────────────────────

describe("Config — apiKey hiding", () => {
  test("apiKey accessible directly", () => {
    const config = new Config({ apiKey: "sk-ant-test" });
    expect(config.apiKey).toBe("sk-ant-test");
  });

  test("apiKey not in Object.keys", () => {
    const config = new Config({ apiKey: "sk-ant-test", max_tokens: 1000 });
    expect(Object.keys(config)).not.toContain("apiKey");
  });

  test("apiKey not in JSON.stringify output", () => {
    const config = new Config({ apiKey: "sk-ant-test", max_tokens: 1000 });
    expect(JSON.stringify(config)).not.toContain("sk-ant-test");
  });

  test("apiKey not iterable via for...in", () => {
    const config = new Config({ apiKey: "sk-ant-test", max_tokens: 1000 });
    const keys = [];
    for (const k in config) keys.push(k);
    expect(keys).not.toContain("apiKey");
  });

  test("apiKey not in toString output", () => {
    const config = new Config({ apiKey: "sk-ant-test", max_tokens: 1000 });
    expect(String(config)).not.toContain("sk-ant-test");
  });

  test("no apiKey provided — config.apiKey is undefined", () => {
    const config = new Config({ max_tokens: 1000 });
    expect(config.apiKey).toBeUndefined();
  });

  test("falsy apiKey — not stored", () => {
    const config = new Config({ apiKey: "" });
    expect(config.apiKey).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// safe getter
// ─────────────────────────────────────────────────────────────────────────────

describe("Config — safe getter", () => {
  test("with apiKey — safe returns a new Config instance", () => {
    const config = new Config({ apiKey: "sk-...", max_tokens: 1000 });
    expect(config.safe).toBeInstanceOf(Config);
    expect(config.safe).not.toBe(config);
  });

  test("with apiKey — safe.apiKey is undefined", () => {
    const config = new Config({ apiKey: "sk-...", max_tokens: 1000 });
    expect(config.safe.apiKey).toBeUndefined();
  });

  test("with apiKey — safe preserves other enumerable props", () => {
    const config = new Config({ apiKey: "sk-...", max_tokens: 1000, temperature: 0.5 });
    expect(config.safe.max_tokens).toBe(1000);
    expect(config.safe.temperature).toBe(0.5);
  });

  test("without apiKey — safe returns this", () => {
    const config = new Config({ max_tokens: 1000 });
    expect(config.safe).toBe(config);
  });

  test("safe config toString does not include apiKey", () => {
    const config = new Config({ apiKey: "sk-ant-test", max_tokens: 1000 });
    expect(String(config.safe)).not.toContain("sk-ant-test");
  });

  test("safe config is itself safe — safe.safe.apiKey undefined", () => {
    const config = new Config({ apiKey: "sk-...", max_tokens: 1000 });
    expect(config.safe.safe.apiKey).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cost method propagation
// ─────────────────────────────────────────────────────────────────────────────

describe("Config — cost method", () => {
  test("pricing.cost callable on config.pricing", () => {
    const config = new Config({ pricing: makePricing() });
    const result = config.pricing.cost({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(result.uncachedInput).toBeCloseTo(3.00);
  });

  test("cost uses correct this context — reads this.input.standard", () => {
    const config = new Config({ pricing: makePricing({ input: { standard: 5.00 } }) });
    const result = config.pricing.cost({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(result.uncachedInput).toBeCloseTo(5.00);
  });

  test("cost is non-enumerable on config.pricing", () => {
    const config = new Config({ pricing: makePricing() });
    expect(Object.keys(config.pricing)).not.toContain("cost");
  });

  test("cost not present when pricing has no cost method", () => {
    const config = new Config({ pricing: { input: { standard: 3.00 } } });
    expect(config.pricing.cost).toBeUndefined();
  });

  test("cost taken from rightmost config that has it", () => {
    const pricing1 = makePricing();
    const pricing2 = { input: { standard: 9.00, cacheWrite: 9.00, cacheRead: 9.00 }, output: { standard: 9.00 } };
    // pricing2 has no cost — pricing1's cost should be used
    const config = new Config({ pricing: pricing1 }, { pricing: pricing2 });
    // deep merge: pricing2 overwrites standard rate but cost comes from pricing1's original fn
    expect(typeof config.pricing.cost).toBe("function");
  });

  test("safe config pricing retains cost method", () => {
    const config = new Config({ apiKey: "sk-...", pricing: makePricing() });
    const safe = config.safe;
    expect(typeof safe.pricing.cost).toBe("function");
    const result = safe.pricing.cost({ inputTokens: 1_000_000, outputTokens: 0 });
    expect(result.uncachedInput).toBeCloseTo(3.00);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toString
// ─────────────────────────────────────────────────────────────────────────────

describe("Config — toString", () => {
  test("contains header line", () => {
    const config = new Config({ max_tokens: 1000 });
    expect(String(config)).toContain("⚙️  Config:");
  });

  test("contains separator line", () => {
    const config = new Config({ max_tokens: 1000 });
    expect(String(config)).toContain("─────────────────────────────────────");
  });

  test("contains enumerable key values", () => {
    const config = new Config({ max_tokens: 1000, temperature: 0.5 });
    const str = String(config);
    expect(str).toContain("max_tokens");
    expect(str).toContain("1000");
    expect(str).toContain("temperature");
    expect(str).toContain("0.5");
  });

  test("does not contain apiKey", () => {
    const config = new Config({ apiKey: "sk-secret", max_tokens: 1000 });
    expect(String(config)).not.toContain("sk-secret");
    expect(String(config)).not.toContain("apiKey");
  });

  test("toString is non-enumerable", () => {
    const config = new Config({ max_tokens: 1000 });
    expect(Object.keys(config)).not.toContain("toString");
  });

  test("empty config produces header only", () => {
    const config = new Config();
    const str = String(config);
    expect(str).toContain("⚙️  Config:");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config.create factory
// ─────────────────────────────────────────────────────────────────────────────

describe("Config.create", () => {
  test("returns a Config instance", () => {
    expect(Config.create({ max_tokens: 1000 })).toBeInstanceOf(Config);
  });

  test("equivalent to new Config(...args)", () => {
    const a = new Config({ max_tokens: 1000, temperature: 0.5 }, { max_tokens: 2000 });
    const b = Config.create({ max_tokens: 1000, temperature: 0.5 }, { max_tokens: 2000 });
    expect(a.max_tokens).toBe(b.max_tokens);
    expect(a.temperature).toBe(b.temperature);
  });

  test("no arguments — empty Config", () => {
    const config = Config.create();
    expect(Object.keys(config)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frozen export
// ─────────────────────────────────────────────────────────────────────────────

describe("Config — frozen export", () => {
  test("frozen — cannot add properties to export", () => {
    expect(() => { Config.foo = 1; }).toThrow();
  });

  test("named export matches default", () => {
    expect(Config.Config).toBe(Config);
  });

  test("Config.create attached to frozen export", () => {
    expect(typeof Config.create).toBe("function");
  });
});
