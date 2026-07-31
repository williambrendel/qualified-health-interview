"use strict";

/**
 * @file load.test.js
 * @brief Tests for the standalone load function.
 *
 * `load(store, inputPath, options)` is the lower-level entry point that
 * `VectorStore#load` and `VectorStore.create` delegate to. These tests
 * verify the dispatch (file vs directory), the `clear` option, atomicity
 * on parse failure, and the side effect on the passed-in store.
 *
 * The loadKnowledgeBase tests already exercise the end-to-end happy
 * path; this file focuses on the specific behaviors of `load` that the
 * wrapper hides.
 */

const fs   = require("fs").promises;
const path = require("path");
const os   = require("os");

const load        = require("../../src/VectorStore/load");
const VectorStore = require("../../src/VectorStore");
const Document    = require("../../src/VectorStore/Document");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const v = (...components) => new Float32Array(components);

let tmpRoot;
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vs-load-test-"));
});
afterAll(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

const writeFixture = async (filepath, documentId) => {
  const doc = Document.fromSpec({
    documentId,
    vecDim: 4,
    sections: [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }],
  });
  await doc.write(filepath);
};

// ─────────────────────────────────────────────────────────────────────────────
// Single-file vs directory dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe("load — input dispatch", () => {
  test("loads a single .bin file into a store of one Document", async () => {
    const filepath = path.join(tmpRoot, "single.bin");
    await writeFixture(filepath, "x|single");

    const store = new VectorStore();
    await load(store, filepath);

    expect(store.length).toBe(1);
    expect(store[0]).toBeInstanceOf(Document);
    expect(store[0].documentId).toBe("x|single");
  });

  test("loads a directory into a store of multiple Documents", async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, "dir-"));
    await writeFixture(path.join(dir, "a.bin"), "doc|a");
    await writeFixture(path.join(dir, "b.bin"), "doc|b");

    const store = new VectorStore();
    await load(store, dir);

    expect(store.length).toBe(2);
    expect(store.map(d => d.documentId).sort()).toEqual(["doc|a", "doc|b"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clear option
// ─────────────────────────────────────────────────────────────────────────────

describe("load — clear option", () => {
  test("clear=true (default) replaces existing contents", async () => {
    const dirA = await fs.mkdtemp(path.join(tmpRoot, "clearA-"));
    const dirB = await fs.mkdtemp(path.join(tmpRoot, "clearB-"));
    await writeFixture(path.join(dirA, "a.bin"), "first|set");
    await writeFixture(path.join(dirB, "b.bin"), "second|set");

    const store = new VectorStore();
    await load(store, dirA);
    expect(store.map(d => d.documentId)).toEqual(["first|set"]);

    // Default clear=true → contents replaced.
    await load(store, dirB);
    expect(store.map(d => d.documentId)).toEqual(["second|set"]);
  });

  test("clear=false appends to existing contents", async () => {
    const dirA = await fs.mkdtemp(path.join(tmpRoot, "appendA-"));
    const dirB = await fs.mkdtemp(path.join(tmpRoot, "appendB-"));
    await writeFixture(path.join(dirA, "a.bin"), "set|a");
    await writeFixture(path.join(dirB, "b.bin"), "set|b");

    const store = new VectorStore();
    await load(store, dirA);
    await load(store, dirB, { clear: false });

    expect(store.length).toBe(2);
    expect(store.map(d => d.documentId).sort()).toEqual(["set|a", "set|b"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Atomicity on failure
// ─────────────────────────────────────────────────────────────────────────────

describe("load — atomicity", () => {
  test("a corrupted .bin file rejects the whole load; store stays as before", async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, "atomic-"));
    await writeFixture(path.join(dir, "good.bin"), "good|doc");
    await fs.writeFile(path.join(dir, "bad.bin"), Buffer.from("not a valid VECT file"));

    const store = new VectorStore();
    // Pre-populate to verify the store isn't touched on failure.
    await writeFixture(path.join(tmpRoot, "prior.bin"), "prior|doc");
    await load(store, path.join(tmpRoot, "prior.bin"));
    expect(store.length).toBe(1);
    expect(store[0].documentId).toBe("prior|doc");

    // Attempt to load the dir with a corrupted file inside.
    await expect(load(store, dir)).rejects.toThrow();

    // Store should still hold its pre-failure contents.
    expect(store.length).toBe(1);
    expect(store[0].documentId).toBe("prior|doc");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Return value
// ─────────────────────────────────────────────────────────────────────────────

describe("load — return value", () => {
  test("returns the same store object it was passed", async () => {
    const filepath = path.join(tmpRoot, "return.bin");
    await writeFixture(filepath, "x");

    const store = new VectorStore();
    const result = await load(store, filepath);
    expect(result).toBe(store);
  });

  test("works with a plain array, not just a VectorStore", async () => {
    const filepath = path.join(tmpRoot, "plain-array.bin");
    await writeFixture(filepath, "x");

    const arr = [];
    await load(arr, filepath);
    expect(arr.length).toBe(1);
    expect(arr[0]).toBeInstanceOf(Document);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export conventions
// ─────────────────────────────────────────────────────────────────────────────

describe("load — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof load).toBe("function");
  });

  test("exposes a self-referential .load property", () => {
    expect(load.load).toBe(load);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(load)).toBe(true);
  });
});
