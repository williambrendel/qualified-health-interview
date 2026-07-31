/**
 * @file embedQuery.test.js
 * @brief Unit tests for the embedQuery wrapper.
 *
 * Verifies:
 *   - The BGE query instruction prefix is applied exactly once
 *   - Idempotent: any number of leading prefix copies collapse to one
 *   - Leading/trailing whitespace is trimmed (internal whitespace preserved)
 *   - The default prefix can be overridden per-call
 *   - The vectorize return value is forwarded unchanged
 *   - The module export honors the project's frozen self-referential convention
 */

// Mock vectorize before requiring the module under test. The path here must
// match what embedQuery.js resolves to — adjust if your project layout differs.
jest.mock("../../src/xenova/vectorize", () => jest.fn());

const vectorize = require("../../src/xenova/vectorize");
const embedQuery = require("../../src/xenova/embedQuery");

const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

beforeEach(() => {
  vectorize.mockReset();
  // Default mock: return a deterministic dummy embedding so callers can
  // chain off the return value when they need to assert on it.
  vectorize.mockResolvedValue(new Float32Array(384).fill(0.5));
});

describe("embedQuery — prefix application", () => {
  test("prepends the default BGE prefix to the query", async () => {
    await embedQuery("bugs keep coming back");
    expect(vectorize).toHaveBeenCalledTimes(1);
    expect(vectorize).toHaveBeenCalledWith(QUERY_PREFIX + "bugs keep coming back");
  });

  test("prepends the prefix to an empty query", async () => {
    await embedQuery("");
    expect(vectorize).toHaveBeenCalledWith(QUERY_PREFIX);
  });

  test("trims leading and trailing whitespace from the query", async () => {
    // The new embedQuery trims surrounding whitespace before applying the
    // prefix. This keeps the body flush against the prefix's trailing
    // space, and matches the behavior needed for clean idempotency
    // (otherwise " PREFIX foo" and "PREFIX foo" would prefix differently).
    await embedQuery("  green slime  ");
    expect(vectorize).toHaveBeenCalledWith(QUERY_PREFIX + "green slime");
  });

  test("preserves embedded newlines and tabs (internal whitespace untouched)", async () => {
    const q = "line one\nline two\tindented";
    await embedQuery(q);
    expect(vectorize).toHaveBeenCalledWith(QUERY_PREFIX + q);
  });

  test("preserves unicode characters", async () => {
    const q = "ångström — résumé 日本語";
    await embedQuery(q);
    expect(vectorize).toHaveBeenCalledWith(QUERY_PREFIX + q);
  });
});

describe("embedQuery — prefix idempotency", () => {
  test("does not double-prefix when the query already starts with the prefix", async () => {
    // The function is idempotent. A pre-prefixed input is stripped and
    // re-prefixed exactly once.
    const q = QUERY_PREFIX + "already prefixed";
    await embedQuery(q);
    expect(vectorize).toHaveBeenCalledWith(QUERY_PREFIX + "already prefixed");
  });

  test("collapses two leading prefix copies to one", async () => {
    const q = QUERY_PREFIX + QUERY_PREFIX + "twice prefixed";
    await embedQuery(q);
    expect(vectorize).toHaveBeenCalledWith(QUERY_PREFIX + "twice prefixed");
  });

  test("collapses three+ leading prefix copies to one", async () => {
    const q = QUERY_PREFIX + QUERY_PREFIX + QUERY_PREFIX + "deeply prefixed";
    await embedQuery(q);
    expect(vectorize).toHaveBeenCalledWith(QUERY_PREFIX + "deeply prefixed");
  });

  test("idempotency only strips leading runs, not embedded matches", async () => {
    // A prefix-substring appearing INSIDE the query body is content, not
    // a prefix. Only leading runs at the start are collapsed.
    const q = `${QUERY_PREFIX}why does ${QUERY_PREFIX}appear in this text`;
    await embedQuery(q);
    expect(vectorize).toHaveBeenCalledWith(
      QUERY_PREFIX + `why does ${QUERY_PREFIX}appear in this text`
    );
  });
});

describe("embedQuery — prefix override", () => {
  test("uses a custom prefix when provided", async () => {
    const e5Prefix = "query: ";
    await embedQuery("ATP high residual normal", e5Prefix);
    expect(vectorize).toHaveBeenCalledWith(e5Prefix + "ATP high residual normal");
  });

  test("accepts an empty-string prefix (encoder with no instruction)", async () => {
    await embedQuery("no prefix needed", "");
    expect(vectorize).toHaveBeenCalledWith("no prefix needed");
  });

  test("does not mutate the default prefix when an override is used", async () => {
    await embedQuery("first", "OTHER: ");
    await embedQuery("second");
    expect(vectorize).toHaveBeenNthCalledWith(1, "OTHER: first");
    expect(vectorize).toHaveBeenNthCalledWith(2, QUERY_PREFIX + "second");
  });

  test("idempotency works with a custom prefix", async () => {
    const e5Prefix = "query: ";
    const q = e5Prefix + e5Prefix + "doubled custom";
    await embedQuery(q, e5Prefix);
    expect(vectorize).toHaveBeenCalledWith(e5Prefix + "doubled custom");
  });
});

describe("embedQuery — return value forwarding", () => {
  test("returns the vectorize promise unchanged", async () => {
    const expected = new Float32Array([1, 2, 3, 4]);
    vectorize.mockResolvedValueOnce(expected);
    const result = await embedQuery("anything");
    expect(result).toBe(expected);
  });

  test("propagates rejections from vectorize", async () => {
    const err = new Error("encoder failed");
    vectorize.mockRejectedValueOnce(err);
    await expect(embedQuery("anything")).rejects.toBe(err);
  });
});

describe("embedQuery — module export conventions", () => {
  test("the export is the function itself", () => {
    expect(typeof embedQuery).toBe("function");
  });

  test("exposes the QUERY_PREFIX constant as a static property", () => {
    expect(embedQuery.QUERY_PREFIX).toBe(QUERY_PREFIX);
  });

  test("exposes a self-referential .embedQuery property", () => {
    expect(embedQuery.embedQuery).toBe(embedQuery);
  });

  test("the exported function is frozen", () => {
    expect(Object.isFrozen(embedQuery)).toBe(true);
  });

  test("cannot add new properties to the export", () => {
    // In strict mode this would throw; in sloppy mode the assignment is
    // silently dropped. Either way, the property must not appear.
    try { embedQuery.somethingNew = 1; } catch (_) { /* strict mode */ }
    expect(embedQuery.somethingNew).toBeUndefined();
  });
});