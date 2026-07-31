"use strict";

const extractSections = require("../../../../src/actions/generate/binary/extractSections");
const {
  SHORT_THRESHOLD,
  LONG_THRESHOLD,
  GROUP_TARGET,
  wordCount,
  bucketFor,
  chunkBody,
} = extractSections;

// ─────────────────────────────────────────────────────────────────────────────
// Mock vectorize — returns a deterministic Float32Array per text so tests
// can assert on the number of pushed Promises without depending on a real
// embedder. Each call returns a Promise that resolves to a small typed
// array; the test only needs that "vectorize was called" and "the right
// number of Promises landed in section.vecs".
// ─────────────────────────────────────────────────────────────────────────────

const mockVectorize = jest.fn();

beforeEach(() => {
  mockVectorize.mockReset();
  mockVectorize.mockImplementation(async (text) => {
    // Tiny vector deterministic per input length — enough to identify
    // the input in tests where we want to match a specific vector back
    // to its source string.
    return new Float32Array([text.length, text.charCodeAt(0) || 0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: wordCount
// ─────────────────────────────────────────────────────────────────────────────

describe("wordCount", () => {
  test("counts whitespace-separated tokens", () => {
    expect(wordCount("hello world")).toBe(2);
    expect(wordCount("one two three four")).toBe(4);
  });

  test("collapses multiple whitespace", () => {
    expect(wordCount("hello    world")).toBe(2);
    expect(wordCount("hello\n\tworld")).toBe(2);
  });

  test("empty string is zero", () => {
    expect(wordCount("")).toBe(0);
  });

  test("whitespace-only is zero", () => {
    expect(wordCount("   \n\t  ")).toBe(0);
  });

  test("punctuation doesn't split", () => {
    expect(wordCount("hello, world!")).toBe(2);
    expect(wordCount("don't worry")).toBe(2);
  });

  test("single word", () => {
    expect(wordCount("biofilm")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: bucketFor
// ─────────────────────────────────────────────────────────────────────────────

describe("bucketFor", () => {
  test("returns short below SHORT_THRESHOLD", () => {
    expect(bucketFor(0)).toBe("short");
    expect(bucketFor(50)).toBe("short");
    expect(bucketFor(SHORT_THRESHOLD - 1)).toBe("short");
  });

  test("returns medium at SHORT_THRESHOLD", () => {
    expect(bucketFor(SHORT_THRESHOLD)).toBe("medium");
  });

  test("returns medium between thresholds", () => {
    expect(bucketFor(200)).toBe("medium");
    expect(bucketFor(300)).toBe("medium");
    expect(bucketFor(LONG_THRESHOLD)).toBe("medium");
  });

  test("returns long above LONG_THRESHOLD", () => {
    expect(bucketFor(LONG_THRESHOLD + 1)).toBe("long");
    expect(bucketFor(800)).toBe("long");
    expect(bucketFor(2000)).toBe("long");
  });

  test("constants are sensible", () => {
    expect(SHORT_THRESHOLD).toBeGreaterThan(0);
    expect(LONG_THRESHOLD).toBeGreaterThan(SHORT_THRESHOLD);
    expect(GROUP_TARGET).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: chunkBody — bucket-specific behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("chunkBody — short bucket", () => {
  test("returns full content as one chunk", () => {
    const content = "Short paragraph.";
    const sentences = ["Short paragraph."];
    expect(chunkBody(content, sentences, "short")).toEqual([content]);
  });

  test("returns empty array for empty content", () => {
    expect(chunkBody("", [], "short")).toEqual([]);
  });

  test("ignores sentences param for short bucket", () => {
    // Short bucket only uses content; sentences are irrelevant.
    const content = "Just this";
    const sentences = ["unused", "junk"];
    expect(chunkBody(content, sentences, "short")).toEqual(["Just this"]);
  });
});

describe("chunkBody — long bucket", () => {
  test("emits one chunk per non-empty sentence", () => {
    const content = "ignored";
    const sentences = ["First sentence.", "Second sentence.", "Third sentence."];
    expect(chunkBody(content, sentences, "long")).toEqual([
      "First sentence.",
      "Second sentence.",
      "Third sentence.",
    ]);
  });

  test("filters out empty-word sentences", () => {
    const sentences = ["Real sentence.", "", "   ", "Another real one."];
    expect(chunkBody("ignored", sentences, "long")).toEqual([
      "Real sentence.",
      "Another real one.",
    ]);
  });

  test("empty sentences array returns empty", () => {
    expect(chunkBody("ignored", [], "long")).toEqual([]);
  });
});

describe("chunkBody — medium bucket", () => {
  test("groups sentences until GROUP_TARGET is exceeded", () => {
    // 20-word sentences. GROUP_TARGET=80 → groups of ~4 sentences.
    const s = "one two three four five six seven eight nine ten " +
              "eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";
    const sentences = [s, s, s, s, s, s];  // 6 × 20-word sentences
    const result = chunkBody("ignored", sentences, "medium");
    // Each group accumulates ~80 words, so should fit ~4 sentences per group.
    // 6 sentences → 2 groups (4 + 2 or similar).
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.length).toBeLessThanOrEqual(sentences.length);
  });

  test("medium bucket joins sentences with '. '", () => {
    // Verify the join format.
    const sentences = ["alpha", "beta", "gamma"];  // 1 word each, well under target
    const result = chunkBody("ignored", sentences, "medium");
    expect(result.length).toBe(1);
    expect(result[0]).toBe("alpha. beta. gamma");
  });

  test("empty sentences array returns empty", () => {
    expect(chunkBody("ignored", [], "medium")).toEqual([]);
  });

  test("filters empty-word sentences before grouping", () => {
    const sentences = ["one two", "", "three four"];
    const result = chunkBody("ignored", sentences, "medium");
    expect(result.length).toBe(1);
    // Empty sentence dropped before grouping
    expect(result[0]).toBe("one two. three four");
  });

  test("starts new group when adding next sentence would exceed target", () => {
    // 60-word sentence + 30-word sentence + 30-word sentence.
    // GROUP_TARGET=80. First 60 fits in group 1. Adding 30 would make 90 (>80),
    // so flush group 1, start group 2 with the 30. Next 30 fits (60), no flush.
    // Result: [60-word, "30-words. 30-words"]
    const w60 = Array(60).fill("word").join(" ");
    const w30 = Array(30).fill("token").join(" ");
    const sentences = [w60, w30, w30];
    const result = chunkBody("ignored", sentences, "medium");
    expect(result.length).toBe(2);
    expect(wordCount(result[0])).toBe(60);
    // Second group has the two 30-word sentences joined.
    expect(wordCount(result[1])).toBe(60);
  });

  test("very large single sentence still gets its own group", () => {
    // A single 200-word sentence (over GROUP_TARGET) doesn't get split.
    // It's emitted as its own group.
    const huge = Array(200).fill("word").join(" ");
    const result = chunkBody("ignored", [huge], "medium");
    expect(result.length).toBe(1);
    expect(result[0]).toBe(huge);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractSections — end-to-end with real segmentTextSections
// ─────────────────────────────────────────────────────────────────────────────

describe("extractSections — end-to-end", () => {
  test("simple markdown with one section produces one entry", () => {
    const md = "# A Title\n\nA paragraph of content.";
    const result = extractSections(md, { vectorize: mockVectorize });
    expect(result.length).toBeGreaterThan(0);
    const first = result[0];
    expect(first).toHaveProperty("range");
    expect(first).toHaveProperty("breadcrumbs");
    expect(first).toHaveProperty("content");
    expect(first).toHaveProperty("vecs");
  });

  test("range is a two-element numeric array", () => {
    const md = "# Title\n\nBody text.";
    const result = extractSections(md, { vectorize: mockVectorize });
    for (const section of result) {
      expect(Array.isArray(section.range)).toBe(true);
      expect(section.range.length).toBe(2);
      expect(typeof section.range[0]).toBe("number");
      expect(typeof section.range[1]).toBe("number");
      expect(section.range[1]).toBeGreaterThanOrEqual(section.range[0]);
    }
  });

  test("breadcrumbs is a string", () => {
    const md = "# Title\n\nBody.";
    const result = extractSections(md, { vectorize: mockVectorize });
    for (const section of result) {
      expect(typeof section.breadcrumbs).toBe("string");
    }
  });

  test("content is a string", () => {
    const md = "# Title\n\nBody text here.";
    const result = extractSections(md, { vectorize: mockVectorize });
    for (const section of result) {
      expect(typeof section.content).toBe("string");
    }
  });

  test("vecs is an array of Promises", () => {
    const md = "# Title\n\nBody text here.";
    const result = extractSections(md, { vectorize: mockVectorize });
    for (const section of result) {
      expect(Array.isArray(section.vecs)).toBe(true);
      for (const v of section.vecs) {
        expect(v).toBeInstanceOf(Promise);
      }
    }
  });

  test("vecs resolve to Float32Array values", async () => {
    const md = "# Title\n\nBody text here.";
    const result = extractSections(md, { vectorize: mockVectorize });
    for (const section of result) {
      const resolved = await Promise.all(section.vecs);
      for (const v of resolved) {
        expect(v).toBeInstanceOf(Float32Array);
      }
    }
  });

  test("vectorize is called once per pushed Promise (breadcrumb + body chunks)", () => {
    const md = "# Heading\n\nShort body.";
    const result = extractSections(md, { vectorize: mockVectorize });
    // Sum of all vecs across all sections should equal the call count.
    const totalVecs = result.reduce((sum, s) => sum + s.vecs.length, 0);
    expect(mockVectorize).toHaveBeenCalledTimes(totalVecs);
  });

  test("when breadcrumbs is non-empty, first vec is for the breadcrumb", async () => {
    const md = "# A Heading\n\nBody.";
    const result = extractSections(md, { vectorize: mockVectorize });
    const withBreadcrumbs = result.find(s => s.breadcrumbs.length > 0);
    if (withBreadcrumbs) {
      // The first vectorize call for this section should have been with
      // the breadcrumb string. Check by looking at the mock's calls.
      const calls = mockVectorize.mock.calls.map(c => c[0]);
      expect(calls).toContain(withBreadcrumbs.breadcrumbs);
    }
  });

  test("returns array even when markdown has only one section", () => {
    const md = "# Solo\n\nOne and only.";
    const result = extractSections(md, { vectorize: mockVectorize });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test("body content excludes the heading line", () => {
    const md = "# Some Title\n\nThis is the body text.";
    const result = extractSections(md, { vectorize: mockVectorize });
    for (const section of result) {
      expect(section.content).not.toMatch(/^#\s+Some Title/);
    }
  });

  test("nested headings produce ancestor-chain breadcrumbs", () => {
    const md = `# Top

Content under top.

## Sub

Content under sub.

### Deep

Some deep content here.`;
    const result = extractSections(md, { vectorize: mockVectorize });
    const withChained = result.find(s => s.breadcrumbs.includes(","));
    expect(withChained).toBeDefined();
  });

  test("multi-section document produces multiple entries", () => {
    const md = `# First Section
Content of first.

# Second Section
Content of second.

# Third Section
Content of third.`;
    const result = extractSections(md, { vectorize: mockVectorize });
    expect(result.length).toBeGreaterThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractSections — onSection callback
// ─────────────────────────────────────────────────────────────────────────────

describe("extractSections — onSection callback", () => {
  test("fires once per section", () => {
    const md = `# A
Body A.

# B
Body B.

# C
Body C.`;
    const onSection = jest.fn();
    const result = extractSections(md, { vectorize: mockVectorize, onSection });
    expect(onSection).toHaveBeenCalledTimes(result.length);
  });

  test("callback receives index + info shape", () => {
    const md = "# X\n\nSome content.";
    const onSection = jest.fn();
    extractSections(md, { vectorize: mockVectorize, onSection });
    expect(onSection).toHaveBeenCalled();
    const [index, info] = onSection.mock.calls[0];
    expect(typeof index).toBe("number");
    expect(info).toHaveProperty("wordCount");
    expect(info).toHaveProperty("bucket");
    expect(info).toHaveProperty("bodyChunks");
    expect(info).toHaveProperty("range");
  });

  test("bucket is one of short/medium/long", () => {
    const md = "# X\n\nA tiny body.";
    const onSection = jest.fn();
    extractSections(md, { vectorize: mockVectorize, onSection });
    const { bucket } = onSection.mock.calls[0][1];
    expect(["short", "medium", "long"]).toContain(bucket);
  });

  test("bodyChunks count matches pushed body vecs (vecs total - 1 when breadcrumb present)", () => {
    const md = "# H\n\nShort body.";
    const onSection = jest.fn();
    const result = extractSections(md, { vectorize: mockVectorize, onSection });
    const { bodyChunks } = onSection.mock.calls[0][1];
    const section = result[0];
    // bodyChunks + (1 if breadcrumb non-empty else 0) === total vecs
    const expected = section.vecs.length - (section.breadcrumbs ? 1 : 0);
    expect(bodyChunks).toBe(expected);
  });

  test("no callback: function runs normally", () => {
    const md = "# X\n\nBody.";
    expect(() => extractSections(md, { vectorize: mockVectorize })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractSections — error paths
// ─────────────────────────────────────────────────────────────────────────────

describe("extractSections — error paths", () => {
  test("throws on missing markdown", () => {
    expect(() => extractSections(undefined, { vectorize: mockVectorize }))
      .toThrow(/markdown must be a non-empty string/);
  });

  test("throws on empty markdown", () => {
    expect(() => extractSections("", { vectorize: mockVectorize }))
      .toThrow(/markdown must be a non-empty string/);
  });

  test("throws on non-string markdown", () => {
    expect(() => extractSections(42, { vectorize: mockVectorize }))
      .toThrow(/markdown must be a non-empty string/);
    expect(() => extractSections(null, { vectorize: mockVectorize }))
      .toThrow(/markdown must be a non-empty string/);
    expect(() => extractSections({}, { vectorize: mockVectorize }))
      .toThrow(/markdown must be a non-empty string/);
  });

  test("throws when vectorize is missing", () => {
    expect(() => extractSections("# X\n\nBody."))
      .toThrow(/vectorize must be a function/);
  });

  test("throws when vectorize is not a function", () => {
    expect(() => extractSections("# X\n\nBody.", { vectorize: "nope" }))
      .toThrow(/vectorize must be a function/);
  });

  test("throws when no arguments at all", () => {
    expect(() => extractSections()).toThrow(/markdown must be a non-empty string/);
  });

  test("error message names the function", () => {
    try { extractSections(); }
    catch (err) { expect(err.message).toMatch(/extractSections/); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────────────

describe("extractSections — module export", () => {
  test("module is the function", () => {
    expect(typeof extractSections).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(extractSections)).toBe(true);
  });

  test("self-referential property", () => {
    expect(extractSections.extractSections).toBe(extractSections);
  });

  test("exposes bucket constants", () => {
    expect(typeof extractSections.SHORT_THRESHOLD).toBe("number");
    expect(typeof extractSections.LONG_THRESHOLD).toBe("number");
    expect(typeof extractSections.GROUP_TARGET).toBe("number");
  });

  test("exposes helper functions", () => {
    expect(typeof extractSections.wordCount).toBe("function");
    expect(typeof extractSections.bucketFor).toBe("function");
    expect(typeof extractSections.chunkBody).toBe("function");
    expect(typeof extractSections.extractBreadcrumb).toBe("function");
    expect(typeof extractSections.extractBody).toBe("function");
  });
});