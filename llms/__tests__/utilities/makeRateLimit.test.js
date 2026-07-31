"use strict";

/**
 * @file makeRateLimit.test.js
 * @brief Tests for the token-bucket rate limiter.
 *
 * Verifies:
 *   - Constructor validation (rate must be positive number; burst must be
 *     positive if provided)
 *   - Initial bucket is full — first `burst` acquires resolve immediately
 *   - Sustained rate is enforced — N acquires past the burst window take
 *     approximately N / rate seconds
 *   - Idle periods accumulate tokens up to burst (no unbounded growth)
 *   - Concurrent acquires serialize properly (no token over-issuance)
 *   - Module export conventions match project standard (frozen + self-ref)
 */

const makeRateLimit = require("../../src/utilities/makeRateLimit");

/**
 * Sleep helper.
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Time a function. Returns elapsed milliseconds. Useful for asserting that
 * the rate limiter actually paced things rather than just returning quickly.
 */
const timeIt = async (fn) => {
  const t0 = Date.now();
  await fn();
  return Date.now() - t0;
};

describe("makeRateLimit — constructor validation", () => {
  test("throws when rate is missing", () => {
    expect(() => makeRateLimit()).toThrow(/rate must be a positive number/);
    expect(() => makeRateLimit({})).toThrow(/rate must be a positive number/);
  });

  test("throws when rate is non-numeric", () => {
    expect(() => makeRateLimit({ rate: "5" })).toThrow(/rate must be a positive number/);
    expect(() => makeRateLimit({ rate: null })).toThrow(/rate must be a positive number/);
  });

  test("throws when rate is zero or negative", () => {
    expect(() => makeRateLimit({ rate: 0 })).toThrow(/rate must be a positive number/);
    expect(() => makeRateLimit({ rate: -1 })).toThrow(/rate must be a positive number/);
  });

  test("accepts fractional rates", () => {
    // 0.5 req/sec is a valid sustained rate (one every 2 seconds).
    expect(() => makeRateLimit({ rate: 0.5 })).not.toThrow();
  });

  test("burst defaults to rate when omitted", async () => {
    const acquire = makeRateLimit({ rate: 5 });
    // With burst === rate === 5, first 5 acquires should be near-instant.
    const elapsed = await timeIt(async () => {
      for (let i = 0; i < 5; i++) await acquire();
    });
    // Generous bound — system jitter on CI can add 50-100ms.
    expect(elapsed).toBeLessThan(150);
  });

  test("burst accepts a number larger than rate", async () => {
    const acquire = makeRateLimit({ rate: 2, burst: 10 });
    // 10 immediate acquires should all fit in the initial bucket.
    const elapsed = await timeIt(async () => {
      for (let i = 0; i < 10; i++) await acquire();
    });
    expect(elapsed).toBeLessThan(200);
  });

  test("ignores invalid burst by falling back to rate", async () => {
    // Burst as a non-positive number is silently coerced to default (rate).
    // Tests current behavior — if you want to throw instead, this is the
    // signal to revisit the validator.
    const acquire = makeRateLimit({ rate: 4, burst: 0 });
    const elapsed = await timeIt(async () => {
      for (let i = 0; i < 4; i++) await acquire();
    });
    expect(elapsed).toBeLessThan(150);
  });
});

describe("makeRateLimit — initial burst", () => {
  test("first `burst` acquires resolve without measurable delay", async () => {
    const acquire = makeRateLimit({ rate: 1, burst: 5 });

    const elapsed = await timeIt(async () => {
      for (let i = 0; i < 5; i++) await acquire();
    });

    // 5 acquires from a full bucket — should be effectively instant.
    expect(elapsed).toBeLessThan(100);
  });

  test("acquire past the burst blocks until refill", async () => {
    // burst=2 means 2 immediate, then each subsequent waits ~1/rate seconds.
    const acquire = makeRateLimit({ rate: 4, burst: 2 });

    // Drain the initial bucket.
    await acquire();
    await acquire();

    // Third acquire should wait roughly 250ms (1/4 second).
    const elapsed = await timeIt(acquire);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(400);
  });
});

describe("makeRateLimit — sustained rate", () => {
  test("N acquires past burst take roughly N/rate seconds", async () => {
    // burst=1, rate=10 req/sec. Drain the burst, then time 5 more.
    // Expected pacing: ~500ms for 5 acquires (one every 100ms).
    const acquire = makeRateLimit({ rate: 10, burst: 1 });
    await acquire();  // drain initial bucket

    const elapsed = await timeIt(async () => {
      for (let i = 0; i < 5; i++) await acquire();
    });

    // Lower bound: at least 4 * 100ms (the 5th token is earned after 4 refill intervals).
    expect(elapsed).toBeGreaterThanOrEqual(350);
    // Upper bound: timer jitter and overhead, but well under 1s.
    expect(elapsed).toBeLessThan(800);
  });

  test("higher rate produces shorter pacing", async () => {
    const slow = makeRateLimit({ rate: 5,  burst: 1 });
    const fast = makeRateLimit({ rate: 20, burst: 1 });

    await slow();  // drain
    await fast();

    const slowElapsed = await timeIt(async () => {
      for (let i = 0; i < 3; i++) await slow();
    });
    const fastElapsed = await timeIt(async () => {
      for (let i = 0; i < 3; i++) await fast();
    });

    // 5 req/sec → ~600ms for 3 acquires; 20 req/sec → ~150ms.
    expect(slowElapsed).toBeGreaterThan(fastElapsed);
  });
});

describe("makeRateLimit — idle refill", () => {
  test("tokens accumulate during idle up to burst cap", async () => {
    const acquire = makeRateLimit({ rate: 10, burst: 3 });

    // Drain the initial bucket.
    await acquire();
    await acquire();
    await acquire();

    // Sleep long enough to fully refill (and then some) — bucket should
    // cap at 3 even though 5*0.1 = 500ms worth of tokens were generated.
    await sleep(500);

    // Three immediate acquires should now succeed.
    const elapsed = await timeIt(async () => {
      await acquire();
      await acquire();
      await acquire();
    });
    expect(elapsed).toBeLessThan(80);

    // A fourth acquire should wait for fresh refill (~100ms at 10/sec).
    const fourthElapsed = await timeIt(acquire);
    expect(fourthElapsed).toBeGreaterThanOrEqual(50);
  });

  test("partial refill during idle restores some but not all capacity", async () => {
    const acquire = makeRateLimit({ rate: 10, burst: 5 });

    // Drain.
    for (let i = 0; i < 5; i++) await acquire();

    // Sleep for 200ms — should refill 2 tokens at 10/sec.
    await sleep(200);

    // Two immediate acquires.
    const fastElapsed = await timeIt(async () => {
      await acquire();
      await acquire();
    });
    expect(fastElapsed).toBeLessThan(80);

    // Third one must wait for the next refill.
    const slowElapsed = await timeIt(acquire);
    expect(slowElapsed).toBeGreaterThanOrEqual(50);
  });
});

describe("makeRateLimit — concurrent acquires", () => {
  test("simultaneous Promise.all of N acquires respects bucket", async () => {
    // burst=3, rate=10. Fire 6 acquires at once. First 3 resolve immediately,
    // remaining 3 should pace out at 100ms intervals (the 6th one needs 3
    // refill intervals after burst exhausted).
    const acquire = makeRateLimit({ rate: 10, burst: 3 });

    const elapsed = await timeIt(async () => {
      await Promise.all(Array.from({ length: 6 }, () => acquire()));
    });

    // Lower bound: ~300ms (the 6th token is earned 300ms after burst drained).
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(700);
  });

  test("does not over-issue tokens under concurrent pressure", async () => {
    // Hammer the limiter with way more concurrent acquires than burst,
    // measure how long they took, and assert that the elapsed time is
    // consistent with the configured rate. If the limiter over-issued
    // tokens, the total elapsed time would be much shorter than
    // (N - burst) / rate.
    const acquire = makeRateLimit({ rate: 20, burst: 5 });

    const totalAcquires = 25;  // 5 immediate + 20 paced at 50ms each
    const elapsed = await timeIt(async () => {
      await Promise.all(Array.from({ length: totalAcquires }, () => acquire()));
    });

    // Expected lower bound: ~950ms (the 25th token earned 19 refill periods
    // after the initial burst drained; at 20/sec each period is 50ms).
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("makeRateLimit — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof makeRateLimit).toBe("function");
  });

  test("exposes a self-referential .makeRateLimit property", () => {
    expect(makeRateLimit.makeRateLimit).toBe(makeRateLimit);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(makeRateLimit)).toBe(true);
  });
});