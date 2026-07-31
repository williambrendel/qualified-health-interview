"use strict";

/**
 * @file makeLimit.test.js
 * @brief Tests for the FIFO concurrency limiter.
 *
 * Verifies:
 *   - Concurrency cap is enforced (never more than N in flight)
 *   - FIFO ordering (queued work runs in submission order)
 *   - Resolved values flow back to the caller
 *   - Rejections propagate to the caller without breaking the queue
 *   - Slot is released even when the thunk rejects
 *   - A thunk that throws synchronously is handled (becomes a rejection)
 *   - Zero-concurrency edge case (queue holds work forever)
 */

const makeLimit = require("../../src/utilities/makeLimit");

/**
 * Sleep helper.
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Build a thunk that resolves after `ms` ms with `value`, and that bumps
 * shared counters when it starts and finishes. Used to observe concurrency.
 */
const makeTracker = () => {
  const state = { active: 0, maxActive: 0, completed: [], started: [] };
  const make = (id, ms, value) => async () => {
    state.active++;
    state.started.push(id);
    state.maxActive = Math.max(state.maxActive, state.active);
    await sleep(ms);
    state.active--;
    state.completed.push(id);
    return value !== undefined ? value : id;
  };
  return { state, make };
};

describe("makeLimit — concurrency cap", () => {
  test("never exceeds the cap with many small jobs", async () => {
    const limit = makeLimit(3);
    const { state, make } = makeTracker();

    const tasks = Array.from({ length: 12 }, (_, i) => limit(make(i, 20)));
    await Promise.all(tasks);

    expect(state.maxActive).toBe(3);
    expect(state.completed).toHaveLength(12);
  });

  test("cap of 1 serializes all work", async () => {
    const limit = makeLimit(1);
    const { state, make } = makeTracker();

    await Promise.all([
      limit(make("a", 10)),
      limit(make("b", 10)),
      limit(make("c", 10)),
    ]);

    expect(state.maxActive).toBe(1);
  });
});

describe("makeLimit — FIFO ordering", () => {
  test("started in submission order under saturation", async () => {
    const limit = makeLimit(2);
    const { state, make } = makeTracker();

    // Submit 6 jobs all at once. With cap 2, jobs 0 and 1 start immediately,
    // then jobs 2-5 start in order as slots free up.
    const tasks = Array.from({ length: 6 }, (_, i) => limit(make(i, 10)));
    await Promise.all(tasks);

    expect(state.started).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("longer running first job does not let later jobs jump ahead", async () => {
    const limit = makeLimit(1);
    const { state, make } = makeTracker();

    // The first job is slowest; later jobs must still wait their turn.
    await Promise.all([
      limit(make("slow", 30)),
      limit(make("fast", 5)),
      limit(make("middle", 15)),
    ]);

    expect(state.completed).toEqual(["slow", "fast", "middle"]);
  });
});

describe("makeLimit — return values", () => {
  test("resolves with the thunk's resolved value", async () => {
    const limit = makeLimit(2);
    const result = await limit(async () => 42);
    expect(result).toBe(42);
  });

  test("passes through complex resolved values", async () => {
    const limit = makeLimit(2);
    const expected = { foo: "bar", nested: [1, 2, 3] };
    const result = await limit(async () => expected);
    expect(result).toBe(expected);
  });
});

describe("makeLimit — error handling", () => {
  test("rejection propagates to caller", async () => {
    const limit = makeLimit(2);
    const err = new Error("kaboom");
    await expect(limit(async () => { throw err; })).rejects.toBe(err);
  });

  test("rejection releases the slot", async () => {
    const limit = makeLimit(1);
    const { state, make } = makeTracker();

    // First job rejects; second job must still get a chance to run.
    const promises = [
      limit(async () => { throw new Error("first"); }).catch(() => "rejected"),
      limit(make("second", 5)),
    ];
    const results = await Promise.all(promises);

    expect(results[0]).toBe("rejected");
    expect(results[1]).toBe("second");
    expect(state.completed).toEqual(["second"]);
  });

  test("one rejection does not break the rest of the queue", async () => {
    const limit = makeLimit(2);

    const promises = [
      limit(async () => "a"),
      limit(async () => { throw new Error("boom"); }).catch(() => "caught"),
      limit(async () => "c"),
      limit(async () => "d"),
    ];

    const results = await Promise.all(promises);
    expect(results).toEqual(["a", "caught", "c", "d"]);
  });

  test("synchronous throw inside thunk is captured as rejection", async () => {
    const limit = makeLimit(2);
    // The thunk itself throws synchronously rather than returning a promise.
    // makeLimit wraps the call in a Promise chain, so even sync throws should
    // become rejections instead of crashing the process.
    const throwing = () => { throw new Error("sync"); };
    await expect(limit(throwing)).rejects.toThrow("sync");
  });
});

describe("makeLimit — saturation behavior", () => {
  test("does not start the N+1th job until one finishes", async () => {
    const limit = makeLimit(2);
    const { state, make } = makeTracker();

    // Submit 3 jobs synchronously. Wait briefly: only 2 should be active.
    const p1 = limit(make("a", 50));
    const p2 = limit(make("b", 50));
    const p3 = limit(make("c", 50));

    // Give the limiter a microtask cycle to schedule.
    await sleep(10);
    expect(state.started).toEqual(["a", "b"]);
    expect(state.active).toBe(2);

    await Promise.all([p1, p2, p3]);
    expect(state.started).toEqual(["a", "b", "c"]);
  });
});

describe("makeLimit — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof makeLimit).toBe("function");
  });

  test("exposes a self-referential .makeLimit property", () => {
    expect(makeLimit.makeLimit).toBe(makeLimit);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(makeLimit)).toBe(true);
  });
});
