"use strict";

/**
 * @file sessionCache.js
 * @module server/sessionCache
 * @description Session store for parsed-and-augmented timelines, keyed by
 * sessionId. Powers `/reanalyze` and `/series`: `/analyze` parses the file once,
 * caches the timeline, and returns a sessionId; the other endpoints look the
 * timeline up (re-running analysis / shaping series) without re-parsing.
 *
 * ## Two tiers
 *
 *   - **Memory** (LRU Map): fast, `MAX_SESSIONS` cap, 1h idle TTL.
 *   - **Disk** (`SESSION_STORE_DIR`): every parsed timeline is also written to
 *     disk, so a session survives a process restart, LRU eviction, and the
 *     memory TTL. A memory miss falls back to disk and revives into memory.
 *     Disk copies are swept after `DISK_MAX_AGE_MS`.
 *
 * This is the pragmatic persistence bridge (option A): the `create/get` contract
 * is exactly what a real datastore (K-theme) would slot behind later.
 *
 * ## Serialization
 *
 * The timeline carries **non-enumerable** `provenance` and `schema` that
 * `JSON.stringify` would drop, so they're captured/restored explicitly. Cell
 * sentinels are primitives (MISSING_DATA=null, NOT_APPLICABLE=absent), which
 * round-trip cleanly through JSON.
 *
 * ## API
 *
 *   const id = sessionCache.create(timeline);
 *   const session = sessionCache.get(id);   // null if unknown/expired on both tiers
 *   const stats = sessionCache.stats();
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TTL_MS              = 60 * 60 * 1000;        // 1 hour idle in MEMORY
const MAX_SESSIONS        = 50;                    // memory cap
const CLEANUP_INTERVAL_MS =  5 * 60 * 1000;        // 5 minutes
const DISK_MAX_AGE_MS     = 7 * 24 * 60 * 60 * 1000; // 7 days on DISK

const STORE_DIR = process.env.SESSION_STORE_DIR || path.join(__dirname, "..", "..", ".session-store");

const sessions = new Map();   // sessionId -> { timeline, createdAt, lastAccessAt }

try {
  fs.mkdirSync(STORE_DIR, { recursive: true });
} catch (e) {
  console.error("[sessionCache] could not create store dir; disk persistence disabled:", e.message);
}

const fileFor = (id) => path.join(STORE_DIR, `${id}.json`);

// Capture the array rows plus the non-enumerable provenance/schema.
const serialize = (timeline) =>
  JSON.stringify({ v: 1, rows: Array.from(timeline), provenance: timeline.provenance || null, schema: timeline.schema || null });

// Rebuild the timeline array with provenance/schema re-attached (non-enumerable,
// mirroring the parser) so downstream dispatch sees the same shape.
const deserialize = (json) => {
  const p = JSON.parse(json);
  const rows = Array.isArray(p.rows) ? p.rows : [];
  Object.defineProperty(rows, "provenance", { value: p.provenance || undefined, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(rows, "schema", { value: p.schema || undefined, enumerable: false, configurable: true, writable: true });
  return rows;
};

const persist = (id, timeline) => {
  let data;
  try {
    data = serialize(timeline);
  } catch (e) {
    console.error("[sessionCache] serialize failed:", e.message);
    return;
  }
  fs.writeFile(fileFor(id), data, (err) => {
    if (err) console.error("[sessionCache] persist failed:", err.message);
  });
};

const loadFromDisk = (id) => {
  const f = fileFor(id);
  let stat;
  try {
    stat = fs.statSync(f);
  } catch (_) {
    return null; // not on disk
  }
  if (Date.now() - stat.mtimeMs > DISK_MAX_AGE_MS) {
    try { fs.unlinkSync(f); } catch (_) { /* ignore */ }
    return null;
  }
  try {
    return deserialize(fs.readFileSync(f, "utf8"));
  } catch (e) {
    console.error("[sessionCache] load failed:", e.message);
    return null;
  }
};

const create = (timeline) => {
  const id = crypto.randomUUID();
  const now = Date.now();
  sessions.set(id, { timeline, createdAt: now, lastAccessAt: now });
  evictIfFull();
  persist(id, timeline);
  return id;
};

const get = (sessionId) => {
  if (typeof sessionId !== "string") return null;

  const s = sessions.get(sessionId);
  if (s) {
    if (Date.now() - s.lastAccessAt <= TTL_MS) {
      s.lastAccessAt = Date.now();
      return s;
    }
    sessions.delete(sessionId); // memory-expired; fall through to disk
  }

  // Disk fallback — survives restart, LRU eviction, and the memory TTL.
  const timeline = loadFromDisk(sessionId);
  if (!timeline) return null;
  const now = Date.now();
  const revived = { timeline, createdAt: now, lastAccessAt: now };
  sessions.set(sessionId, revived);
  evictIfFull();
  return revived;
};

const evictIfFull = () => {
  if (sessions.size <= MAX_SESSIONS) return;
  // LRU by lastAccessAt. Evicts from MEMORY only — the disk copy remains and can
  // be revived by a later get().
  const sorted = [...sessions.entries()].sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);
  while (sessions.size > MAX_SESSIONS) {
    const [id] = sorted.shift();
    sessions.delete(id);
  }
};

const cleanup = () => {
  const memCutoff = Date.now() - TTL_MS;
  for (const [id, s] of sessions) if (s.lastAccessAt < memCutoff) sessions.delete(id);

  // Sweep stale disk copies.
  const diskCutoff = Date.now() - DISK_MAX_AGE_MS;
  try {
    for (const f of fs.readdirSync(STORE_DIR)) {
      if (!f.endsWith(".json")) continue;
      const fp = path.join(STORE_DIR, f);
      try { if (fs.statSync(fp).mtimeMs < diskCutoff) fs.unlinkSync(fp); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* store dir gone */ }
};

// Periodic cleanup. `unref()` so the timer doesn't keep the process alive.
const interval = setInterval(cleanup, CLEANUP_INTERVAL_MS);
if (interval.unref) interval.unref();

const stats = () => ({
  size:        sessions.size,
  maxSessions: MAX_SESSIONS,
  ttlMs:       TTL_MS,
  storeDir:    STORE_DIR,
  diskMaxAgeMs: DISK_MAX_AGE_MS,
});

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
const sessionCache = Object.freeze({ create, get, stats });
module.exports = sessionCache;
