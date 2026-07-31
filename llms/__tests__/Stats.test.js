"use strict";

/**
 * @file Stats.test.js
 * @brief Unit tests for StatsItem and Stats.
 *
 * Covers StatsItem construction, cost closure (default and custom),
 * Stats normalization, collapse(), toString(), Stats.accumulate,
 * and all frozen/export contracts.
 */

const Stats    = require("../src/Stats");
const { StatsItem } = Stats;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal pricing duck-type with a cost() method. */
const makePricing = (rates = {}) => ({
  input:  { standard: 3.00, cacheWrite: 3.75, cacheRead: 0.30, ...rates.input },
  output: { standard: 15.00, ...rates.output },
  batchDiscount: rates.batchDiscount ?? 1.0,
  cost(stat) {
    const discount         = stat.succeeded !== undefined ? this.batchDiscount : 1.0;
    const cacheReadTokens  = stat.cacheHit  ? (stat.cachedTokensRead    ?? 0) : 0;
    const cacheWriteTokens = stat.cacheMiss ? (stat.cachedTokensCreated ?? 0) : 0;
    const uncachedInput    = ((stat.inputTokens  || 0) / 1_000_000) * this.input.standard   * discount;
    const cacheRead        = (cacheReadTokens     / 1_000_000)       * this.input.cacheRead  * discount;
    const cacheWrite       = (cacheWriteTokens    / 1_000_000)       * this.input.cacheWrite * discount;
    const output           = ((stat.outputTokens || 0) / 1_000_000)  * this.output.standard  * discount;
    return { uncachedInput, cacheRead, cacheWrite, output, total: uncachedInput + cacheRead + cacheWrite + output };
  }
});

/** Minimal raw data for a single call. */
const rawItem = (overrides = {}) => ({
  duration:     "1.00",
  inputTokens:  0,
  outputTokens: 0,
  cache:        false,
  ...overrides,
});

/** Response-like wrapper. */
const mockResponse = (statsItem) => ({ stats: statsItem });

// ─────────────────────────────────────────────────────────────────────────────
// StatsItem — construction
// ─────────────────────────────────────────────────────────────────────────────

describe("StatsItem — construction", () => {
  test("defaults applied when no data", () => {
    const item = new StatsItem({});
    expect(item.inputTokens).toBe(0);
    expect(item.outputTokens).toBe(0);
    expect(item.cache).toBe(false);
  });

  test("null data — defaults applied", () => {
    const item = new StatsItem(null);
    expect(item.inputTokens).toBe(0);
    expect(item.cache).toBe(false);
  });

  test("scalar fields assigned", () => {
    const item = new StatsItem(rawItem({ duration: "2.50", inputTokens: 100, outputTokens: 50 }));
    expect(item.duration).toBe("2.50");
    expect(item.inputTokens).toBe(100);
    expect(item.outputTokens).toBe(50);
  });

  test("cache=true assigned", () => {
    const item = new StatsItem(rawItem({ cache: true }));
    expect(item.cache).toBe(true);
  });

  // ── optional fields only present when provided ────────────────────────────

  test("cacheHit undefined when not provided", () => {
    expect(new StatsItem({}).cacheHit).toBeUndefined();
  });

  test("cacheHit assigned when provided", () => {
    const item = new StatsItem({ cacheHit: true, cachedTokensRead: 500 });
    expect(item.cacheHit).toBe(true);
    expect(item.cachedTokensRead).toBe(500);
  });

  test("cacheMiss assigned when provided", () => {
    const item = new StatsItem({ cacheMiss: true, cachedTokensCreated: 300 });
    expect(item.cacheMiss).toBe(true);
    expect(item.cachedTokensCreated).toBe(300);
  });

  test("succeeded/errored undefined when not provided", () => {
    const item = new StatsItem({});
    expect(item.succeeded).toBeUndefined();
    expect(item.errored).toBeUndefined();
  });

  test("succeeded/errored assigned when provided", () => {
    const item = new StatsItem({ succeeded: 5, errored: 1 });
    expect(item.succeeded).toBe(5);
    expect(item.errored).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// StatsItem — cost closure
// ─────────────────────────────────────────────────────────────────────────────

describe("StatsItem — cost closure", () => {
  test("no pricing, no cost fn — cost property absent", () => {
    const item = new StatsItem(rawItem());
    expect(item.cost).toBeUndefined();
  });

  test("pricing with cost() — cost method present", () => {
    const item = new StatsItem(rawItem({ pricing: makePricing() }));
    expect(typeof item.cost).toBe("function");
  });

  test("pricing is NOT stored as enumerable property", () => {
    const item = new StatsItem(rawItem({ pricing: makePricing() }));
    expect(Object.keys(item)).not.toContain("pricing");
    expect(item.pricing).toBeUndefined();
  });

  test("cost is non-enumerable", () => {
    const item = new StatsItem(rawItem({ pricing: makePricing() }));
    expect(Object.keys(item)).not.toContain("cost");
  });

  test("default cost — delegates to pricing.cost(this)", () => {
    const item = new StatsItem(rawItem({
      inputTokens: 1_000_000,
      pricing: makePricing(),
    }));
    const c = item.cost();
    expect(c.uncachedInput).toBeCloseTo(3.00);
    expect(c.total).toBeCloseTo(3.00);
  });

  test("default cost — uses item's own cache flags", () => {
    const item = new StatsItem({
      duration: "1.00",
      cache: true,
      cacheHit: true,
      cachedTokensRead: 1_000_000,
      inputTokens: 0,
      outputTokens: 0,
      pricing: makePricing(),
    });
    const c = item.cost();
    expect(c.cacheRead).toBeCloseTo(0.30);
    expect(c.uncachedInput).toBe(0);
  });

  test("custom cost fn — called with (item, pricing)", () => {
    const customCost = (item, pricing) => ({
      total: item.inputTokens * 0.001,
      uncachedInput: item.inputTokens * 0.001,
      cacheRead: 0, cacheWrite: 0, output: 0,
    });
    const item = new StatsItem(rawItem({
      inputTokens: 1000,
      cost: customCost,
    }));
    expect(item.cost().total).toBeCloseTo(1.0);
  });

  test("custom cost fn takes priority over pricing.cost", () => {
    const customCost = () => ({ total: 99, uncachedInput: 99, cacheRead: 0, cacheWrite: 0, output: 0 });
    const item = new StatsItem(rawItem({
      inputTokens: 1_000_000,
      pricing: makePricing(),
      cost: customCost,
    }));
    expect(item.cost().total).toBe(99);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// StatsItem.create
// ─────────────────────────────────────────────────────────────────────────────

describe("StatsItem.create", () => {
  test("returns a StatsItem instance", () => {
    expect(StatsItem.create(rawItem())).toBeInstanceOf(StatsItem);
  });

  test("equivalent to new StatsItem(data)", () => {
    const data = rawItem({ inputTokens: 42 });
    expect(StatsItem.create(data).inputTokens).toBe(new StatsItem(data).inputTokens);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stats — construction and normalization
// ─────────────────────────────────────────────────────────────────────────────

describe("Stats — construction", () => {
  test("no sources — empty array", () => {
    const stats = new Stats();
    expect(stats.length).toBe(0);
    expect(stats).toBeInstanceOf(Array);
  });

  test("extends Array", () => {
    expect(new Stats() instanceof Array).toBe(true);
  });

  test("single raw object normalized to StatsItem", () => {
    const stats = new Stats(rawItem());
    expect(stats.length).toBe(1);
    expect(stats[0]).toBeInstanceOf(StatsItem);
  });

  test("StatsItem passed through unchanged", () => {
    const item  = new StatsItem(rawItem());
    const stats = new Stats(item);
    expect(stats[0]).toBe(item);
  });

  test("Stats merged — items flattened in", () => {
    const s1 = new Stats(rawItem({ inputTokens: 10 }));
    const s2 = new Stats(rawItem({ inputTokens: 20 }));
    const merged = new Stats(s1, s2);
    expect(merged.length).toBe(2);
  });

  test("Response-like object unwrapped via .stats", () => {
    const item     = new StatsItem(rawItem({ inputTokens: 5 }));
    const response = mockResponse(item);
    const stats    = new Stats(response);
    expect(stats.length).toBe(1);
    expect(stats[0]).toBe(item);
  });

  test("nested arrays flattened", () => {
    const stats = new Stats([rawItem(), [rawItem(), rawItem()]]);
    expect(stats.length).toBe(3);
  });

  test("falsy sources skipped", () => {
    const stats = new Stats(null, undefined, rawItem());
    expect(stats.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stats.normalize
// ─────────────────────────────────────────────────────────────────────────────

describe("Stats.normalize", () => {
  test("returns an array", () => {
    expect(Array.isArray(Stats.normalize(rawItem()))).toBe(true);
  });

  test("plain object → StatsItem", () => {
    const items = Stats.normalize(rawItem());
    expect(items[0]).toBeInstanceOf(StatsItem);
  });

  test("StatsItem passed through", () => {
    const item  = new StatsItem(rawItem());
    const items = Stats.normalize(item);
    expect(items[0]).toBe(item);
  });

  test("Stats collection flattened", () => {
    const s = new Stats(rawItem(), rawItem());
    expect(Stats.normalize(s)).toHaveLength(2);
  });

  test("Response-like unwrapped", () => {
    const item   = new StatsItem(rawItem());
    const result = Stats.normalize(mockResponse(item));
    expect(result[0]).toBe(item);
  });

  test("null sources skipped", () => {
    expect(Stats.normalize(null, undefined)).toHaveLength(0);
  });

  test("mixed sources normalized", () => {
    const item  = new StatsItem(rawItem());
    const items = Stats.normalize(rawItem(), item, null);
    expect(items).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stats.collapse
// ─────────────────────────────────────────────────────────────────────────────

describe("Stats.collapse", () => {
  test("returns a StatsItem", () => {
    expect(new Stats(rawItem()).collapse()).toBeInstanceOf(StatsItem);
  });

  test("empty Stats — zero aggregate", () => {
    const item = new Stats().collapse();
    expect(item.inputTokens).toBe(0);
    expect(item.outputTokens).toBe(0);
    expect(item.duration).toBe("0.00");
  });

  test("inputTokens summed", () => {
    const stats = new Stats(
      rawItem({ inputTokens: 100 }),
      rawItem({ inputTokens: 200 }),
    );
    expect(stats.collapse().inputTokens).toBe(300);
  });

  test("outputTokens summed", () => {
    const stats = new Stats(
      rawItem({ outputTokens: 50 }),
      rawItem({ outputTokens: 75 }),
    );
    expect(stats.collapse().outputTokens).toBe(125);
  });

  test("duration summed and formatted to 2dp", () => {
    const stats = new Stats(
      rawItem({ duration: "1.23" }),
      rawItem({ duration: "2.34" }),
    );
    expect(stats.collapse().duration).toBe("3.57");
  });

  test("cache=true if any item has cache active", () => {
    const stats = new Stats(
      rawItem({ cache: false }),
      rawItem({ cache: true }),
    );
    expect(stats.collapse().cache).toBe(true);
  });

  test("cache=false if no item has cache active", () => {
    const stats = new Stats(rawItem({ cache: false }), rawItem({ cache: false }));
    expect(stats.collapse().cache).toBe(false);
  });

  test("cacheHit present when any item has cacheHit", () => {
    const stats = new Stats(
      new StatsItem({ duration: "1", cache: true, cacheHit: false }),
      new StatsItem({ duration: "1", cache: true, cacheHit: true, cachedTokensRead: 100 }),
    );
    expect(stats.collapse().cacheHit).toBe(true);
  });

  test("cachedTokensRead summed", () => {
    const stats = new Stats(
      new StatsItem({ duration: "1", cache: true, cacheHit: true, cachedTokensRead: 100 }),
      new StatsItem({ duration: "1", cache: true, cacheHit: true, cachedTokensRead: 200 }),
    );
    expect(stats.collapse().cachedTokensRead).toBe(300);
  });

  test("cachedTokensCreated summed", () => {
    const stats = new Stats(
      new StatsItem({ duration: "1", cache: true, cacheMiss: true, cachedTokensCreated: 400 }),
      new StatsItem({ duration: "1", cache: true, cacheMiss: true, cachedTokensCreated: 600 }),
    );
    expect(stats.collapse().cachedTokensCreated).toBe(1000);
  });

  test("batch fields absent when no item is batch", () => {
    const item = new Stats(rawItem()).collapse();
    expect(item.succeeded).toBeUndefined();
    expect(item.errored).toBeUndefined();
  });

  test("batch fields summed when any item is batch", () => {
    const stats = new Stats(
      new StatsItem({ duration: "1", succeeded: 3, errored: 1 }),
      new StatsItem({ duration: "1", succeeded: 5, errored: 0 }),
    );
    const item = stats.collapse();
    expect(item.succeeded).toBe(8);
    expect(item.errored).toBe(1);
  });

  // ── cost accumulation ─────────────────────────────────────────────────────

  test("no cost items — collapsed item has no cost()", () => {
    const stats = new Stats(rawItem(), rawItem());
    expect(stats.collapse().cost).toBeUndefined();
  });

  test("cost summed per-item and frozen on collapsed StatsItem", () => {
    const stats = new Stats(
      new StatsItem(rawItem({ inputTokens: 1_000_000, pricing: makePricing() })),
      new StatsItem(rawItem({ inputTokens: 1_000_000, pricing: makePricing() })),
    );
    const c = stats.collapse().cost();
    expect(c.uncachedInput).toBeCloseTo(6.00);
    expect(c.total).toBeCloseTo(6.00);
  });

  test("per-item pricing respected — different rates per source", () => {
    const stats = new Stats(
      new StatsItem(rawItem({ inputTokens: 1_000_000, pricing: makePricing() })),            // $3/1M
      new StatsItem(rawItem({ inputTokens: 1_000_000, pricing: makePricing({ input: { standard: 1.00, cacheWrite: 1.25, cacheRead: 0.10 } }) })), // $1/1M
    );
    const c = stats.collapse().cost();
    expect(c.uncachedInput).toBeCloseTo(4.00);  // 3 + 1
  });

  test("cache hit on one item, miss on another — costs correct per-item", () => {
    const pricing = makePricing();
    const stats = new Stats(
      new StatsItem({ duration: "1", cache: true, cacheMiss: true, cachedTokensCreated: 1_000_000, inputTokens: 0, outputTokens: 0, pricing }),
      new StatsItem({ duration: "1", cache: true, cacheHit:  true, cachedTokensRead:    1_000_000, inputTokens: 0, outputTokens: 0, pricing }),
    );
    const c = stats.collapse().cost();
    expect(c.cacheWrite).toBeCloseTo(3.75);
    expect(c.cacheRead).toBeCloseTo(0.30);
    expect(c.total).toBeCloseTo(4.05);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stats.toString
// ─────────────────────────────────────────────────────────────────────────────

describe("Stats.toString", () => {
  test("contains header", () => {
    expect(String(new Stats(rawItem()))).toContain("💰 Token Usage:");
  });

  test("contains separator", () => {
    expect(String(new Stats(rawItem()))).toContain("─────────────────────────────────────");
  });

  test("contains duration", () => {
    expect(String(new Stats(rawItem({ duration: "2.50" })))).toContain("2.50s");
  });

  test("contains token counts", () => {
    const str = String(new Stats(rawItem({ inputTokens: 100, outputTokens: 50 })));
    expect(str).toContain("100");
    expect(str).toContain("50");
  });

  test("contains cache hit line when cacheHit=true", () => {
    const stats = new Stats(
      new StatsItem({ duration: "1", cache: true, cacheHit: true, cachedTokensRead: 500, inputTokens: 0, outputTokens: 0 })
    );
    expect(String(stats)).toContain("Cache hit");
  });

  test("contains cache miss line when cacheMiss=true", () => {
    const stats = new Stats(
      new StatsItem({ duration: "1", cache: true, cacheMiss: true, cachedTokensCreated: 300, inputTokens: 0, outputTokens: 0 })
    );
    expect(String(stats)).toContain("Cache miss");
  });

  test("contains estimated cost when pricing present", () => {
    const stats = new Stats(
      new StatsItem(rawItem({ inputTokens: 1_000_000, pricing: makePricing() }))
    );
    expect(String(stats)).toContain("Estimated cost:");
  });

  test("no cost line when no pricing", () => {
    expect(String(new Stats(rawItem()))).not.toContain("Estimated cost:");
  });

  test("contains batch request counts when batch", () => {
    const stats = new Stats(
      new StatsItem({ duration: "1", succeeded: 5, errored: 1, inputTokens: 0, outputTokens: 0 })
    );
    expect(String(stats)).toContain("5 succeeded");
    expect(String(stats)).toContain("1 errored");
  });

  test("toString is non-enumerable", () => {
    expect(Object.keys(new Stats())).not.toContain("toString");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stats.accumulate
// ─────────────────────────────────────────────────────────────────────────────

describe("Stats.accumulate", () => {
  test("equivalent to new Stats(...sources)", () => {
    const a = new Stats(rawItem({ inputTokens: 10 }), rawItem({ inputTokens: 20 }));
    const b = Stats.accumulate(rawItem({ inputTokens: 10 }), rawItem({ inputTokens: 20 }));
    expect(a.collapse().inputTokens).toBe(b.collapse().inputTokens);
  });

  test("returns a Stats instance", () => {
    expect(Stats.accumulate(rawItem())).toBeInstanceOf(Stats);
  });

  test("spread array of responses", () => {
    const responses = [rawItem({ inputTokens: 5 }), rawItem({ inputTokens: 10 })];
    expect(Stats.accumulate(...responses).collapse().inputTokens).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stats.create
// ─────────────────────────────────────────────────────────────────────────────

describe("Stats.create", () => {
  test("returns a Stats instance", () => {
    expect(Stats.create(rawItem())).toBeInstanceOf(Stats);
  });

  test("equivalent to new Stats(...args)", () => {
    const a = new Stats(rawItem({ inputTokens: 7 }));
    const b = Stats.create(rawItem({ inputTokens: 7 }));
    expect(a.collapse().inputTokens).toBe(b.collapse().inputTokens);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frozen export
// ─────────────────────────────────────────────────────────────────────────────

describe("Stats — frozen export", () => {
  test("frozen — cannot add properties to export", () => {
    expect(() => { Stats.foo = 1; }).toThrow();
  });

  test("named export matches default", () => {
    expect(Stats.Stats).toBe(Stats);
  });

  test("StatsItem exported on Stats", () => {
    expect(Stats.StatsItem).toBe(StatsItem);
  });

  test("Stats.create attached", () => {
    expect(typeof Stats.create).toBe("function");
  });

  test("Stats.accumulate attached", () => {
    expect(typeof Stats.accumulate).toBe("function");
  });

  test("Stats.normalize attached", () => {
    expect(typeof Stats.normalize).toBe("function");
  });
});
