"use strict";

/**
 * @file Pricing.test.js
 * @brief Unit tests for the Pricing normalized pricing container.
 *
 * Covers default fallbacks, partial and full overrides, immutability,
 * cost() across all billing components, batch discount, toString
 * formatting, Pricing.create factory, and frozen export.
 */

const Pricing = require("../../src/claude/Pricing");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Sonnet 4.6 public defaults for assertions. */
const D = {
  input:  { standard: 3.00, cacheWrite: 3.75, cacheRead: 0.30 },
  output: { standard: 15.00 },
  batchDiscount: 1.0,
};

/** Minimal stat object. */
const stat = (overrides = {}) => ({
  inputTokens:       0,
  outputTokens:      0,
  cacheHit:          false,
  cacheMiss:         false,
  cachedTokensRead:  0,
  cachedTokensCreated: 0,
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Construction — defaults
// ─────────────────────────────────────────────────────────────────────────────

describe("Pricing — defaults", () => {
  test("no argument — all defaults applied", () => {
    const p = new Pricing();
    expect(p.input.standard).toBe(D.input.standard);
    expect(p.input.cacheWrite).toBe(D.input.cacheWrite);
    expect(p.input.cacheRead).toBe(D.input.cacheRead);
    expect(p.output.standard).toBe(D.output.standard);
    expect(p.batchDiscount).toBe(D.batchDiscount);
  });

  test("null — all defaults applied", () => {
    const p = new Pricing(null);
    expect(p.input.standard).toBe(D.input.standard);
    expect(p.batchDiscount).toBe(D.batchDiscount);
  });

  test("empty object — all defaults applied", () => {
    const p = new Pricing({});
    expect(p.input.standard).toBe(D.input.standard);
  });

  test("empty input object — input defaults applied", () => {
    const p = new Pricing({ input: {} });
    expect(p.input.standard).toBe(D.input.standard);
    expect(p.input.cacheWrite).toBe(D.input.cacheWrite);
    expect(p.input.cacheRead).toBe(D.input.cacheRead);
  });

  test("empty output object — output default applied", () => {
    const p = new Pricing({ output: {} });
    expect(p.output.standard).toBe(D.output.standard);
  });

  test("primitive argument — all defaults applied", () => {
    const p = new Pricing(42);
    expect(p.input.standard).toBe(D.input.standard);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Construction — partial overrides
// ─────────────────────────────────────────────────────────────────────────────

describe("Pricing — partial overrides", () => {
  test("input.standard overridden — siblings preserved", () => {
    const p = new Pricing({ input: { standard: 2.00 } });
    expect(p.input.standard).toBe(2.00);
    expect(p.input.cacheWrite).toBe(D.input.cacheWrite);
    expect(p.input.cacheRead).toBe(D.input.cacheRead);
  });

  test("input.cacheWrite overridden — siblings preserved", () => {
    const p = new Pricing({ input: { cacheWrite: 2.50 } });
    expect(p.input.cacheWrite).toBe(2.50);
    expect(p.input.standard).toBe(D.input.standard);
    expect(p.input.cacheRead).toBe(D.input.cacheRead);
  });

  test("input.cacheRead overridden — siblings preserved", () => {
    const p = new Pricing({ input: { cacheRead: 0.10 } });
    expect(p.input.cacheRead).toBe(0.10);
    expect(p.input.standard).toBe(D.input.standard);
    expect(p.input.cacheWrite).toBe(D.input.cacheWrite);
  });

  test("output.standard overridden — input defaults preserved", () => {
    const p = new Pricing({ output: { standard: 10.00 } });
    expect(p.output.standard).toBe(10.00);
    expect(p.input.standard).toBe(D.input.standard);
  });

  test("batchDiscount overridden — rates preserved", () => {
    const p = new Pricing({ batchDiscount: 0.5 });
    expect(p.batchDiscount).toBe(0.5);
    expect(p.input.standard).toBe(D.input.standard);
    expect(p.output.standard).toBe(D.output.standard);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Construction — full override
// ─────────────────────────────────────────────────────────────────────────────

describe("Pricing — full override", () => {
  test("Opus 4 rates", () => {
    const p = new Pricing({
      input:  { standard: 15.00, cacheWrite: 18.75, cacheRead: 1.50 },
      output: { standard: 75.00 },
      batchDiscount: 0.5,
    });
    expect(p.input.standard).toBe(15.00);
    expect(p.input.cacheWrite).toBe(18.75);
    expect(p.input.cacheRead).toBe(1.50);
    expect(p.output.standard).toBe(75.00);
    expect(p.batchDiscount).toBe(0.5);
  });

  test("Haiku 4.5 rates", () => {
    const p = new Pricing({
      input:  { standard: 1.00, cacheWrite: 1.25, cacheRead: 0.10 },
      output: { standard: 5.00 },
      batchDiscount: 0.5,
    });
    expect(p.input.standard).toBe(1.00);
    expect(p.output.standard).toBe(5.00);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Immutability
// ─────────────────────────────────────────────────────────────────────────────

describe("Pricing — immutability", () => {
  test("instance is frozen", () => {
    expect(Object.isFrozen(new Pricing())).toBe(true);
  });

  test("cannot add properties after construction", () => {
    const p = new Pricing();
    expect(() => { p.newProp = 1; }).toThrow();
  });

  test("cannot overwrite input.standard", () => {
    const p = new Pricing();
    expect(() => { p.input.standard = 99; }).toThrow();
  });

  test("cannot overwrite batchDiscount", () => {
    const p = new Pricing();
    expect(() => { p.batchDiscount = 99; }).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cost() — non-enumerable presence
// ─────────────────────────────────────────────────────────────────────────────

describe("Pricing — cost non-enumerable", () => {
  test("cost not in Object.keys", () => {
    expect(Object.keys(new Pricing())).not.toContain("cost");
  });

  test("cost not in JSON.stringify", () => {
    expect(JSON.stringify(new Pricing())).not.toContain("cost");
  });

  test("cost is a function", () => {
    expect(typeof new Pricing().cost).toBe("function");
  });

  test("cost descriptor is non-enumerable, non-configurable, non-writable", () => {
    const desc = Object.getOwnPropertyDescriptor(new Pricing(), "cost");
    expect(desc.enumerable).toBe(false);
    expect(desc.configurable).toBe(false);
    expect(desc.writable).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cost() — return shape
// ─────────────────────────────────────────────────────────────────────────────

describe("Pricing.cost — return shape", () => {
  const p = new Pricing();

  test("returns all five fields", () => {
    const c = p.cost(stat());
    expect(c).toHaveProperty("uncachedInput");
    expect(c).toHaveProperty("cacheRead");
    expect(c).toHaveProperty("cacheWrite");
    expect(c).toHaveProperty("output");
    expect(c).toHaveProperty("total");
  });

  test("total === sum of all components", () => {
    const c = p.cost(stat({ inputTokens: 500_000, outputTokens: 200_000 }));
    expect(c.total).toBeCloseTo(c.uncachedInput + c.cacheRead + c.cacheWrite + c.output);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cost() — zero tokens
// ─────────────────────────────────────────────────────────────────────────────

describe("Pricing.cost — zero tokens", () => {
  test("all zeros → all costs zero", () => {
    const c = new Pricing().cost(stat());
    expect(c.uncachedInput).toBe(0);
    expect(c.cacheRead).toBe(0);
    expect(c.cacheWrite).toBe(0);
    expect(c.output).toBe(0);
    expect(c.total).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cost() — individual components
// ─────────────────────────────────────────────────────────────────────────────

describe("Pricing.cost — individual components", () => {
  const p = new Pricing();

  test("uncached input — 1M tokens @ $3.00/1M", () => {
    const c = p.cost(stat({ inputTokens: 1_000_000 }));
    expect(c.uncachedInput).toBeCloseTo(3.00);
    expect(c.cacheRead).toBe(0);
    expect(c.cacheWrite).toBe(0);
    expect(c.output).toBe(0);
  });

  test("output — 1M tokens @ $15.00/1M", () => {
    const c = p.cost(stat({ outputTokens: 1_000_000 }));
    expect(c.output).toBeCloseTo(15.00);
    expect(c.uncachedInput).toBe(0);
  });

  test("cache read — 1M tokens @ $0.30/1M when cacheHit=true", () => {
    const c = p.cost(stat({ cacheHit: true, cachedTokensRead: 1_000_000 }));
    expect(c.cacheRead).toBeCloseTo(0.30);
    expect(c.cacheWrite).toBe(0);
  });

  test("cache write — 1M tokens @ $3.75/1M when cacheMiss=true", () => {
    const c = p.cost(stat({ cacheMiss: true, cachedTokensCreated: 1_000_000 }));
    expect(c.cacheWrite).toBeCloseTo(3.75);
    expect(c.cacheRead).toBe(0);
  });

  test("cacheHit=false — cachedTokensRead ignored", () => {
    const c = p.cost(stat({ cacheHit: false, cachedTokensRead: 1_000_000 }));
    expect(c.cacheRead).toBe(0);
  });

  test("cacheMiss=false — cachedTokensCreated ignored", () => {
    const c = p.cost(stat({ cacheMiss: false, cachedTokensCreated: 1_000_000 }));
    expect(c.cacheWrite).toBe(0);
  });

  test("combined — input + output", () => {
    const c = p.cost(stat({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    expect(c.uncachedInput).toBeCloseTo(3.00);
    expect(c.output).toBeCloseTo(15.00);
    expect(c.total).toBeCloseTo(18.00);
  });

  test("combined — cache hit + output", () => {
    const c = p.cost(stat({
      cacheHit: true, cachedTokensRead: 1_000_000,
      outputTokens: 1_000_000
    }));
    expect(c.cacheRead).toBeCloseTo(0.30);
    expect(c.output).toBeCloseTo(15.00);
    expect(c.total).toBeCloseTo(15.30);
  });

  test("fractional tokens — sub-1M input", () => {
    const c = p.cost(stat({ inputTokens: 500_000 }));
    expect(c.uncachedInput).toBeCloseTo(1.50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cost() — batch discount
// ─────────────────────────────────────────────────────────────────────────────

describe("Pricing.cost — batch discount", () => {
  const p = new Pricing({ batchDiscount: 0.5 });

  test("no succeeded field — discount not applied (multiplier 1.0)", () => {
    const c = p.cost(stat({ inputTokens: 1_000_000 }));
    expect(c.uncachedInput).toBeCloseTo(3.00);
  });

  test("succeeded present — batch discount applied", () => {
    const c = p.cost(stat({ inputTokens: 1_000_000, succeeded: 10 }));
    expect(c.uncachedInput).toBeCloseTo(1.50);  // 3.00 * 0.5
  });

  test("succeeded=0 — discount applied (0 is not undefined)", () => {
    const c = p.cost(stat({ inputTokens: 1_000_000, succeeded: 0 }));
    expect(c.uncachedInput).toBeCloseTo(1.50);
  });

  test("batch discount applies to output too", () => {
    const c = p.cost(stat({ outputTokens: 1_000_000, succeeded: 10 }));
    expect(c.output).toBeCloseTo(7.50);  // 15.00 * 0.5
  });

  test("batch discount applies to cache read", () => {
    const c = p.cost(stat({ cacheHit: true, cachedTokensRead: 1_000_000, succeeded: 10 }));
    expect(c.cacheRead).toBeCloseTo(0.15);  // 0.30 * 0.5
  });

  test("batch discount applies to cache write", () => {
    const c = p.cost(stat({ cacheMiss: true, cachedTokensCreated: 1_000_000, succeeded: 10 }));
    expect(c.cacheWrite).toBeCloseTo(1.875);  // 3.75 * 0.5
  });

  test("default batchDiscount=1.0 — no discount even with succeeded", () => {
    const pNoDiscount = new Pricing();  // batchDiscount defaults to 1.0
    const c = pNoDiscount.cost(stat({ inputTokens: 1_000_000, succeeded: 10 }));
    expect(c.uncachedInput).toBeCloseTo(3.00);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cost() — custom rates
// ─────────────────────────────────────────────────────────────────────────────

describe("Pricing.cost — custom rates", () => {
  test("cost uses overridden input.standard rate", () => {
    const p = new Pricing({ input: { standard: 6.00 } });
    const c = p.cost(stat({ inputTokens: 1_000_000 }));
    expect(c.uncachedInput).toBeCloseTo(6.00);
  });

  test("cost uses overridden output.standard rate", () => {
    const p = new Pricing({ output: { standard: 30.00 } });
    const c = p.cost(stat({ outputTokens: 1_000_000 }));
    expect(c.output).toBeCloseTo(30.00);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toString
// ─────────────────────────────────────────────────────────────────────────────

describe("Pricing — toString", () => {
  test("contains all rate labels", () => {
    const str = String(new Pricing());
    expect(str).toContain("standard:");
    expect(str).toContain("cacheWrite:");
    expect(str).toContain("cacheRead:");
    expect(str).toContain("batchDiscount:");
  });

  test("contains input and output sections", () => {
    const str = String(new Pricing());
    expect(str).toContain("input:");
    expect(str).toContain("output:");
  });

  test("contains formatted default rates", () => {
    const str = String(new Pricing());
    expect(str).toContain("$3.00/1M");
    expect(str).toContain("$3.75/1M");
    expect(str).toContain("$0.30/1M");
    expect(str).toContain("$15.00/1M");
  });

  test("reflects overridden rates", () => {
    const str = String(new Pricing({ input: { standard: 15.00 } }));
    expect(str).toContain("$15.00/1M");
  });

  test("toString is non-enumerable", () => {
    expect(Object.keys(new Pricing())).not.toContain("toString");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pricing.create factory
// ─────────────────────────────────────────────────────────────────────────────

describe("Pricing.create", () => {
  test("returns a Pricing instance", () => {
    expect(Pricing.create()).toBeInstanceOf(Pricing);
  });

  test("equivalent to new Pricing(data)", () => {
    const a = new Pricing({ input: { standard: 2.00 } });
    const b = Pricing.create({ input: { standard: 2.00 } });
    expect(a.input.standard).toBe(b.input.standard);
    expect(a.batchDiscount).toBe(b.batchDiscount);
  });

  test("no argument — same as new Pricing()", () => {
    expect(Pricing.create().input.standard).toBe(D.input.standard);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frozen export
// ─────────────────────────────────────────────────────────────────────────────

describe("Pricing — frozen export", () => {
  test("frozen — cannot add properties to export", () => {
    expect(() => { Pricing.foo = 1; }).toThrow();
  });

  test("named export matches default", () => {
    expect(Pricing.Pricing).toBe(Pricing);
  });

  test("Pricing.create attached", () => {
    expect(typeof Pricing.create).toBe("function");
  });
});
