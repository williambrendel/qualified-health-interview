"use strict";

/**
 * @file PendingQueue.js
 * @module PendingQueue
 * @description Durable retry-tracking queue backing live-load
 * mechanisms (e.g. VectorStore and SectionResolver hot-add in a
 * long-running server).
 *
 * Generic and self-contained: knows nothing about vectors, sections,
 * or RAG. The pattern it implements — "drop work items in a JSON
 * sidecar, process them lazily on next request, track per-item
 * retries, escalate permanent failures" — fits any long-running
 * service that needs to ingest out-of-band work without restarting.
 *
 * ## Pattern
 *
 * The producer (a build endpoint, a cron, a manual script) appends
 * entries to a pending JSON sidecar. The consumer (typically the
 * request handler at the entry point of a hot path) checks the
 * sidecar at the top of each request — if there's work, it processes
 * it lazily before answering. After a successful drain the sidecar
 * is gone, and subsequent requests pay only an `fs.exists` check.
 *
 * ## Safety properties
 *
 * 1. **In-process concurrency lock.** Two requests arriving at the
 *    same instant could both observe pending.json. Without a lock,
 *    they'd both try to load the same entries. The lock is a Promise
 *    that the first caller creates and subsequent callers await.
 *
 * 2. **Crash-safety via atomic rename.** Before reading, the queue
 *    atomically renames pending.json → pending.processing.json. If
 *    the process crashes mid-load, the .processing.json file is
 *    picked up on next drain. POSIX rename is atomic — two processes
 *    cannot both succeed.
 *
 * 3. **Retry tracking per entry.** Each entry carries a `retries`
 *    counter. On handler failure, the counter increments. At
 *    `maxRetries`, the entry moves to .failed.json with the last
 *    error attached, and `notifyPermanentFailure()` fires so an
 *    operator can investigate.
 *
 * 4. **Augment, don't overwrite.** `enqueue()` reads existing
 *    pending entries first, appends, then writes back via temp file
 *    + rename. Two concurrent producers won't lose entries.
 *
 * 5. **Parallel processing.** During a drain, all entries fire
 *    concurrently through the handler via `Promise.allSettled`,
 *    so a slow item doesn't block the rest. Per-entry outcomes
 *    are tracked independently.
 *
 * ## File shapes
 *
 * `pending.json` — array of pending entries. Two shapes are accepted
 * and the queue normalizes the shorthand to the full form on read.
 *
 * **Shorthand (string):** a bare path. Equivalent to
 * `{ <pathKey>: "<the string>", retries: 0 }`. Convenient for
 * producers that don't need to set custom fields.
 *
 * **Full (object):** `{ <pathKey>: "...", retries: N, ...anything }`.
 * Custom fields pass through untouched. The queue requires only
 * that an entry have `retries` (defaulted to 0 by `enqueue`) and
 * carries `<pathKey>` for human-readable failure messages.
 *
 * Mixed within one file is fine:
 * ```json
 * [
 *   "data/.../new-doc.bin",
 *   { "binPath": "data/.../another.bin", "retries": 2 },
 *   "data/.../third.bin"
 * ]
 * ```
 *
 * `failed.json` — full form only, plus `lastError` and `failedAt`:
 *
 * ```json
 * [
 *   {
 *     "binPath": "data/.../corrupt.bin",
 *     "retries": 5,
 *     "lastError": "VECT magic mismatch",
 *     "failedAt": "2026-05-19T17:30:00.000Z"
 *   }
 * ]
 * ```
 */

const fs   = require("fs").promises;
const path = require("path");

/**
 * Flatten an Error to a readable message string. If it's an
 * AggregateError (or any error with a `.errors` array), join the
 * inner messages so the diagnostic detail survives into
 * `failed.json`.
 *
 * VectorStore.add and SectionResolver.add can throw AggregateError
 * when one path in a batched call fails — the outer message says
 * "3/5 paths failed" but the actionable detail (which paths, why)
 * lives in `.errors`. Without unwrapping we'd persist a useless
 * summary; with unwrapping the operator sees exactly what to fix.
 *
 * @private
 * @param {Error|AggregateError} err
 * @returns {string}
 */
const flattenErrorMessage = (err) => {
  if (err && Array.isArray(err.errors) && err.errors.length > 0) {
    return err.errors.map(e => e.message).join("; ");
  }
  return err && err.message ? err.message : String(err);
};

/**
 * @class PendingQueue
 * @description File-backed retry queue with atomic claim and
 * in-process serialization.
 */
class PendingQueue {
  /**
   * @param {object} options
   * @param {string} options.pendingPath - Absolute path to the
   *   pending JSON sidecar. The producer writes entries here; the
   *   consumer reads, processes, and clears.
   * @param {string} options.failedPath  - Absolute path to the
   *   permanent-failure JSON sidecar. Entries that exhaust retries
   *   land here.
   * @param {string} options.pathKey     - The key name used when
   *   converting shorthand string entries to full object entries.
   *   For a binary queue, pass `"binPath"`; for a markdown queue,
   *   pass `"mdPath"`. Also used in log/notify messages to
   *   identify which entry failed.
   * @param {number} [options.maxRetries=5] - How many times an
   *   entry may fail before being moved to failedPath. After this
   *   many failures, `onPermanentFailure` fires (if provided).
   * @param {string} [options.kind="entries"] - Human-readable label
   *   used in the permanent-failure callback (e.g. "bins" or
   *   "markdowns"). Distinguishes one queue from another when the
   *   same caller handles several.
   * @param {(details: {
   *   kind: string,
   *   entryPath: string,
   *   retries: number,
   *   lastError: string,
   *   timestamp: string,
   *   entry: object,
   * }) => (void|Promise<void>)} [options.onPermanentFailure]
   *   Callback invoked when an entry is moved to failedPath after
   *   exhausting retries. The queue does not assume any particular
   *   notification mechanism — pass whatever fits the caller's
   *   environment (console logging, email, Slack, PagerDuty, etc).
   *   Errors thrown from the callback are caught and logged so the
   *   drain isn't broken by a flaky notifier. Defaults to a no-op.
   */
  constructor({
    pendingPath,
    failedPath,
    pathKey,
    maxRetries = 5,
    kind = "entries",
    onPermanentFailure,
  } = {}) {
    if (!pendingPath) throw new Error("PendingQueue: pendingPath is required");
    if (!failedPath)  throw new Error("PendingQueue: failedPath is required");
    if (!pathKey)     throw new Error("PendingQueue: pathKey is required (e.g. 'binPath' or 'mdPath')");

    this.pendingPath        = pendingPath;
    this.failedPath         = failedPath;
    this.processingPath     = `${pendingPath}.processing`;
    this.pathKey            = pathKey;
    this.maxRetries         = maxRetries;
    this.kind               = kind;
    this.onPermanentFailure = typeof onPermanentFailure === "function"
      ? onPermanentFailure
      : null;

    /**
     * In-process lock. When a consume() is in progress, this holds
     * the Promise that will resolve once the drain finishes. Other
     * consume() calls arriving during a drain await the same Promise
     * and return its result, so they don't all stampede the file
     * system.
     *
     * Null when no drain is in progress.
     *
     * @private
     * @type {Promise<object>|null}
     */
    this._inFlight = null;
  }

  /**
   * Normalize a raw entry from the pending file into the full
   * object form `{ <pathKey>: string, retries: number, ... }`.
   *
   * Three input shapes are accepted:
   *   - **Non-empty string** → `{ [pathKey]: string, retries: 0 }`
   *   - **Object with the path key** → spread, with `retries` defaulted to 0
   *   - **Anything else** → returns null (caller logs + skips)
   *
   * @private
   * @param {*} raw
   * @returns {object|null}
   */
  _normalize(raw) {
    if (typeof raw === "string" && raw.length > 0) {
      return { [this.pathKey]: raw, retries: 0 };
    }
    if (raw && typeof raw === "object" && typeof raw[this.pathKey] === "string" && raw[this.pathKey].length > 0) {
      return { retries: 0, ...raw };
    }
    return null;
  }

  /**
   * Append new entries to the pending queue. Reads existing entries
   * first (if any), normalizes everything to the full object form,
   * appends, writes back atomically via temp file + rename.
   *
   * Each argument may be a single entry, an array of entries, or
   * mixed shorthand+object. All are normalized via `_normalize`.
   *
   * @async
   * @param {string|object|Array<string|object>} entries - One entry
   *   or an array of them. Strings are shorthand for
   *   `{ [pathKey]: string }`; objects must carry `[pathKey]`.
   * @returns {Promise<number>} Total queue size after enqueueing.
   *
   * @throws {Error} If any entry can't be normalized.
   */
  async enqueue(entries) {
    const incoming = Array.isArray(entries) ? entries : [entries];
    if (incoming.length === 0) return this._sizeFromFile(this.pendingPath);

    // Normalize all incoming first. Reject the whole batch if any
    // entry is malformed — don't leave a half-good queue behind.
    const normalized = [];
    for (let i = 0; i < incoming.length; i++) {
      const norm = this._normalize(incoming[i]);
      if (!norm) {
        throw new Error(
          `PendingQueue.enqueue: entry ${i} is not a non-empty string or an object with "${this.pathKey}"`
        );
      }
      normalized.push(norm);
    }

    // Ensure parent directory exists. Producers may be writing the
    // first ever entry into a fresh data dir.
    await fs.mkdir(path.dirname(this.pendingPath), { recursive: true });

    // Existing entries are read raw (could be shorthand strings)
    // and normalized on the spot, so we always rewrite the file in
    // the canonical full object form.
    const existingRaw = await this._readSafe(this.pendingPath);
    const existing    = existingRaw.map(e => this._normalize(e)).filter(Boolean);

    const next = [...existing, ...normalized];

    await this._writeAtomic(this.pendingPath, next);
    return next.length;
  }

  /**
   * Consume the pending queue: claim it atomically, hand entries to
   * the caller's `processEntry` callback in parallel, track retries,
   * and clean up.
   *
   * All entries fire concurrently via `Promise.allSettled`. Per-entry
   * outcomes are tracked independently — one failing entry doesn't
   * abort the rest, and the retry counter advances only on the
   * specific entries that rejected. A thrown error increments the
   * entry's retries; an entry that hits `maxRetries` is moved to
   * failedPath and `notifyPermanentFailure` fires.
   *
   * Concurrent callers across the process serialize through
   * `_inFlight` — only one drain runs at a time, and all callers
   * receive the same result.
   *
   * The handler always receives the full object form, regardless of
   * how the entry was originally written in pending.json. Pull the
   * path via `entry[queue.pathKey]` (or destructure by name).
   *
   * @async
   * @param {(entry: object) => Promise<void>} processEntry - Async
   *   handler called once per pending entry. Throw to indicate the
   *   entry should be retried later. AggregateError thrown by the
   *   handler (e.g. from VectorStore.add or SectionResolver.add
   *   when a batched call partially failed) has its inner messages
   *   joined into the persisted `lastError`.
   *
   * @returns {Promise<{
   *   succeeded: object[],
   *   retried:   object[],
   *   failed:    object[]
   * }>}
   */
  consume(processEntry) {
    if (typeof processEntry !== "function") {
      return Promise.reject(new Error("PendingQueue.consume: processEntry must be a function"));
    }

    // Serialize across the process. If a drain is in progress, await
    // its result instead of starting a second drain.
    if (this._inFlight) return this._inFlight;

    this._inFlight = this._drain(processEntry).finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  // ───────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────

  /**
   * The actual drain logic. Called once per concurrency window.
   *
   * Entries are processed in parallel via `Promise.allSettled` —
   * one entry's failure must not stop the others, since retry
   * tracking is per-entry.
   *
   * @private
   * @async
   */
  async _drain(processEntry) {
    const entries = await this._claim();
    if (entries.length === 0) {
      return { succeeded: [], retried: [], failed: [] };
    }

    const settled = await Promise.allSettled(
      entries.map(entry => processEntry(entry))
    );

    const succeeded = [];
    const retried   = [];
    const failed    = [];

    for (let i = 0; i < entries.length; i++) {
      const entry  = entries[i];
      const result = settled[i];

      if (result.status === "fulfilled") {
        succeeded.push(entry);
        continue;
      }

      const err         = result.reason;
      const lastError   = flattenErrorMessage(err);
      const nextRetries = (entry.retries || 0) + 1;

      if (nextRetries >= this.maxRetries) {
        const failedEntry = {
          ...entry,
          retries:   nextRetries,
          lastError,
          failedAt:  new Date().toISOString(),
        };
        failed.push(failedEntry);

        // Fire the caller-provided permanent-failure callback, if any.
        // Don't let a flaky notifier break the drain — the entry is
        // already in `failed`, and we'd rather move on. The callback
        // gets both the structured details (good for templating an
        // email) and the raw entry (good for callers who want full
        // control over how they format the notification).
        if (this.onPermanentFailure) {
          try {
            await this.onPermanentFailure({
              kind:      this.kind,
              entryPath: entry[this.pathKey] || JSON.stringify(entry),
              retries:   nextRetries,
              lastError,
              timestamp: failedEntry.failedAt,
              entry:     failedEntry,
            });
          } catch (notifyErr) {
            console.error(
              `PendingQueue (${this.kind}): onPermanentFailure threw:`,
              notifyErr.message
            );
          }
        }
      } else {
        retried.push({ ...entry, retries: nextRetries });
      }
    }

    if (retried.length > 0) {
      await this._writeAtomic(this.pendingPath, retried);
    }
    if (failed.length > 0) {
      const existingFailed = await this._readSafe(this.failedPath);
      await this._writeAtomic(this.failedPath, [...existingFailed, ...failed]);
    }

    await fs.unlink(this.processingPath).catch(() => {});

    return { succeeded, retried, failed };
  }

  /**
   * Atomically claim the pending file by renaming it to
   * processing.json, then read, parse, and normalize its contents.
   * Returns [] if nothing was pending.
   *
   * The rename is the synchronization primitive that prevents two
   * processes from both claiming the same entries. POSIX `rename`
   * is atomic; whichever process renames first wins, and the loser
   * sees ENOENT.
   *
   * Recovery: if a .processing.json exists from a prior crashed
   * drain, we process THAT first and leave .pending alone — fresh
   * entries wait for the next drain cycle. We must check before
   * the rename, because fs.rename overwrites the destination on
   * most filesystems; renaming pending → processing would clobber
   * the crashed entries and lose them silently.
   *
   * @private
   * @async
   * @returns {Promise<object[]>}
   */
  async _claim() {
    // Check first: did a prior drain crash, leaving .processing.json
    // behind? If so, recover that file's entries WITHOUT touching
    // .pending.json — fresh entries wait for the next cycle.
    //
    // Without this check, the rename below would overwrite the
    // crashed file's contents with the fresh pending entries,
    // silently losing whatever was being processed at crash time.
    let processingExists = false;
    try {
      await fs.access(this.processingPath);
      processingExists = true;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    if (!processingExists) {
      // Normal path: atomically claim pending → processing.
      try {
        await fs.rename(this.pendingPath, this.processingPath);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
        // Nothing to claim, nothing to recover.
        return [];
      }
    }

    // Read .processing.json (either freshly claimed or recovered).
    let parsed;
    try {
      const buf = await fs.readFile(this.processingPath, "utf8");
      parsed = JSON.parse(buf);
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }

    if (!Array.isArray(parsed)) {
      console.warn(`PendingQueue: ${this.processingPath} did not contain an array; discarding.`);
      await fs.unlink(this.processingPath).catch(() => {});
      return [];
    }

    // Normalize on read. Drop (and log) any entries that don't fit
    // either shape — better than crashing the drain on a single
    // malformed line in an otherwise-good file.
    const normalized = [];
    for (let i = 0; i < parsed.length; i++) {
      const norm = this._normalize(parsed[i]);
      if (norm) {
        normalized.push(norm);
      } else {
        console.warn(
          `PendingQueue: ${this.processingPath} entry ${i} is malformed — ` +
          `expected non-empty string or object with "${this.pathKey}". Skipping.`
        );
      }
    }

    return normalized;
  }

  /**
   * Read a JSON array file safely. Returns [] if the file doesn't
   * exist; throws on any other error so corruption is surfaced.
   *
   * @private
   * @async
   * @param {string} filepath
   * @returns {Promise<object[]>}
   */
  async _readSafe(filepath) {
    try {
      const buf = await fs.readFile(filepath, "utf8");
      const parsed = JSON.parse(buf);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }

  /**
   * Read a file's size (entry count) without loading it. Used by
   * `enqueue` to return the post-enqueue queue length.
   *
   * @private
   * @async
   */
  async _sizeFromFile(filepath) {
    const arr = await this._readSafe(filepath);
    return arr.length;
  }

  /**
   * Atomic write: write to a sibling temp file, then rename over
   * the target. Guarantees the target is never observed in a
   * half-written state — readers either see the old version or the
   * new version, never a partial JSON document.
   *
   * @private
   * @async
   */
  async _writeAtomic(filepath, data) {
    const tmpPath = `${filepath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmpPath, filepath);
  }
}

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(PendingQueue, "PendingQueue", {
  value: PendingQueue,
}));