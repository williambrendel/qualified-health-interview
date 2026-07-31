"use strict";

/**
 * @file PendingQueue.test.js
 * @brief Tests for the durable retry-tracking queue.
 *
 * Covers:
 *   - Constructor validation (required fields, pathKey)
 *   - enqueue: single entry, array, shorthand strings, full objects,
 *     mixed, augment-don't-overwrite, parent directory creation
 *   - Normalization on read (mixed shorthand + objects in pending.json)
 *   - consume: empty queue, successful drain, partial failure, retry
 *     counter increments, terminal failure → notify + failed.json
 *   - Concurrent consume serialization (one drain at a time)
 *   - Atomic rename claim (pending → processing)
 *   - Crash recovery (.processing.json picked up on next drain)
 *   - AggregateError unwrapping into lastError
 *   - Malformed entries skipped (not crashed on)
 *   - Module export conventions
 */

const fs   = require("fs").promises;
const path = require("path");
const os   = require("os");

const PendingQueue = require("../src/PendingQueue");

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

let tmpRoot;
beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pending-queue-test-"));
});
afterEach(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

/**
 * Build a queue with default test paths under tmpRoot. Each test gets
 * a fresh tmpRoot via beforeEach, so cross-test interference is
 * impossible.
 */
const makeQueue = (overrides = {}) => {
  return new PendingQueue({
    pendingPath: path.join(tmpRoot, "pending.json"),
    failedPath:  path.join(tmpRoot, "failed.json"),
    pathKey:     "binPath",
    maxRetries:  3,
    kind:        "test",
    ...overrides,
  });
};
const readJson = async (filepath) => {
  try {
    return JSON.parse(await fs.readFile(filepath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
};

const writeJson = async (filepath, data) => {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(filepath, JSON.stringify(data), "utf8");
};

// Suppress console.warn / console.error noise during error-path tests.
let warnSpy;
let errorSpy;
beforeEach(() => {
  warnSpy  = jest.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────────
// Constructor
// ─────────────────────────────────────────────────────────────────────────────

describe("PendingQueue — constructor", () => {
  test("throws when pendingPath is missing", () => {
    expect(() => new PendingQueue({ failedPath: "f", pathKey: "k" }))
      .toThrow(/pendingPath is required/);
  });

  test("throws when failedPath is missing", () => {
    expect(() => new PendingQueue({ pendingPath: "p", pathKey: "k" }))
      .toThrow(/failedPath is required/);
  });

  test("throws when pathKey is missing", () => {
    expect(() => new PendingQueue({ pendingPath: "p", failedPath: "f" }))
      .toThrow(/pathKey is required/);
  });

  test("accepts a minimal config", () => {
    const q = new PendingQueue({ pendingPath: "p", failedPath: "f", pathKey: "binPath" });
    expect(q.pendingPath).toBe("p");
    expect(q.failedPath).toBe("f");
    expect(q.processingPath).toBe("p.processing");
    expect(q.pathKey).toBe("binPath");
    expect(q.maxRetries).toBe(5);   // default
    expect(q.kind).toBe("entries"); // default
  });

  test("accepts maxRetries and kind overrides", () => {
    const q = new PendingQueue({
      pendingPath: "p", failedPath: "f", pathKey: "k",
      maxRetries: 10, kind: "custom",
    });
    expect(q.maxRetries).toBe(10);
    expect(q.kind).toBe("custom");
  });

  test("onPermanentFailure defaults to null when not provided", () => {
    const q = new PendingQueue({ pendingPath: "p", failedPath: "f", pathKey: "k" });
    expect(q.onPermanentFailure).toBeNull();
  });

  test("onPermanentFailure ignored when not a function", () => {
    const q = new PendingQueue({
      pendingPath: "p", failedPath: "f", pathKey: "k",
      onPermanentFailure: "not a function",
    });
    expect(q.onPermanentFailure).toBeNull();
  });

  test("onPermanentFailure retained when a function is provided", () => {
    const cb = jest.fn();
    const q = new PendingQueue({
      pendingPath: "p", failedPath: "f", pathKey: "k",
      onPermanentFailure: cb,
    });
    expect(q.onPermanentFailure).toBe(cb);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// enqueue
// ─────────────────────────────────────────────────────────────────────────────

describe("PendingQueue — enqueue", () => {
  test("normalizes a single shorthand string entry", async () => {
    const q = makeQueue();
    const size = await q.enqueue("data/a.bin");

    expect(size).toBe(1);
    const written = await readJson(q.pendingPath);
    expect(written).toEqual([{ binPath: "data/a.bin", retries: 0 }]);
  });

  test("normalizes a single object entry", async () => {
    const q = makeQueue();
    await q.enqueue({ binPath: "data/a.bin" });

    const written = await readJson(q.pendingPath);
    expect(written).toEqual([{ binPath: "data/a.bin", retries: 0 }]);
  });

  test("preserves an explicit retries count", async () => {
    const q = makeQueue();
    await q.enqueue({ binPath: "data/a.bin", retries: 2 });

    const written = await readJson(q.pendingPath);
    expect(written[0].retries).toBe(2);
  });

  test("preserves custom fields on object entries", async () => {
    const q = makeQueue();
    await q.enqueue({ binPath: "data/a.bin", source: "build-endpoint", priority: 5 });

    const written = await readJson(q.pendingPath);
    expect(written[0]).toEqual({
      retries: 0,
      binPath: "data/a.bin",
      source: "build-endpoint",
      priority: 5,
    });
  });

  test("accepts an array of mixed shorthand + object entries", async () => {
    const q = makeQueue();
    await q.enqueue([
      "data/a.bin",
      { binPath: "data/b.bin", retries: 1 },
      "data/c.bin",
    ]);

    const written = await readJson(q.pendingPath);
    expect(written).toEqual([
      { binPath: "data/a.bin", retries: 0 },
      { binPath: "data/b.bin", retries: 1 },
      { binPath: "data/c.bin", retries: 0 },
    ]);
  });

  test("augments existing pending.json rather than overwriting", async () => {
    const q = makeQueue();
    await q.enqueue("data/a.bin");
    await q.enqueue("data/b.bin");
    await q.enqueue([{ binPath: "data/c.bin" }, "data/d.bin"]);

    const written = await readJson(q.pendingPath);
    expect(written.map(e => e.binPath)).toEqual([
      "data/a.bin", "data/b.bin", "data/c.bin", "data/d.bin",
    ]);
  });

  test("creates the parent directory if missing", async () => {
    const q = new PendingQueue({
      pendingPath: path.join(tmpRoot, "subdir", "doesnt", "exist", "pending.json"),
      failedPath:  path.join(tmpRoot, "subdir", "doesnt", "exist", "failed.json"),
      pathKey:     "binPath",
    });
    await q.enqueue("data/a.bin");

    const written = await readJson(q.pendingPath);
    expect(written).toHaveLength(1);
  });

  test("rewrites pre-existing shorthand entries into canonical object form", async () => {
    // Producer manually wrote shorthand strings; queue normalizes on
    // next enqueue.
    const q = makeQueue();
    await writeJson(q.pendingPath, ["data/old.bin"]);

    await q.enqueue("data/new.bin");

    const written = await readJson(q.pendingPath);
    expect(written).toEqual([
      { binPath: "data/old.bin", retries: 0 },
      { binPath: "data/new.bin", retries: 0 },
    ]);
  });

  test("returns the total queue size after enqueue", async () => {
    const q = makeQueue();
    expect(await q.enqueue("a.bin")).toBe(1);
    expect(await q.enqueue("b.bin")).toBe(2);
    expect(await q.enqueue(["c.bin", "d.bin"])).toBe(4);
  });

  test("empty array enqueue is a no-op", async () => {
    const q = makeQueue();
    await q.enqueue("a.bin");
    const size = await q.enqueue([]);
    expect(size).toBe(1);
  });

  test("throws on a malformed entry — rejects the whole batch", async () => {
    const q = makeQueue();
    await q.enqueue("a.bin");

    await expect(q.enqueue([
      "b.bin",
      { wrongKey: "no binPath here" },
      "c.bin",
    ])).rejects.toThrow(/entry 1.+binPath/);

    // Original entry untouched; no partial writes.
    const written = await readJson(q.pendingPath);
    expect(written).toEqual([{ binPath: "a.bin", retries: 0 }]);
  });

  test("rejects empty string entries", async () => {
    const q = makeQueue();
    await expect(q.enqueue("")).rejects.toThrow(/binPath/);
  });

  test("rejects null entries", async () => {
    const q = makeQueue();
    await expect(q.enqueue(null)).rejects.toThrow(/binPath/);
  });

  test("rejects number entries", async () => {
    const q = makeQueue();
    await expect(q.enqueue(42)).rejects.toThrow(/binPath/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// consume — basic
// ─────────────────────────────────────────────────────────────────────────────

describe("PendingQueue — consume basic", () => {
  test("returns empty result when nothing pending", async () => {
    const q = makeQueue();
    const result = await q.consume(async () => {});
    expect(result).toEqual({ succeeded: [], retried: [], failed: [] });
  });

  test("calls handler once per entry on a successful drain", async () => {
    const q = makeQueue();
    await q.enqueue(["a.bin", "b.bin", "c.bin"]);

    const seen = [];
    const result = await q.consume(async (entry) => { seen.push(entry.binPath); });

    expect(seen.sort()).toEqual(["a.bin", "b.bin", "c.bin"]);
    expect(result.succeeded).toHaveLength(3);
    expect(result.retried).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  test("removes pending.json after a clean drain", async () => {
    const q = makeQueue();
    await q.enqueue("a.bin");
    await q.consume(async () => {});

    expect(await readJson(q.pendingPath)).toBeNull();
    expect(await readJson(q.processingPath)).toBeNull();
  });

  test("handler receives full object form even for shorthand entries", async () => {
    // Producer wrote a string; consumer must see {binPath, retries}.
    const q = makeQueue();
    await writeJson(q.pendingPath, ["a.bin", { binPath: "b.bin", retries: 0 }]);

    const seen = [];
    await q.consume(async (entry) => {
      seen.push(entry);
    });

    expect(seen.sort((a, b) => a.binPath.localeCompare(b.binPath))).toEqual([
      { binPath: "a.bin", retries: 0 },
      { binPath: "b.bin", retries: 0 },
    ]);
  });

  test("rejects when processEntry is not a function", async () => {
    const q = makeQueue();
    await expect(q.consume("not a function")).rejects.toThrow(/must be a function/);
    await expect(q.consume(undefined)).rejects.toThrow(/must be a function/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// consume — retry tracking and failure handling
// ─────────────────────────────────────────────────────────────────────────────

describe("PendingQueue — retry tracking", () => {
  test("increments retries on a single failed entry", async () => {
    const q = makeQueue({ maxRetries: 5 });
    await q.enqueue("a.bin");

    await q.consume(async () => { throw new Error("boom"); });

    const pending = await readJson(q.pendingPath);
    expect(pending).toEqual([{ binPath: "a.bin", retries: 1 }]);

    // No failed.json yet — under maxRetries.
    expect(await readJson(q.failedPath)).toBeNull();
  });

  test("partial failure — succeeded entries vanish, failed retain retries", async () => {
    const q = makeQueue();
    await q.enqueue(["good.bin", "bad.bin", "also-good.bin"]);

    const result = await q.consume(async (entry) => {
      if (entry.binPath === "bad.bin") throw new Error("expected failure");
    });

    expect(result.succeeded.map(e => e.binPath).sort()).toEqual(["also-good.bin", "good.bin"]);
    expect(result.retried).toEqual([{ binPath: "bad.bin", retries: 1 }]);
    expect(result.failed).toHaveLength(0);

    const pending = await readJson(q.pendingPath);
    expect(pending).toEqual([{ binPath: "bad.bin", retries: 1 }]);
  });

  test("retry counter accumulates across consume cycles", async () => {
    const q = makeQueue({ maxRetries: 10 });
    await q.enqueue("flaky.bin");

    for (let i = 0; i < 4; i++) {
      await q.consume(async () => { throw new Error("still failing"); });
    }

    const pending = await readJson(q.pendingPath);
    expect(pending[0].retries).toBe(4);
  });

  test("at maxRetries, entry moves to failed.json and onPermanentFailure fires", async () => {
    const onPermanentFailure = jest.fn();
    const q = makeQueue({ maxRetries: 2, onPermanentFailure });
    await q.enqueue("dead.bin");

    // First failure: retries 0 → 1. Still under maxRetries.
    await q.consume(async () => { throw new Error("first death"); });
    expect((await readJson(q.pendingPath))[0].retries).toBe(1);
    expect(await readJson(q.failedPath)).toBeNull();
    expect(onPermanentFailure).not.toHaveBeenCalled();

    // Second failure: retries 1 → 2. Hits maxRetries, moves to failed.
    const result = await q.consume(async () => { throw new Error("final death"); });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      binPath: "dead.bin",
      retries: 2,
      lastError: "final death",
    });
    expect(result.failed[0].failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(await readJson(q.pendingPath)).toBeNull();   // gone
    const failed = await readJson(q.failedPath);
    expect(failed).toHaveLength(1);
    expect(failed[0].binPath).toBe("dead.bin");

    // The injected callback should have been called with structured details.
    expect(onPermanentFailure).toHaveBeenCalledTimes(1);
    expect(onPermanentFailure).toHaveBeenCalledWith(expect.objectContaining({
      kind:      "test",
      entryPath: "dead.bin",
      retries:   2,
      lastError: "final death",
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    }));
  });

  test("permanent failure with no onPermanentFailure callback still routes correctly", async () => {
    // No callback supplied — the entry should still end up in failed.json.
    // We just don't get notified.
    const q = makeQueue({ maxRetries: 1 });
    await q.enqueue("dead.bin");

    await q.consume(async () => { throw new Error("dead"); });

    expect(await readJson(q.pendingPath)).toBeNull();
    const failed = await readJson(q.failedPath);
    expect(failed).toHaveLength(1);
  });

  test("onPermanentFailure throwing does not break the drain", async () => {
    const onPermanentFailure = jest.fn(async () => {
      throw new Error("notifier exploded");
    });
    const q = makeQueue({ maxRetries: 1, onPermanentFailure });

    await q.enqueue(["dead1.bin", "dead2.bin"]);

    const result = await q.consume(async () => { throw new Error("handler dead"); });

    // Both entries still failed cleanly despite the notifier exploding.
    expect(result.failed).toHaveLength(2);
    expect(await readJson(q.failedPath)).toHaveLength(2);
    expect(onPermanentFailure).toHaveBeenCalledTimes(2);

    // The notifier's throw was caught and logged.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("onPermanentFailure threw"),
      expect.stringContaining("notifier exploded")
    );
  });

  test("failed.json appends rather than overwriting across drains", async () => {
    const q = makeQueue({ maxRetries: 1 });
    await q.enqueue("first.bin");
    await q.consume(async () => { throw new Error("err1"); });

    await q.enqueue("second.bin");
    await q.consume(async () => { throw new Error("err2"); });

    const failed = await readJson(q.failedPath);
    expect(failed).toHaveLength(2);
    expect(failed.map(e => e.binPath).sort()).toEqual(["first.bin", "second.bin"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AggregateError unwrapping
// ─────────────────────────────────────────────────────────────────────────────

describe("PendingQueue — AggregateError unwrapping", () => {
  test("inner messages survive into lastError when handler throws AggregateError", async () => {
    const q = makeQueue({ maxRetries: 1 });
    await q.enqueue("batch.bin");

    await q.consume(async () => {
      throw new AggregateError(
        [new Error("path A failed: parse error"), new Error("path B failed: ENOENT")],
        "batched: 2 paths failed"
      );
    });

    const failed = await readJson(q.failedPath);
    expect(failed[0].lastError).toBe("path A failed: parse error; path B failed: ENOENT");
  });

  test("regular Error keeps its plain message", async () => {
    const q = makeQueue({ maxRetries: 1 });
    await q.enqueue("a.bin");

    await q.consume(async () => { throw new Error("plain"); });

    const failed = await readJson(q.failedPath);
    expect(failed[0].lastError).toBe("plain");
  });

  test("non-Error thrown values fall back to String()", async () => {
    const q = makeQueue({ maxRetries: 1 });
    await q.enqueue("a.bin");

    await q.consume(async () => { throw "stringly-typed error"; });

    const failed = await readJson(q.failedPath);
    expect(failed[0].lastError).toBe("stringly-typed error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency / serialization
// ─────────────────────────────────────────────────────────────────────────────

describe("PendingQueue — concurrent consume", () => {
  test("two consume() calls during the same drain return the same result", async () => {
    const q = makeQueue();
    await q.enqueue(["a.bin", "b.bin"]);

    // Slow handler so we can race the second consume.
    let resolveSlow;
    const slowGate = new Promise(r => { resolveSlow = r; });

    let callCount = 0;
    const handler = async () => {
      callCount++;
      await slowGate;
    };

    const p1 = q.consume(handler);
    const p2 = q.consume(handler);   // fires while p1 is still running

    // Let them race for a tick — the lock should send p2 to await p1.
    await new Promise(r => setImmediate(r));

    resolveSlow();
    const [r1, r2] = await Promise.all([p1, p2]);

    // Handler should have been called exactly twice (once per entry,
    // NOT four times). The second consume() observed _inFlight and
    // awaited the first.
    expect(callCount).toBe(2);
    expect(r1).toBe(r2);
    expect(r1.succeeded).toHaveLength(2);
  });

  test("consume() after a prior drain runs fresh", async () => {
    const q = makeQueue();
    await q.enqueue("a.bin");
    await q.consume(async () => {});

    await q.enqueue("b.bin");
    const result = await q.consume(async () => {});
    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].binPath).toBe("b.bin");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Atomic claim and crash recovery
// ─────────────────────────────────────────────────────────────────────────────

describe("PendingQueue — atomic claim and crash recovery", () => {
  test("pending.json is renamed to .processing during drain", async () => {
    const q = makeQueue();
    await q.enqueue("a.bin");

    let processingObserved = false;
    await q.consume(async () => {
      // Inside the handler, the file should have been renamed already.
      const processing = await readJson(q.processingPath);
      const pending    = await readJson(q.pendingPath);
      if (processing && !pending) processingObserved = true;
    });

    expect(processingObserved).toBe(true);
  });

  test("recovers from a leftover .processing.json (crash midway)", async () => {
    // Simulate a previous drain that wrote .processing.json then died.
    const q = makeQueue();
    await writeJson(q.processingPath, [
      { binPath: "recovered.bin", retries: 0 },
    ]);

    const seen = [];
    const result = await q.consume(async (entry) => {
      seen.push(entry.binPath);
    });

    expect(seen).toEqual(["recovered.bin"]);
    expect(result.succeeded).toHaveLength(1);
    expect(await readJson(q.processingPath)).toBeNull();   // cleaned
  });

  test("recovery + new entries: both .processing AND .pending honored on next drain", async () => {
    // .processing.json from a crashed drain is consumed FIRST. New
    // entries that landed in pending.json between the crash and this
    // drain are NOT consumed in the same cycle — they wait for next
    // time. This is by design: the claim operation atomically swaps
    // pending → processing, but if .processing already exists, we
    // process THAT and leave pending alone until next cycle.
    const q = makeQueue();
    await writeJson(q.processingPath, [{ binPath: "crashed.bin", retries: 0 }]);
    await writeJson(q.pendingPath,    [{ binPath: "fresh.bin",   retries: 0 }]);

    const seen = [];
    await q.consume(async (entry) => { seen.push(entry.binPath); });

    expect(seen).toEqual(["crashed.bin"]);

    // Next drain picks up fresh.bin.
    const seen2 = [];
    await q.consume(async (entry) => { seen2.push(entry.binPath); });
    expect(seen2).toEqual(["fresh.bin"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Malformed entries
// ─────────────────────────────────────────────────────────────────────────────

describe("PendingQueue — malformed entries", () => {
  test("skips malformed entries on read but processes the rest", async () => {
    // Producer wrote a file with one good entry and one garbage entry.
    // We don't want to crash the drain on the garbage — we want to
    // drain what we can.
    const q = makeQueue();
    await writeJson(q.pendingPath, [
      "good.bin",
      42,                          // not a string, not an object — malformed
      { wrongKey: "no binPath" },   // object but missing pathKey
      "also-good.bin",
    ]);

    const seen = [];
    const result = await q.consume(async (entry) => { seen.push(entry.binPath); });

    expect(seen.sort()).toEqual(["also-good.bin", "good.bin"]);
    expect(result.succeeded).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/entry 1 is malformed/)
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/entry 2 is malformed/)
    );
  });

  test("non-array pending.json is discarded with a warning", async () => {
    const q = makeQueue();
    await writeJson(q.pendingPath, { not: "an array" });

    const result = await q.consume(async () => {});
    expect(result).toEqual({ succeeded: [], retried: [], failed: [] });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/did not contain an array/)
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export conventions
// ─────────────────────────────────────────────────────────────────────────────

describe("PendingQueue — module export conventions", () => {
  test("module is the class itself", () => {
    expect(typeof PendingQueue).toBe("function");
    expect(PendingQueue.prototype.constructor).toBe(PendingQueue);
  });

  test("self-referential .PendingQueue property", () => {
    expect(PendingQueue.PendingQueue).toBe(PendingQueue);
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(PendingQueue)).toBe(true);
  });

  test("instance methods exist on the prototype", () => {
    expect(typeof PendingQueue.prototype.enqueue).toBe("function");
    expect(typeof PendingQueue.prototype.consume).toBe("function");
  });
});