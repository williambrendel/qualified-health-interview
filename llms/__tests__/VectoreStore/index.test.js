"use strict";

/**
 * @file index.test.js
 * @brief Tests for the VectorStore class.
 *
 * Covers:
 *   - Array inheritance: instanceof Array, length, indexing, iteration.
 *   - Symbol.species fallback: derived methods return plain Array.
 *   - vecDim getter: empty, consistent, mixed (throws).
 *   - clear(): empties the store, returns this.
 *   - score(): composes Document.score across documents.
 *   - search(): delegates to the external search function.
 *   - load() / create(): file and directory I/O via tmpdir.
 *   - add(): variadic in-place ingestion.
 *   - remove(): variadic in-place deletion by documentId or path.
 *   - Document.score / VectorStore.score as static forms.
 *
 * The pipeline behaviors (prune, rerank, safety rails) are covered in
 * search.test.js. This file focuses on the class shape and method wiring.
 */

const fs   = require("fs").promises;
const path = require("path");
const os   = require("os");

const VectorStore = require("../../src/VectorStore");
const Document    = require("../../src/VectorStore/Document");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const v = (...components) => new Float32Array(components);

const makeDoc = (documentId, sections, vecDim = 4) =>
  Document.fromSpec({ documentId, vecDim, sections });

let tmpRoot;
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vs-class-test-"));
});
afterAll(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

const writeFixture = async (filepath, documentId) => {
  const doc = makeDoc(documentId, [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]);
  await doc.write(filepath);
};

// ─────────────────────────────────────────────────────────────────────────────
// Array inheritance
// ─────────────────────────────────────────────────────────────────────────────

describe("VectorStore — Array inheritance", () => {
  test("instanceof Array", () => {
    const store = new VectorStore();
    expect(store).toBeInstanceOf(Array);
    expect(store).toBeInstanceOf(VectorStore);
  });

  test("length and indexing work natively", () => {
    const store = new VectorStore();
    expect(store.length).toBe(0);

    const doc = makeDoc("x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]);
    store.push(doc);

    expect(store.length).toBe(1);
    expect(store[0]).toBe(doc);
  });

  test("iteration works natively", () => {
    const store = new VectorStore();
    store.push(makeDoc("a", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));
    store.push(makeDoc("b", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    const ids = [];
    for (const doc of store) ids.push(doc.documentId);
    expect(ids).toEqual(["a", "b"]);
  });

  test("Symbol.species falls back to plain Array", () => {
    const store = new VectorStore();
    store.push(makeDoc("a", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));
    store.push(makeDoc("b", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    const ids = store.map(d => d.documentId);
    expect(ids).toBeInstanceOf(Array);
    expect(ids).not.toBeInstanceOf(VectorStore);
    expect(ids).toEqual(["a", "b"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// vecDim getter
// ─────────────────────────────────────────────────────────────────────────────

describe("VectorStore — vecDim getter", () => {
  test("returns null for an empty store", () => {
    expect(new VectorStore().vecDim).toBeNull();
  });

  test("returns the common dim when all documents agree", () => {
    const store = new VectorStore();
    store.push(makeDoc("a", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }], 4));
    store.push(makeDoc("b", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }], 4));
    expect(store.vecDim).toBe(4);
  });

  test("throws when documents have inconsistent dims", () => {
    const store = new VectorStore();
    store.push(makeDoc("a", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }], 4));
    store.push(Document.fromSpec({
      documentId: "b",
      vecDim: 8,
      sections: [{ range: [0, 10], vectors: [new Float32Array(8)] }],
    }));

    expect(() => store.vecDim).toThrow(/mixed vector dimensions/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clear()
// ─────────────────────────────────────────────────────────────────────────────

describe("VectorStore — clear", () => {
  test("empties the store", () => {
    const store = new VectorStore();
    store.push(makeDoc("a", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));
    store.push(makeDoc("b", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    store.clear();
    expect(store.length).toBe(0);
  });

  test("returns this for chaining", () => {
    const store = new VectorStore();
    expect(store.clear()).toBe(store);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// score()
// ─────────────────────────────────────────────────────────────────────────────

describe("VectorStore — score", () => {
  test("composes Document.score across all documents", () => {
    const doc1 = makeDoc("doc|one", [
      { range: [0, 10],  vectors: [v(1, 0, 0, 0)] },
      { range: [10, 20], vectors: [v(0.9, 0.1, 0, 0)] },
    ]);
    const doc2 = makeDoc("doc|two", [
      { range: [0, 10], vectors: [v(0.8, 0.2, 0, 0)] },
    ]);

    const store = new VectorStore();
    store.push(doc1);
    store.push(doc2);

    const hits = store.score(v(1, 0, 0, 0));
    expect(hits.length).toBe(3);
  });

  test("returns hits in document order (NOT sorted)", () => {
    const doc1 = makeDoc("doc|one", [
      { range: [0, 10], vectors: [v(0.5, 0.5, 0.5, 0.5)] },
    ]);
    const doc2 = makeDoc("doc|two", [
      { range: [0, 10], vectors: [v(1, 0, 0, 0)] },
    ]);

    const store = new VectorStore();
    store.push(doc1);
    store.push(doc2);

    const hits = store.score(v(1, 0, 0, 0));
    expect(hits[0].documentId).toBe("doc|one");
    expect(hits[1].documentId).toBe("doc|two");
  });

  test("empty store returns an empty array", () => {
    const store = new VectorStore();
    expect(store.score(v(1, 0, 0, 0))).toEqual([]);
  });

  test("VectorStore.score(store, query) static form works equivalently", () => {
    const doc = makeDoc("x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]);
    const store = new VectorStore();
    store.push(doc);

    const fromInstance = store.score(v(1, 0, 0, 0));
    const fromStatic   = VectorStore.score(store, v(1, 0, 0, 0));

    expect(fromStatic.length).toBe(fromInstance.length);
    expect(fromStatic[0].score).toBe(fromInstance[0].score);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// search()
// ─────────────────────────────────────────────────────────────────────────────

describe("VectorStore — search", () => {
  test("delegates to the search pipeline and returns hits", () => {
    const doc = makeDoc("x", [
      { range: [0, 10],  vectors: [v(1, 0, 0, 0)] },
      { range: [10, 20], vectors: [v(0.7, 0.3, 0, 0)] },
    ]);
    const store = new VectorStore();
    store.push(doc);

    const hits = store.search(v(1, 0, 0, 0));
    expect(Array.isArray(hits)).toBe(true);

    for (const h of hits) expect(h.bestVec).toBeUndefined();
  });

  test("VectorStore.search(store, query) static form works equivalently", () => {
    const doc = makeDoc("x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]);
    const store = new VectorStore();
    store.push(doc);

    const fromInstance = store.search(v(1, 0, 0, 0));
    const fromStatic   = VectorStore.search(store, v(1, 0, 0, 0));

    expect(fromStatic.length).toBe(fromInstance.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// load() and create()
// ─────────────────────────────────────────────────────────────────────────────

describe("VectorStore — load and create", () => {
  test("instance load() reads a file into the store", async () => {
    const filepath = path.join(tmpRoot, "instance-load.bin");
    await writeFixture(filepath, "x|instance");

    const store = new VectorStore();
    await store.load(filepath);

    expect(store.length).toBe(1);
    expect(store[0].documentId).toBe("x|instance");
  });

  test("instance load() returns this for chaining", async () => {
    const filepath = path.join(tmpRoot, "chain.bin");
    await writeFixture(filepath, "x|chain");

    const store = new VectorStore();
    const result = await store.load(filepath);
    expect(result).toBe(store);
  });

  test("static create() returns a fully-loaded store", async () => {
    const filepath = path.join(tmpRoot, "create.bin");
    await writeFixture(filepath, "x|create");

    const store = await VectorStore.create(filepath);
    expect(store).toBeInstanceOf(VectorStore);
    expect(store.length).toBe(1);
    expect(store[0].documentId).toBe("x|create");
  });

  test("create() with a directory loads multiple documents", async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, "createDir-"));
    await writeFixture(path.join(dir, "a.bin"), "doc|a");
    await writeFixture(path.join(dir, "b.bin"), "doc|b");

    const store = await VectorStore.create(dir);
    expect(store.length).toBe(2);
    expect(store.map(d => d.documentId).sort()).toEqual(["doc|a", "doc|b"]);
  });

  test("load() with clear=false appends to existing contents", async () => {
    const filepathA = path.join(tmpRoot, "append-a.bin");
    const filepathB = path.join(tmpRoot, "append-b.bin");
    await writeFixture(filepathA, "set|a");
    await writeFixture(filepathB, "set|b");

    const store = new VectorStore();
    await store.load(filepathA);
    await store.load(filepathB, { clear: false });

    expect(store.length).toBe(2);
    expect(store.map(d => d.documentId).sort()).toEqual(["set|a", "set|b"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// add() — variadic in-place append
// ─────────────────────────────────────────────────────────────────────────────

describe("VectorStore — add (single input modes)", () => {
  test("adds a single file", async () => {
    const filepath = path.join(tmpRoot, "add-single-file.bin");
    await writeFixture(filepath, "single|a");

    const store = new VectorStore();
    await store.add(filepath);

    expect(store.length).toBe(1);
    expect(store[0].documentId).toBe("single|a");
  });

  test("adds a directory", async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, "add-single-dir-"));
    await writeFixture(path.join(dir, "a.bin"), "addDir|a");
    await writeFixture(path.join(dir, "b.bin"), "addDir|b");

    const store = new VectorStore();
    await store.add(dir);

    expect(store.length).toBe(2);
    expect(store.map(d => d.documentId).sort()).toEqual(["addDir|a", "addDir|b"]);
  });

  test("preserves existing documents (equivalent to load with clear: false)", async () => {
    const a = path.join(tmpRoot, "add-preserve-a.bin");
    const b = path.join(tmpRoot, "add-preserve-b.bin");
    await writeFixture(a, "preserve|a");
    await writeFixture(b, "preserve|b");

    const store = new VectorStore();
    await store.load(a);
    expect(store.length).toBe(1);

    await store.add(b);
    expect(store.length).toBe(2);
    expect(store.map(d => d.documentId).sort()).toEqual(["preserve|a", "preserve|b"]);
  });
});

describe("VectorStore — add (variadic)", () => {
  test("accepts multiple positional arguments", async () => {
    const a = path.join(tmpRoot, "add-var-a.bin");
    const b = path.join(tmpRoot, "add-var-b.bin");
    const c = path.join(tmpRoot, "add-var-c.bin");
    await writeFixture(a, "var|a");
    await writeFixture(b, "var|b");
    await writeFixture(c, "var|c");

    const store = new VectorStore();
    await store.add(a, b, c);

    expect(store.length).toBe(3);
    expect(store.map(d => d.documentId).sort()).toEqual(["var|a", "var|b", "var|c"]);
  });

  test("accepts an array of paths", async () => {
    const a = path.join(tmpRoot, "add-arr-a.bin");
    const b = path.join(tmpRoot, "add-arr-b.bin");
    await writeFixture(a, "arr|a");
    await writeFixture(b, "arr|b");

    const store = new VectorStore();
    await store.add([a, b]);

    expect(store.length).toBe(2);
  });

  test("flat(Infinity) unrolls nested arrays", async () => {
    const a = path.join(tmpRoot, "add-nest-a.bin");
    const b = path.join(tmpRoot, "add-nest-b.bin");
    const c = path.join(tmpRoot, "add-nest-c.bin");
    await writeFixture(a, "nest|a");
    await writeFixture(b, "nest|b");
    await writeFixture(c, "nest|c");

    const store = new VectorStore();
    await store.add([[a], [[b, c]]]);

    expect(store.length).toBe(3);
  });

  test("mixes paths and arrays in one call", async () => {
    const a = path.join(tmpRoot, "add-mix-a.bin");
    const b = path.join(tmpRoot, "add-mix-b.bin");
    const c = path.join(tmpRoot, "add-mix-c.bin");
    await writeFixture(a, "mix|a");
    await writeFixture(b, "mix|b");
    await writeFixture(c, "mix|c");

    const store = new VectorStore();
    await store.add(a, [b, c]);

    expect(store.length).toBe(3);
  });

  test("empty variadic call returns store with no changes", async () => {
    const store = new VectorStore();
    const result = await store.add();
    expect(result).toBe(store);
    expect(store.length).toBe(0);
  });

  test("empty array call returns store with no changes", async () => {
    const store = new VectorStore();
    const result = await store.add([]);
    expect(result).toBe(store);
    expect(store.length).toBe(0);
  });

  test("returns this for chaining", async () => {
    const a = path.join(tmpRoot, "add-chain.bin");
    await writeFixture(a, "chain|a");

    const store = new VectorStore();
    const result = await store.add(a);
    expect(result).toBe(store);
  });
});

describe("VectorStore — add (input validation)", () => {
  test("throws on non-string entries", async () => {
    const store = new VectorStore();
    await expect(store.add(42)).rejects.toThrow(/must be a non-empty string/);
    await expect(store.add(null)).rejects.toThrow(/must be a non-empty string/);
    await expect(store.add({})).rejects.toThrow(/must be a non-empty string/);
  });

  test("throws on empty string", async () => {
    const store = new VectorStore();
    await expect(store.add("")).rejects.toThrow(/must be a non-empty string/);
  });

  test("validation is upfront — does not load any path if one is invalid", async () => {
    const a = path.join(tmpRoot, "add-validation-a.bin");
    await writeFixture(a, "validation|a");

    const store = new VectorStore();
    await expect(store.add(a, 42)).rejects.toThrow(/must be a non-empty string/);
    expect(store.length).toBe(0);
  });
});

describe("VectorStore — add (partial failure)", () => {
  test("throws AggregateError when one path fails to load", async () => {
    const ok = path.join(tmpRoot, "add-agg-ok.bin");
    await writeFixture(ok, "agg|ok");

    const missing = path.join(tmpRoot, "add-agg-missing.bin");

    const store = new VectorStore();

    let err;
    try {
      await store.add(ok, missing);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(AggregateError);
    expect(err.errors.length).toBeGreaterThanOrEqual(1);
    expect(err.errors.some(e => e.message.includes("add-agg-missing"))).toBe(true);

    expect(store.length).toBe(1);
    expect(store[0].documentId).toBe("agg|ok");
  });

  test("all paths fail → AggregateError with all errors", async () => {
    const missing1 = path.join(tmpRoot, "add-all-fail-1.bin");
    const missing2 = path.join(tmpRoot, "add-all-fail-2.bin");

    const store = new VectorStore();

    let err;
    try {
      await store.add(missing1, missing2);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(AggregateError);
    expect(err.errors.length).toBe(2);
    expect(store.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// remove() — variadic in-place deletion by documentId or path
// ─────────────────────────────────────────────────────────────────────────────

describe("VectorStore — remove (single input modes)", () => {
  test("removes a single documentId", () => {
    const store = new VectorStore();
    store.push(makeDoc("a|x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));
    store.push(makeDoc("b|y", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));
    store.push(makeDoc("c|z", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    const removed = store.remove("b|y");
    expect(removed).toBe(1);
    expect(store.length).toBe(2);
    expect(store.map(d => d.documentId)).toEqual(["a|x", "c|z"]);
  });

  test("removes multiple documentIds as separate args", () => {
    const store = new VectorStore();
    for (const id of ["a|x", "b|y", "c|z", "d|w"]) {
      store.push(makeDoc(id, [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));
    }

    expect(store.remove("a|x", "c|z")).toBe(2);
    expect(store.map(d => d.documentId)).toEqual(["b|y", "d|w"]);
  });

  test("accepts an array of documentIds", () => {
    const store = new VectorStore();
    for (const id of ["a|x", "b|y", "c|z"]) {
      store.push(makeDoc(id, [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));
    }

    expect(store.remove(["a|x", "b|y"])).toBe(2);
    expect(store.map(d => d.documentId)).toEqual(["c|z"]);
  });

  test("flat(Infinity) unrolls nested arrays", () => {
    const store = new VectorStore();
    for (const id of ["a|x", "b|y", "c|z", "d|w"]) {
      store.push(makeDoc(id, [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));
    }

    expect(store.remove([["a|x"], ["b|y", "c|z"]])).toBe(3);
    expect(store.map(d => d.documentId)).toEqual(["d|w"]);
  });

  test("empty input returns 0 with no warnings", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new VectorStore();
      store.push(makeDoc("a|x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

      expect(store.remove()).toBe(0);
      expect(store.remove([])).toBe(0);
      expect(store.length).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("VectorStore — remove (path inputs are normalized)", () => {
  // Inputs route through deriveDocumentId, so paths AND already-formed
  // ids both work. This is the documented contract.

  test("accepts a file path (derives to documentId)", () => {
    const store = new VectorStore();
    store.push(makeDoc("biology|overview", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    const removed = store.remove("biology/overview.md");
    expect(removed).toBe(1);
    expect(store.length).toBe(0);
  });

  test("accepts a full filesystem path", () => {
    const store = new VectorStore();
    store.push(makeDoc("biology|overview", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    const removed = store.remove("/abs/path/to/biology/overview.md");
    expect(removed).toBe(1);
  });

  test("accepts a path with timestamp suffix", () => {
    const store = new VectorStore();
    store.push(makeDoc("biology|overview", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    const removed = store.remove("biology/overview|md_2026-04-22T02-28-30-099Z.md");
    expect(removed).toBe(1);
  });

  test("mixing path and id inputs in one call dedups by derived id", () => {
    // Both inputs derive to "biology|overview" — the Map collapses
    // them into one target, the store has one matching document,
    // removes once.
    const store = new VectorStore();
    store.push(makeDoc("biology|overview", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    const removed = store.remove("biology|overview", "biology/overview.md");
    expect(removed).toBe(1);
  });
});

describe("VectorStore — remove (unknown documentIds)", () => {
  let warnSpy;
  beforeEach(() => { warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(()  => { warnSpy.mockRestore(); });

  test("warn-and-continue on unknown id", () => {
    const store = new VectorStore();
    store.push(makeDoc("a|x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));
    store.push(makeDoc("b|y", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    const removed = store.remove("a|x", "missing|doc");
    expect(removed).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`"missing|doc"`));
  });

  test("warning uses the ORIGINAL input string, not the derived id", () => {
    // A user-typed path should appear verbatim in the warning,
    // not as the derived "theme|stem" form.
    const store = new VectorStore();

    store.remove("missing/path.md");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`"missing/path.md"`));
  });

  test("removing only unknown ids returns 0, store untouched", () => {
    const store = new VectorStore();
    store.push(makeDoc("a|x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    expect(store.remove("x|missing", "y|missing")).toBe(0);
    expect(store.length).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test("removing the same id twice in one call removes once, no warning", () => {
    // The targets Map deduplicates by derived id.
    const store = new VectorStore();
    store.push(makeDoc("a|x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    const removed = store.remove("a|x", "a|x");
    expect(removed).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("duplicate unknown id warns once", () => {
    const store = new VectorStore();
    store.push(makeDoc("a|x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    store.remove("missing|x", "missing|x");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("VectorStore — remove (garbage inputs don't throw)", () => {
  let warnSpy;
  beforeEach(() => { warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(()  => { warnSpy.mockRestore(); });

  test("derive-throwing input is treated as unknown, not fatal", () => {
    // "!!!" sanitizes to empty stem → deriveDocumentId throws.
    // remove() catches and adds it to the unknown set, warns.
    const store = new VectorStore();
    store.push(makeDoc("a|x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    expect(() => store.remove("!!!", "a|x")).not.toThrow();
    // The valid "a|x" still got removed.
    expect(store.length).toBe(0);
    // The garbage input warned.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`"!!!"`));
  });

  test("multiple derive-throwing inputs all warn, none fatal", () => {
    const store = new VectorStore();

    expect(() => store.remove("!!!", "???", "***")).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });
});

describe("VectorStore — remove (validation)", () => {
  test("throws on non-string id", () => {
    const store = new VectorStore();
    store.push(makeDoc("a|x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    expect(() => store.remove(42)).toThrow(/must be a non-empty string/);
    expect(store.length).toBe(1);
  });

  test("throws on empty string id", () => {
    const store = new VectorStore();
    store.push(makeDoc("a|x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    expect(() => store.remove("")).toThrow(/must be a non-empty string/);
  });

  test("validates ALL ids before mutating (no partial removal)", () => {
    const store = new VectorStore();
    store.push(makeDoc("a|x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));
    store.push(makeDoc("b|y", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));

    expect(() => store.remove("a|x", 42)).toThrow(/must be a non-empty string/);
    expect(store.length).toBe(2);
  });
});

describe("VectorStore — remove (integrity)", () => {
  test("removing from large store preserves order of survivors", () => {
    const store = new VectorStore();
    for (const id of ["a|x", "b|x", "c|x", "d|x", "e|x", "f|x"]) {
      store.push(makeDoc(id, [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));
    }

    store.remove("b|x", "d|x", "f|x");
    expect(store.map(d => d.documentId)).toEqual(["a|x", "c|x", "e|x"]);
  });

  test("removing all documents leaves empty store", () => {
    const store = new VectorStore();
    for (const id of ["a|x", "b|x", "c|x"]) {
      store.push(makeDoc(id, [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]));
    }

    expect(store.remove("a|x", "b|x", "c|x")).toBe(3);
    expect(store.length).toBe(0);
  });

  test("remove returns 0 on empty store", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new VectorStore();
      expect(store.remove("missing|x")).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("subsequent search reflects removal", () => {
    const doc1 = makeDoc("keep|x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]);
    const doc2 = makeDoc("drop|x", [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }]);
    const store = new VectorStore();
    store.push(doc1);
    store.push(doc2);

    store.remove("drop|x");

    const hits = store.score(v(1, 0, 0, 0));
    expect(hits.every(h => h.documentId === "keep|x")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export conventions
// ─────────────────────────────────────────────────────────────────────────────

describe("VectorStore — module export conventions", () => {
  test("the export is the class itself", () => {
    expect(typeof VectorStore).toBe("function");
    expect(VectorStore.prototype.constructor).toBe(VectorStore);
  });

  test("exposes a self-referential .VectorStore property", () => {
    expect(VectorStore.VectorStore).toBe(VectorStore);
  });

  test("the exported class is frozen", () => {
    expect(Object.isFrozen(VectorStore)).toBe(true);
  });

  test("remove method exists on prototype", () => {
    expect(typeof VectorStore.prototype.remove).toBe("function");
  });
});