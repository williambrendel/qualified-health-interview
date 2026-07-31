"use strict";

/**
 * @file makeLimit.js
 * @module utilities/makeLimit
 * @description FIFO concurrency limiter for async work.
 *
 * ## Contract
 *
 * `makeLimit(N)` returns a function that runs async thunks under a
 * fixed concurrency cap. Submissions queue FIFO; rejections propagate
 * to the caller without affecting other in-flight work.
 *
 * ## Relationship to makeRateLimit
 *
 * `makeLimit(N)` caps how many thunks are *in flight* simultaneously —
 * bounds memory, socket count, connection-pool consumption.
 *
 * `makeRateLimit({rate, burst})` caps sustained requests-per-second —
 * bounds API quota burn.
 *
 * Use both when an API has both a parallel-request limit and a
 * per-minute throughput limit. makeLimit gates the in-flight count;
 * makeRateLimit paces the firing rhythm.
 *
 * ## Implementation
 *
 * Standard queue + active-counter + dispatcher (same shape as
 * `p-limit` and similar libraries). Submissions append to the queue
 * and call `next()`. `next()` advances if a slot is free and work is
 * waiting. On task completion (success or rejection), `--active` and
 * `next()` again to drive the queue forward.
 *
 * Sync throws are guarded by `Promise.resolve().then(fn)`: if the
 * thunk throws synchronously instead of returning a Promise, the
 * throw becomes a rejection inside the chain rather than escaping
 * `next()`. Without this guard, a sync throw would bubble out of
 * `next()`, the `.finally` would never run, `--active` would never
 * fire, and the slot would leak permanently. The actions we wrap
 * (runWithRetry, async LLM calls) don't throw synchronously today,
 * but a leaked slot is a permanent bug rather than a transient one,
 * so the guard is cheap insurance.
 */

/**
 * Creates a function that runs async thunks under a fixed concurrency cap.
 *
 * @function makeLimit
 * @param {number} concurrency - Maximum number of in-flight thunks at once.
 *   Must be a positive integer.
 * @returns {(fn: () => Promise<any>) => Promise<any>} A limiter function.
 *
 * @example
 *   const limit = makeLimit(8);
 *   const results = await Promise.all(
 *     urls.map(url => limit(() => fetch(url)))
 *   );
 *   // At most 8 fetches in flight; the rest queue FIFO.
 */
const makeLimit = (concurrency) => {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    ++active;
    const { fn, resolve, reject } = queue.shift();

    // Promise.resolve().then(fn) defers fn() invocation by one
    // microtask and wraps it in a Promise chain. Three reasons:
    //
    //   1. Async thunk returning a resolved Promise → chain resolves,
    //      `resolve` fires with the value. Same as `fn().then(resolve)`.
    //
    //   2. Async thunk returning a rejected Promise → chain rejects,
    //      `reject` fires. Same as `fn().then(_, reject)`.
    //
    //   3. Thunk THROWS SYNCHRONOUSLY (rare but possible) → without
    //      this wrapper, the throw escapes `next()` entirely. `++active`
    //      already ran but `.finally` never does → slot is leaked
    //      forever. WITH this wrapper, the sync throw becomes a chain
    //      rejection that `.then(_, reject)` routes correctly and
    //      `.finally` cleans up properly.
    //
    // The one microtask deferral is invisible for I/O-bound work
    // (LLM calls, fetches) which is what this limiter exists for.
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        --active;
        next();
      });
  };

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(makeLimit, "makeLimit", {
  value: makeLimit,
}));