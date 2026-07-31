"use strict";

/**
 * @file makeRateLimit.js
 * @module utilities/makeRateLimit
 * @description Token-bucket rate limiter for outbound API calls.
 *
 * ## Why this exists alongside makeLimit
 *
 * `makeLimit(n)` caps how many requests are *in flight* simultaneously.
 * It does not pace them in time — when N callers all finish a previous
 * step at the same moment, they fire N simultaneous requests. That
 * burst can spike past a per-minute rate limit even when the average
 * rate is fine.
 *
 * `makeRateLimit` caps requests-per-second across the run. Burst is
 * smoothed; sustained throughput stays under `rate`. Combine the two:
 * makeLimit for concurrency, makeRateLimit for pacing.
 *
 * ## Algorithm
 *
 * Classical token bucket, with FIFO serialization:
 *   - Bucket holds up to `burst` tokens. Refills at `rate` tokens/sec.
 *   - Each `acquire()` waits until a token is available, then consumes
 *     one.
 *   - Concurrent acquires (e.g. via Promise.all) are processed in
 *     submission order through an internal chain — prevents the bucket
 *     from over-issuing when multiple callers test the token count
 *     before any of them decrements.
 *   - Idle periods accumulate tokens (up to `burst`), so brief bursts
 *     after quiet stretches are allowed; sustained rate is capped at
 *     `rate`.
 *
 * @example
 *   const rateLimit = makeRateLimit({ rate: 5, burst: 10 });
 *   // 5 req/sec sustained, bursts up to 10 OK
 *   for (const url of urls) {
 *     await rateLimit();
 *     fetch(url);  // fired at most 5/sec on average
 *   }
 *
 * @example
 *   // Combined with concurrency cap
 *   const limit = makeLimit(8);
 *   const rateLimit = makeRateLimit({ rate: 2 });
 *   const callLLM = async (req) => {
 *     await rateLimit();
 *     return await llm.run(req);
 *   };
 *   await Promise.all(reqs.map(r => limit(() => callLLM(r))));
 *
 * @param {object} options
 * @param {number} options.rate   - Tokens per second. Sustained req/sec cap.
 * @param {number} [options.burst] - Bucket capacity. Defaults to `rate`.
 *
 * @returns {() => Promise<void>} An async function. Await it before each
 *                                request to consume one token.
 */
const makeRateLimit = ({ rate, burst } = {}) => {
  if (typeof rate !== "number" || rate <= 0) {
    throw new Error("makeRateLimit: rate must be a positive number (tokens/sec)");
  }

  const bucketSize = typeof burst === "number" && burst > 0 ? burst : rate;

  let tokens     = bucketSize;
  let lastRefill = Date.now();

  // Serialize acquires through a FIFO chain. Each acquire awaits the
  // previous one's "earned token" promise before computing its own
  // wait. Without this, concurrent acquires (e.g. via Promise.all) all
  // observe the same `tokens` value before any of them decrements,
  // letting the bucket over-issue.
  let tail = Promise.resolve();

  /**
   * Refill the bucket based on elapsed time since the last refill. Caps
   * at `bucketSize` so idle periods don't grow the bucket unboundedly.
   */
  const refill = () => {
    const now = Date.now();
    const elapsedSec = (now - lastRefill) / 1000;
    tokens = Math.min(bucketSize, tokens + elapsedSec * rate);
    lastRefill = now;
  };

  /**
   * Inner acquire: assumes serialized entry (no two callers run this
   * body concurrently). Refills, waits if empty, decrements.
   */
  const acquireOne = async () => {
    refill();
    if (tokens < 1) {
      const waitMs = Math.ceil(((1 - tokens) / rate) * 1000);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      refill();
    }
    tokens -= 1;
  };

  /**
   * Public acquire: chains onto the FIFO tail so concurrent callers
   * are processed in submission order, one at a time.
   */
  const acquire = () => {
    const myTurn = tail.then(acquireOne);
    // Swallow rejections on the tail so one failure doesn't poison the
    // chain. acquireOne shouldn't reject in practice (only setTimeout),
    // but defensive: tail tracks completion regardless of outcome.
    tail = myTurn.catch(() => {});
    return myTurn;
  };

  return acquire;
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(makeRateLimit, "makeRateLimit", {
  value: makeRateLimit,
}));