"use strict";

const Document        = require("./Document");
const resolveBinPaths = require("./resolveBinPaths");

/**
 * @file load.js
 * @module VectorStore/load
 * @description Standalone implementation of {@link VectorStore#load}.
 *
 * Reads `.bin` files from a path (file or directory, walked recursively),
 * parses each into a {@link Document}, and pushes the documents into the
 * store. Atomic — if any file fails to parse, the store is left in its
 * prior state.
 */

/**
 * Load `.bin` files from `inputPath` into `store`.
 *
 * @async
 * @function load
 * @param {Array}   store - Mutated. Typically a `VectorStore` (which
 *   extends Array), but any array works.
 * @param {string}  inputPath
 * @param {object}  [options]
 * @param {boolean} [options.clear=true] - When true (default), empties the
 *   store before loading. When false, appends to existing contents.
 * @returns {Promise<Array>} `store` for chaining.
 */
const load = async (store, inputPath, { clear = true } = {}) => {
  const paths = resolveBinPaths(inputPath);

  // Read and parse all files in parallel via Document.create's filepath
  // branch. Promise.all rejects on the first failure, leaving the store
  // untouched.
  const docs = await Promise.all(paths.map(Document.create));

  if (clear) store.length = 0;
  for (let i = 0, l = docs.length; i !== l; ++i) store.push(docs[i]);

  return store;
};

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(load, "load", {
  value: load,
}));