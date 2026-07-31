"use strict";

/**
 * @file resolveBinPaths.test.js
 * @brief Tests for the synchronous .bin path resolver.
 *
 * Covers single-file dispatch, recursive directory walk, .bin extension
 * filtering, hidden / non-bin file rejection, and the error path for
 * inputs that are neither files nor directories.
 */

const fs   = require("fs").promises;
const path = require("path");
const os   = require("os");

const resolveBinPaths = require("../../src/VectorStore/resolveBinPaths");

let tmpRoot;
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-bin-test-"));
});
afterAll(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

const touch = async (filepath) => {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(filepath, "");
};

// ─────────────────────────────────────────────────────────────────────────────
// Single-file input
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveBinPaths — single file input", () => {
  test("returns [filepath] for a .bin file", async () => {
    const filepath = path.join(tmpRoot, "single.bin");
    await touch(filepath);
    expect(resolveBinPaths(filepath)).toEqual([filepath]);
  });

  test("throws for a non-.bin file", async () => {
    const filepath = path.join(tmpRoot, "wrong-ext.txt");
    await touch(filepath);
    expect(() => resolveBinPaths(filepath)).toThrow(/neither a directory nor a \.bin file/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Directory input
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveBinPaths — directory input", () => {
  test("returns all .bin files in a flat directory", async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, "flat-"));
    await touch(path.join(dir, "a.bin"));
    await touch(path.join(dir, "b.bin"));
    await touch(path.join(dir, "c.bin"));

    const result = resolveBinPaths(dir).sort();
    expect(result).toEqual([
      path.join(dir, "a.bin"),
      path.join(dir, "b.bin"),
      path.join(dir, "c.bin"),
    ]);
  });

  test("walks subdirectories recursively", async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, "nested-"));
    await touch(path.join(dir, "top.bin"));
    await touch(path.join(dir, "biology", "cells.bin"));
    await touch(path.join(dir, "biology", "subatomic", "quarks.bin"));

    const result = resolveBinPaths(dir).sort();
    expect(result).toEqual([
      path.join(dir, "biology", "cells.bin"),
      path.join(dir, "biology", "subatomic", "quarks.bin"),
      path.join(dir, "top.bin"),
    ]);
  });

  test("filters out non-.bin files in the same directory", async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, "mixed-"));
    await touch(path.join(dir, "keep.bin"));
    await touch(path.join(dir, "drop.txt"));
    await touch(path.join(dir, "drop.json"));
    await touch(path.join(dir, "drop"));  // no extension

    const result = resolveBinPaths(dir);
    expect(result).toEqual([path.join(dir, "keep.bin")]);
  });

  test("returns empty array for a directory with no .bin files", async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, "empty-"));
    await touch(path.join(dir, "readme.md"));

    expect(resolveBinPaths(dir)).toEqual([]);
  });

  test("returns empty array for an empty directory", async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, "truly-empty-"));
    expect(resolveBinPaths(dir)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error paths
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveBinPaths — error paths", () => {
  test("throws when the path does not exist", () => {
    expect(() => resolveBinPaths(path.join(tmpRoot, "does-not-exist"))).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export conventions
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveBinPaths — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof resolveBinPaths).toBe("function");
  });

  test("exposes a self-referential .resolveBinPaths property", () => {
    expect(resolveBinPaths.resolveBinPaths).toBe(resolveBinPaths);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(resolveBinPaths)).toBe(true);
  });
});
