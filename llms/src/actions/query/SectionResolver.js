"use strict";

const fs = require("fs");
const fsAsync = fs.promises;
const path = require("path");
const deriveDocumentId = require("../../utilities/deriveDocumentId");

/**
 * @file SectionResolver.js
 * @module actions/query/SectionResolver
 * @description Resolves `(documentId, range)` pairs from VectorStore
 * search hits back into the raw markdown text of the corresponding
 * section. The query pipeline calls this between search and prompt
 * serialization: each hit gets its `sectionText` populated before
 * being passed to the LLM serializer.
 *
 * ## Two construction paths
 *
 * Mirrors {@link Document} in `VectorStore/Document/` with a slight
 * variation: both the constructor and the static `create` accept the
 * same polymorphic input.
 *
 *   - **Constructor (`new SectionResolver(input)`):** synchronous I/O.
 *     Best for boot-time setup, tests, and CLI scripts where blocking
 *     the event loop briefly is harmless. Reads files with
 *     `fs.readFileSync` / `fs.readdirSync`.
 *
 *   - **Static `create(input)`:** asynchronous I/O. Best for callers
 *     already in an async context (request handlers at boot, or
 *     batch evaluators). Reads files with `fs.promises.*` and
 *     parallelizes file reads via `Promise.all`.
 *
 * Both paths accept the same input shapes:
 *
 *   - **`Map<documentId, content>`:** pre-built map, no I/O. Used by
 *     tests and by `create` after it has done its own async reads.
 *     **Note:** Map-input resolvers don't carry filesystem paths, so
 *     `getPath(documentId)` returns `null` for entries that came in
 *     this way. Mix Map and path inputs via `add()` and only the
 *     path-input entries will have paths registered.
 *   - **Directory path (string):** recursively walks the directory,
 *     reads every `.md` file, derives a documentId per file. Records
 *     the absolute path alongside the content.
 *   - **File path (string):** reads a single file regardless of
 *     extension (caller has named it explicitly). Builds a one-entry
 *     map and records its absolute path.
 *
 * Behavior — outputs, errors, warnings — is identical across both
 * paths. The only difference is whether the I/O blocks the caller.
 *
 * ## Document IDs and paths
 *
 * IDs come from {@link deriveDocumentId} applied to each file's path,
 * which produces `"theme|stem"` form. The theme prefix is the
 * immediate parent folder; this is the same scheme used everywhere
 * else in the pipeline (search hits, VectorStore documents) so the
 * IDs registered here line up exactly with what `resolve()` is
 * asked to find.
 *
 * Alongside `documentId → content`, the resolver also tracks
 * `documentId → absolutePath` for documents ingested from the
 * filesystem. The {@link SectionResolver#getPath} accessor exposes
 * this mapping for downstream code (e.g. document endpoints that
 * need to read the file from a documentId).
 *
 * Two files that sanitize to the same documentId is a setup bug:
 * the VectorStore can't distinguish them either. Construction
 * throws loudly in that case.
 *
 * ## Range semantics
 *
 * Ranges are half-open `[start, end)` byte offsets into the file's
 * content string — same convention as VectorStore document section
 * ranges. `content.slice(start, end)` produces the section text.
 *
 * Range checks:
 *   - `start < 0`, non-integers, or `end < start` → null + warning
 *   - `end > content.length` → null + warning (range overshoots)
 *
 * Overshoot signals that the source markdown has changed since the
 * VectorStore was built. The resolver returns null and logs; the
 * caller decides policy (skip the hit, surface the issue, crash).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Module helpers — shared between sync and async paths
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the documentId → content and documentId → absolute-path
 * maps from parallel arrays of file paths and their already-read
 * contents.
 *
 * This is the post-read initialization step shared by both
 * construction paths. The sync and async readers (`readPathSync`,
 * `readPathAsync`) are the only diverging code — once a path has
 * been resolved into `{filePaths, contents}` arrays, the rest is
 * the same regardless of I/O style. Centralizing the derivation
 * here means collision detection has exactly one implementation,
 * and the content/path maps stay in lockstep by construction.
 *
 * @param {string[]} filePaths - Absolute paths in deterministic order.
 * @param {string[]} contents  - Parallel array of file contents (same length, same order).
 * @returns {{contentMap: Map<string, string>, pathMap: Map<string, string>}}
 * @throws {Error} On documentId collision — indicates a structurally
 *   ambiguous corpus that the VectorStore can't reliably distinguish.
 */
const buildMapsFromFilePaths = (filePaths, contents) => {
  const contentMap = new Map();
  const pathMap = new Map();
  for (let i = 0; i < filePaths.length; i++) {
    const id = deriveDocumentId(filePaths[i]);
    if (contentMap.has(id)) {
      throw new Error(
        `SectionResolver: documentId "${id}" collision between ` +
        `"${filePaths[i]}" and previously-indexed file. This indicates ` +
        `the corpus has two files that sanitize to the same ID — fix ` +
        `the directory layout or rename one of the files.`
      );
    }
    contentMap.set(id, contents[i]);
    pathMap.set(id, filePaths[i]);
  }
  return { contentMap, pathMap };
};

/**
 * Synchronously walk a directory recursively, collecting `.md`
 * file paths. Uses `fs.readdirSync` with `recursive: true` (Node
 * 18.17+) — the runtime handles the tree walk for us.
 *
 * Symlinks are not followed (Node's recursive option mirrors the
 * old DFS behavior here — `isFile()` returns false for symlinks,
 * so they get filtered out naturally).
 *
 * The `parentPath || path || dir` fallback handles three Node
 * versions: `parentPath` (20.12+), `path` (20.1–20.11, deprecated),
 * and a final fallback to `dir` itself in case neither is set.
 *
 * @param {string} dir - Starting directory.
 * @returns {string[]} Absolute paths of every .md file found.
 */
const walkMarkdownFilesSync = (dir) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (err) {
    throw new Error(`SectionResolver: cannot read directory "${dir}": ${err.message}`);
  }
  return entries
    .filter(e => e.isFile() && e.name.endsWith(".md"))
    .map(e => path.join(e.parentPath || e.path || dir, e.name));
};

/**
 * Async sibling of {@link walkMarkdownFilesSync}. Uses
 * `fs.promises.readdir` with `recursive: true` (Node 20.1+).
 * Behavior is otherwise identical.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
const walkMarkdownFilesAsync = async (dir) => {
  let entries;
  try {
    entries = await fsAsync.readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err) {
    throw new Error(`SectionResolver: cannot read directory "${dir}": ${err.message}`);
  }
  return entries
    .filter(e => e.isFile() && e.name.endsWith(".md"))
    .map(e => path.join(e.parentPath || e.path || dir, e.name));
};

/**
 * Read a path string synchronously, returning the file paths and
 * contents needed by {@link buildMapsFromFilePaths}.
 *
 * Dispatches on whether the input is a directory (recursive walk,
 * `.md` filter) or a single file (just that one file, any extension
 * — the caller named it explicitly, so we honor the request).
 *
 * @param {string} inputPath
 * @returns {{filePaths: string[], contents: string[]}}
 * @throws {Error} If the path doesn't exist, isn't readable, or is
 *   neither a file nor a directory (e.g. a pipe or socket).
 */
const readPathSync = (inputPath) => {
  let stat;
  try {
    stat = fs.statSync(inputPath);
  } catch (err) {
    throw new Error(`SectionResolver: cannot stat "${inputPath}": ${err.message}`);
  }

  if (stat.isDirectory()) {
    const filePaths = walkMarkdownFilesSync(inputPath);
    const contents = filePaths.map(p => fs.readFileSync(p, "utf8"));
    return { filePaths, contents };
  }
  if (stat.isFile()) {
    return {
      filePaths: [inputPath],
      contents:  [fs.readFileSync(inputPath, "utf8")],
    };
  }
  throw new Error(`SectionResolver: "${inputPath}" is neither a file nor a directory`);
};

/**
 * Async sibling of {@link readPathSync}. Uses `fs.promises.*` and
 * parallelizes file reads via `Promise.all`. For large corpora
 * this is meaningfully faster than the sync version because the
 * OS can pipeline disk reads.
 *
 * @param {string} inputPath
 * @returns {Promise<{filePaths: string[], contents: string[]}>}
 */
const readPathAsync = async (inputPath) => {
  let stat;
  try {
    stat = await fsAsync.stat(inputPath);
  } catch (err) {
    throw new Error(`SectionResolver: cannot stat "${inputPath}": ${err.message}`);
  }

  if (stat.isDirectory()) {
    const filePaths = await walkMarkdownFilesAsync(inputPath);
    const contents  = await Promise.all(filePaths.map(p => fsAsync.readFile(p, "utf8")));
    return { filePaths, contents };
  }
  if (stat.isFile()) {
    return {
      filePaths: [inputPath],
      contents:  [await fsAsync.readFile(inputPath, "utf8")],
    };
  }
  throw new Error(`SectionResolver: "${inputPath}" is neither a file nor a directory`);
};

// ─────────────────────────────────────────────────────────────────────────────
// SectionResolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @class SectionResolver
 *
 * In-memory map from documentId to source-file content, plus a
 * sibling map from documentId to absolute filesystem path for
 * entries ingested from the filesystem, plus a range-checking
 * lookup method. The `#map` and `#paths` private fields are the
 * only state; lookups are O(1) map access plus a string slice.
 */
class SectionResolver {
  /** @private The underlying documentId → content map. */
  #map;

  /**
   * @private The sibling documentId → absolutePath map. Populated
   * only for entries ingested via path strings; entries that came
   * in via a raw Map have no path registered.
   */
  #paths;

  /**
   * Construct a SectionResolver synchronously.
   *
   * Accepts:
   *   - `Map<documentId, content>`: stored directly. No I/O. No
   *     paths registered.
   *   - Directory path (string): recursively walks the directory,
   *     reads `.md` files via `fs.readFileSync`, builds both the
   *     content map and the path map.
   *   - File path (string): reads that one file (any extension),
   *     builds a one-entry content map and registers its path.
   *
   * For the path inputs, this performs synchronous disk I/O. Use
   * {@link SectionResolver.create} for the non-blocking equivalent.
   *
   * @param {Map<string, string> | string} input
   * @throws {Error} On invalid input type, missing/unreadable path,
   *   path that's neither file nor directory, or documentId
   *   collision when walking a directory with two files that
   *   sanitize to the same ID.
   */
  constructor(input) {
    if (input instanceof Map) {
      this.#map = input;
      this.#paths = new Map();
      return;
    }
    if (typeof input === "string" && input.length > 0) {
      const { filePaths, contents } = readPathSync(input);
      const { contentMap, pathMap } = buildMapsFromFilePaths(filePaths, contents);
      this.#map = contentMap;
      this.#paths = pathMap;
      return;
    }
    throw new Error(
      "SectionResolver: input must be a Map<documentId, content> or a path string"
    );
  }

  /**
   * Construct a SectionResolver asynchronously.
   *
   * Accepts the same input shapes as the constructor. The path
   * inputs read files via `fs.promises.*` with parallel reads.
   * Map input routes through the constructor's fast path.
   *
   * @async
   * @param {Map<string, string> | string} input
   * @returns {Promise<SectionResolver>}
   * @throws {Error} Same conditions as the constructor.
   *
   * @example
   *   const resolver = await SectionResolver.create("scripts/data");
   *   const text = resolver.resolve(
   *     "biocides_and_chemical_treatment|water_chemistry",
   *     [3331, 3631]
   *   );
   *   const filePath = resolver.getPath(
   *     "biocides_and_chemical_treatment|water_chemistry"
   *   );
   */
  static async create(input) {
    if (input instanceof Map) {
      return new SectionResolver(input);
    }
    if (typeof input === "string" && input.length > 0) {
      const { filePaths, contents } = await readPathAsync(input);
      const { contentMap, pathMap } = buildMapsFromFilePaths(filePaths, contents);
      // Use the Map fast path then patch the #paths field. We can't
      // pass two arguments to the constructor without changing its
      // public surface, so instantiate-then-set keeps the contract.
      const instance = new SectionResolver(contentMap);
      // Direct private-field access via a small bridge: the
      // constructor already initialized #paths to empty, but we
      // want the freshly-built pathMap. Use add-style mutation.
      for (const [id, p] of pathMap) instance._setPath(id, p);
      return instance;
    }
    throw new Error(
      "SectionResolver: input must be a Map<documentId, content> or a path string"
    );
  }

  /**
   * @private
   * Internal helper for `create` to populate the path map after
   * the constructor's Map-input fast path. Not part of the public
   * surface — keeping it as a method (rather than exposing the
   * private field) lets V8 fully optimize private-field access in
   * the hot path while still letting `create` complete the
   * initialization symmetrically.
   *
   * @param {string} documentId
   * @param {string} absolutePath
   */
  _setPath(documentId, absolutePath) {
    this.#paths.set(documentId, absolutePath);
  }

  /**
   * Look up a single section. Returns the raw markdown text, or
   * `null` when the documentId is unknown or the range is invalid
   * or overshoots the content length.
   *
   * All `null` returns log a `console.warn`. The caller decides
   * whether to skip the hit, surface the error, or crash — the
   * resolver itself doesn't decide policy.
   *
   * @param {string} documentId
   * @param {[number, number]} range - Half-open [start, end).
   * @returns {string|null}
   */
  resolve(documentId, range) {
    const content = this.#map.get(documentId);
    if (content === undefined) {
      console.warn(`SectionResolver.resolve: unknown documentId "${documentId}"`);
      return null;
    }

    if (!Array.isArray(range) || range.length !== 2) {
      console.warn(`SectionResolver.resolve: invalid range shape for "${documentId}": ${JSON.stringify(range)}`);
      return null;
    }

    const [start, end] = range;

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      console.warn(`SectionResolver.resolve: invalid range [${start}, ${end}] for "${documentId}"`);
      return null;
    }

    if (end > content.length) {
      console.warn(
        `SectionResolver.resolve: range [${start}, ${end}] overshoots content ` +
        `length ${content.length} for "${documentId}" — source markdown may ` +
        `have changed since the VectorStore was built`
      );
      return null;
    }

    return content.slice(start, end);
  }

  /**
   * Look up the absolute filesystem path for a documentId. Returns
   * `null` when:
   *
   *   - The documentId is unknown to this resolver.
   *   - The documentId is known but was ingested via a raw Map and
   *     therefore has no associated filesystem path.
   *
   * Callers that need to distinguish "unknown documentId" from
   * "known but pathless" can cross-reference with `documentIds`.
   *
   * @param {string} documentId
   * @returns {string|null} Absolute path, or null if absent.
   *
   * @example
   *   const resolver = await SectionResolver.create("data/markdowns");
   *   const p = resolver.getPath("biocides|water_chemistry");
   *   // → "/abs/path/to/data/markdowns/biocides/water_chemistry.md"
   */
  getPath(documentId) {
    return this.#paths.get(documentId) || null;
  }

  /**
   * Ingest one or more new documents into the existing index, in
   * place. Variadic: accepts any combination of strings, Maps, and
   * (possibly nested) arrays thereof. Arguments are flattened via
   * `flat(Infinity)`, so:
   *
   *   await resolver.add("a.md");
   *   await resolver.add("a.md", "b.md");
   *   await resolver.add(["a.md", "b.md"]);
   *   await resolver.add(["dir/", ["c.md", "d.md"]], mapFixture);
   *
   * all work and resolve to the same in-place merge. Maps survive
   * `flat(Infinity)` because they aren't arrays — they pass through
   * untouched.
   *
   * Each argument may be:
   *   - A `Map<documentId, content>`: merged directly. No I/O.
   *     **No paths registered** for these entries.
   *   - A file path (string, any extension): read once. Path
   *     registered alongside the content.
   *   - A directory path (string): recursively walked for `.md`
   *     files. Paths registered for every file found.
   *
   * Collision policy applies across the union of all incoming
   * inputs: if any documentId — whether from the existing index, an
   * earlier argument in this call, or a duplicate within a single
   * directory — appears twice, the call throws and the index is
   * left untouched. All-or-nothing semantics so a partial merge
   * can't leave the resolver in an ambiguous state.
   *
   * @async
   * @param {...(Map<string,string> | string | (Map|string)[])} inputs
   * @returns {Promise<number>} The total number of new documents added.
   *
   * @throws {Error} On invalid input type, missing/unreadable path,
   *   path that's neither file nor directory, or documentId
   *   collision (with existing entries, with another argument, or
   *   within a single argument's contents).
   *
   * @example <caption>Single file</caption>
   *   await resolver.add("data/markdowns/biocides/new-doc.md");
   *
   * @example <caption>Mixed inputs in one call</caption>
   *   await resolver.add(
   *     "data/markdowns/incoming/",
   *     ["data/markdowns/biocides/a.md", "data/markdowns/biocides/b.md"],
   *     prebuiltMap,
   *   );
   */
  async add(...inputs) {
    inputs = inputs.flat(Infinity);
    if (inputs.length === 0) return 0;

    // Read in parallel. Maps pass through untouched (no I/O); path
    // strings get fully read. allSettled so one bad path doesn't
    // abort the rest — but we won't COMMIT anything if any failed,
    // since the index has all-or-nothing semantics.
    //
    // Each settled value is `{contentMap, pathMap}`: pathMap is
    // empty for Map inputs, populated for path-string inputs.
    const settled = await Promise.allSettled(inputs.map(async (input) => {
      if (input instanceof Map) {
        return { contentMap: input, pathMap: new Map() };
      }
      if (typeof input === "string" && input.length > 0) {
        const { filePaths, contents } = await readPathAsync(input);
        return buildMapsFromFilePaths(filePaths, contents);
      }
      throw new Error(
        "SectionResolver.add: each input must be a Map<documentId, content> or a path string"
      );
    }));

    // If any read failed, surface them all together. Index is
    // untouched.
    const readErrors = settled
      .map((r, i) => r.status === "rejected"
        ? new Error(`SectionResolver.add: input ${i} failed: ${r.reason.message}`)
        : null)
      .filter(Boolean);

    if (readErrors.length > 0) {
      throw new AggregateError(readErrors, `SectionResolver.add: ${readErrors.length}/${inputs.length} inputs failed to read`);
    }

    // Stage everything into one content map + one path map. Detect
    // collisions both within the incoming set and against the
    // existing index BEFORE mutating. This is the "all-or-nothing"
    // guarantee — a partial index would be ambiguous.
    const mergedContent = new Map();
    const mergedPaths = new Map();
    for (const { contentMap, pathMap } of settled.map(r => r.value)) {
      for (const [documentId, content] of contentMap) {
        if (mergedContent.has(documentId)) {
          throw new Error(
            `SectionResolver.add: documentId collision within this call — "${documentId}" appears in multiple inputs`
          );
        }
        mergedContent.set(documentId, content);
      }
      for (const [documentId, p] of pathMap) {
        // Path map collisions follow the same documentId — already
        // guarded by the content-map check above, but keep the
        // map symmetric.
        mergedPaths.set(documentId, p);
      }
    }

    const existingCollisions = [];
    for (const documentId of mergedContent.keys()) {
      if (this.#map.has(documentId)) existingCollisions.push(documentId);
    }
    if (existingCollisions.length > 0) {
      throw new Error(
        `SectionResolver.add: documentId collision with existing index — already indexed: ${existingCollisions.join(", ")}`
      );
    }

    // Safe to merge.
    for (const [documentId, content] of mergedContent) {
      this.#map.set(documentId, content);
    }
    for (const [documentId, p] of mergedPaths) {
      this.#paths.set(documentId, p);
    }
    return mergedContent.size;
  }

  /**
   * Remove one or more documents from the index by documentId, in
   * place. Variadic — same shape as {@link SectionResolver#add}:
   *
   *   resolver.remove("theme|stem");
   *   resolver.remove("theme|a", "theme|b");
   *   resolver.remove(["theme|a", "theme|b"]);
   *   resolver.remove([["theme|a"], ["theme|b", "theme|c"]]);
   *
   * Unknown documentIds are warned about but do NOT throw — matches
   * Unix `rm` semantics. The return value tells the caller how many
   * entries were actually removed.
   *
   * Synchronous — pure in-memory map mutation, no I/O.
   *
   * @param {...(string|string[])} documentIds
   * @returns {number} Count of entries actually removed.
   *
   * @example
   *   const removed = resolver.remove("biocides|old_doc");
   *   // → 1 if it was present, 0 if not
   */
  remove(...documentIds) {
    documentIds = documentIds.flat(Infinity);
    if (documentIds.length === 0) return 0;
 
    // Validate first so a bad arg doesn't half-remove.
    for (const id of documentIds) {
      if (typeof id !== "string" || id.length === 0) {
        throw new Error(`SectionResolver.remove: each documentId must be a non-empty string, got ${typeof id}`);
      }
    }
 
    // Map the input to correct documentIds, if needed.
    let removed = 0, j = 0;
    const unknown = new Set;
    for (let i = 0, l = documentIds.length, originalInput, documentId; i !==l; ++i) {
      try {
        documentId = deriveDocumentId(originalInput = documentIds[i]);
        documentIds[j++] = [documentId, originalInput];
      } catch {
        unknown.add(originalInput);
      }
    }
    documentIds.length = j;


    (new Map(documentIds)).forEach((originalInput, documentId) => (
        this.#map.has(documentId) && (
        this.#map.delete(documentId),
        this.#paths.delete(documentId),  // safe to call even if entry never had a path
        ++removed
      ) || unknown.add(originalInput)
    ));
 
    // Warn once per distinct missing id.
    unknown.forEach(id => console.warn(`SectionResolver.remove: document "${id}" not in index`));
 
    return removed;
  }

  /**
   * List every documentId in the index. Useful for smoke tests
   * verifying corpus alignment with the VectorStore.
   *
   * @returns {string[]}
   */
  get documentIds() {
    return Array.from(this.#map.keys());
  }

  /**
   * Number of documents in the index.
   *
   * @returns {number}
   */
  get size() {
    return this.#map.size;
  }
}

/**
 * @ignore
 * Frozen self-referential export following project conventions.
 */
module.exports = Object.freeze(Object.defineProperty(SectionResolver, "SectionResolver", {
  value: SectionResolver,
}));