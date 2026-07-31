"use strict";

const fs   = require("fs");
const path = require("path");

/**
 * @file resolveBinPaths.js
 * @module VectorStore/resolveBinPaths
 * @description Synchronous filesystem walker that resolves a path (file or
 * directory) into the list of `.bin` files it covers.
 */

/**
 * Walk `dirPath` synchronously, returning every `.bin` file under it
 * recursively. Module-private — see {@link resolveBinPaths} for the public
 * entry point.
 *
 * Sync I/O is acceptable here because this runs once at endpoint init or
 * hot reload: short blocking on inode reads beats threading async I/O
 * through what is otherwise a one-shot operation.
 */
const walkBinFiles = dirPath => {
  const out = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (let i = 0, l = entries.length; i !== l; ++i) {
    const entry = entries[i];
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkBinFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".bin")) {
      out.push(full);
    }
  }
  return out;
};

/**
 * Resolve an input path into the list of `.bin` files it covers.
 *
 * Accepts either a single `.bin` file or a directory (walked recursively).
 * Anything else throws.
 *
 * @function resolveBinPaths
 * @param {string} inputPath
 * @returns {string[]}
 *
 * @throws {Error} If `inputPath` is neither a directory nor a `.bin` file.
 */
const resolveBinPaths = inputPath => {
  const stat = fs.statSync(inputPath);
  if (stat.isDirectory()) return walkBinFiles(inputPath);
  if (stat.isFile() && inputPath.endsWith(".bin")) return [inputPath];
  throw new Error(`resolveBinPaths: path is neither a directory nor a .bin file: ${inputPath}`);
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(resolveBinPaths, "resolveBinPaths", {
  value: resolveBinPaths,
}));
