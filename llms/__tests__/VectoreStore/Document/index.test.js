"use strict";

/**
 * @file index.test.js
 * @brief Tests for the Document class.
 *
 * Covers the public API:
 *   - Constructor + field defaults (vecOffsets lazy compute).
 *   - getSection — view shape and contents.
 *   - score / Document.score — per-section max, floor cut, bestVec view,
 *     dim mismatch, type check.
 *   - search delegation.
 *   - toBuffer / fromBuffer round-trip.
 *   - write — disk I/O and chaining.
 *   - create — input-type dispatch.
 *
 * Golden vectors used for score tests are orthogonal basis vectors so
 * cosine values are exact (Float32 represents 0 and 1 without rounding).
 */

const fs   = require("fs").promises;
const path = require("path");
const os   = require("os");

const Document = require("../../../src/VectorStore/Document");
const {
  VECT_VERSION,
  HEADER_BYTES,
} = require("../../../src/VectorStore/Document/constants");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const v = (...components) => new Float32Array(components);

/**
 * Compare two Float32Array contents for exact equality.
 */
const expectVecEqual = (actual, expected) => {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBe(expected[i]);
  }
};

let tmpRoot;
beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "document-test-"));
});
afterAll(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constructor
// ─────────────────────────────────────────────────────────────────────────────

describe("Document — constructor", () => {
  test("assigns every public field from the fields object", () => {
    const indexBuffer = new Uint32Array([0, 10, 1]);
    const vecBuffer   = new Float32Array([1, 0, 0, 0]);
    const vecOffsets  = new Uint32Array([0, 1]);

    const doc = new Document({
      documentId:  "test|doc",
      version:     VECT_VERSION,
      indexDim:    3,
      vecDim:      4,
      numSections: 1,
      totalVecs:   1,
      indexBuffer,
      vecBuffer,
      vecOffsets,
    });

    expect(doc.documentId).toBe("test|doc");
    expect(doc.version).toBe(VECT_VERSION);
    expect(doc.indexDim).toBe(3);
    expect(doc.vecDim).toBe(4);
    expect(doc.numSections).toBe(1);
    expect(doc.totalVecs).toBe(1);
    expect(doc.indexBuffer).toBe(indexBuffer);
    expect(doc.vecBuffer).toBe(vecBuffer);
    expect(doc.vecOffsets).toBe(vecOffsets);
  });

  test("computes vecOffsets when not provided", () => {
    const indexBuffer = new Uint32Array([
      0,  10, 2,
      10, 20, 0,
      20, 30, 3,
    ]);

    const doc = new Document({
      documentId:  "x",
      version:     VECT_VERSION,
      indexDim:    3,
      vecDim:      4,
      numSections: 3,
      totalVecs:   5,
      indexBuffer,
      vecBuffer:   new Float32Array(5 * 4),
      // vecOffsets omitted.
    });

    expect(Array.from(doc.vecOffsets)).toEqual([0, 2, 2, 5]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getSection
// ─────────────────────────────────────────────────────────────────────────────

describe("Document — getSection", () => {
  test("returns correct range and vectors for each section", () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [
        { range: [0, 50],    vectors: [v(1, 0, 0, 0), v(0, 1, 0, 0)] },
        { range: [50, 150],  vectors: [v(0, 0, 1, 0)] },
        { range: [150, 300], vectors: [] },
      ],
    });

    const s0 = doc.getSection(0);
    expect(s0.start).toBe(0);
    expect(s0.end).toBe(50);
    expect(s0.vectors.length).toBe(2 * 4);
    expectVecEqual(s0.vectors.subarray(0, 4), v(1, 0, 0, 0));
    expectVecEqual(s0.vectors.subarray(4, 8), v(0, 1, 0, 0));

    const s1 = doc.getSection(1);
    expect(s1.start).toBe(50);
    expect(s1.end).toBe(150);
    expectVecEqual(s1.vectors, v(0, 0, 1, 0));

    const s2 = doc.getSection(2);
    expect(s2.start).toBe(150);
    expect(s2.end).toBe(300);
    expect(s2.vectors.length).toBe(0);
  });

  test("returned vectors is a view, not a copy", () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }],
    });

    const sec = doc.getSection(0);
    expect(sec.vectors).toBeInstanceOf(Float32Array);
    expect(sec.vectors.buffer).toBe(doc.vecBuffer.buffer);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// score — basic correctness
// ─────────────────────────────────────────────────────────────────────────────

describe("Document — score, basic correctness", () => {
  test("computes exact cosine for orthogonal basis vectors", () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [
        { range: [0, 10],  vectors: [v(1, 0, 0, 0)] },  // query · this = 1.0
        { range: [10, 20], vectors: [v(0, 1, 0, 0)] },  // query · this = 0.0 (below floor → dropped)
        { range: [20, 30], vectors: [v(0, 0, 1, 0)] },  // 0.0 (dropped)
      ],
    });

    const hits = doc.score(v(1, 0, 0, 0));
    expect(hits.length).toBe(1);
    expect(hits[0].score).toBe(1);
    expect(hits[0].range).toEqual([0, 10]);
    expect(hits[0].documentId).toBe("x");
  });

  test("hit carries documentId, range, score, and bestVec", () => {
    const doc = Document.fromSpec({
      documentId: "biology|water",
      vecDim: 4,
      sections: [{ range: [100, 250], vectors: [v(1, 0, 0, 0)] }],
    });

    const hits = doc.score(v(1, 0, 0, 0));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      score:      1,
      documentId: "biology|water",
      range:      [100, 250],
    });
    expect(hits[0].bestVec).toBeInstanceOf(Float32Array);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// score — max over section's vectors
// ─────────────────────────────────────────────────────────────────────────────

describe("Document — score, max over section vectors", () => {
  test("section with multiple vectors takes the maximum dot product", () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [{
        range: [0, 100],
        vectors: [
          v(0, 1, 0, 0),     // dot with query = 0
          v(1, 0, 0, 0),     // dot with query = 1 (the max)
          v(0, 0, 1, 0),     // dot with query = 0
        ],
      }],
    });

    const hits = doc.score(v(1, 0, 0, 0));
    expect(hits[0].score).toBe(1);
  });

  test("bestVec points to the actual best-matching vector", () => {
    // Three vectors, the second one matches the query best.
    const target = v(1, 0, 0, 0);
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [{
        range: [0, 100],
        vectors: [v(0, 1, 0, 0), target, v(0, 0, 0, 1)],
      }],
    });

    const hits = doc.score(v(1, 0, 0, 0));
    expect(hits[0].bestVec.length).toBe(4);
    expectVecEqual(hits[0].bestVec, target);
  });

  test("bestVec is a zero-copy view into vecBuffer", () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [{ range: [0, 100], vectors: [v(1, 0, 0, 0)] }],
    });

    const hits = doc.score(v(1, 0, 0, 0));
    expect(hits[0].bestVec.buffer).toBe(doc.vecBuffer.buffer);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// score — empty sections, floor cut, ordering
// ─────────────────────────────────────────────────────────────────────────────

describe("Document — score, filtering and ordering", () => {
  test("empty sections (no vectors) emit no hits", () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [
        { range: [0, 50],   vectors: [v(1, 0, 0, 0)] },  // strong match
        { range: [50, 100], vectors: [] },                // empty — no hit
        { range: [100, 150], vectors: [v(1, 0, 0, 0)] }, // strong match
      ],
    });

    const hits = doc.score(v(1, 0, 0, 0));
    expect(hits).toHaveLength(2);
    expect(hits.map(h => h.range)).toEqual([[0, 50], [100, 150]]);
  });

  test("sections strictly below the floor are dropped", () => {
    // Custom floor 0.5; only the first vector (dot=1) passes.
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [
        { range: [0, 10],  vectors: [v(1, 0, 0, 0)] },          // 1.0 → pass
        { range: [10, 20], vectors: [v(0.4, 0, 0, 0)] },        // 0.4 → drop
        { range: [20, 30], vectors: [v(0.6, 0, 0, 0)] },        // 0.6 → pass
      ],
    });

    const hits = doc.score(v(1, 0, 0, 0), 0.5);
    expect(hits).toHaveLength(2);
    expect(hits.map(h => h.range)).toEqual([[0, 10], [20, 30]]);
  });

  test("hits are returned in document order, not sorted by score", () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [
        { range: [0, 10],   vectors: [v(0.5, 0, 0, 0)] },   // weakest match
        { range: [10, 20],  vectors: [v(1.0, 0, 0, 0)] },   // strongest match
        { range: [20, 30],  vectors: [v(0.75, 0, 0, 0)] },  // middle
      ],
    });

    const hits = doc.score(v(1, 0, 0, 0));
    // Returned in section order; sort is the search pipeline's job.
    expect(hits.map(h => h.range)).toEqual([[0, 10], [10, 20], [20, 30]]);
    expect(hits[0].score).toBeCloseTo(0.5);
    expect(hits[1].score).toBeCloseTo(1.0);
    expect(hits[2].score).toBeCloseTo(0.75);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// score — error paths
// ─────────────────────────────────────────────────────────────────────────────

describe("Document — score, error paths", () => {
  test("throws when queryVec is not a Float32Array", () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }],
    });

    expect(() => doc.score([1, 0, 0, 0])).toThrow(/Float32Array/);
    expect(() => doc.score(new Array(4).fill(0))).toThrow(/Float32Array/);
  });

  test("throws when queryVec dim does not match", () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }],
    });

    expect(() => doc.score(v(1, 0, 0, 0, 0))).toThrow(/dim 5 does not match/);
    expect(() => doc.score(v(1, 0))).toThrow(/dim 2 does not match/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// score — static form
// ─────────────────────────────────────────────────────────────────────────────

describe("Document — Document.score (static form)", () => {
  test("Document.score(doc, q) returns the same result as doc.score(q)", () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [
        { range: [0, 10],  vectors: [v(1, 0, 0, 0)] },
        { range: [10, 20], vectors: [v(0.7, 0.7, 0, 0)] },
      ],
    });

    const query = v(1, 0, 0, 0);
    const fromInstance = doc.score(query);
    const fromStatic   = Document.score(doc, query);

    expect(fromStatic).toHaveLength(fromInstance.length);
    for (let i = 0; i < fromInstance.length; i++) {
      expect(fromStatic[i].score).toBe(fromInstance[i].score);
      expect(fromStatic[i].range).toEqual(fromInstance[i].range);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// search — delegation
// ─────────────────────────────────────────────────────────────────────────────

describe("Document — search delegation", () => {
  test("doc.search returns an array (delegation to VectorStore/search works)", () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [
        { range: [0, 10],  vectors: [v(1, 0, 0, 0)] },
        { range: [10, 20], vectors: [v(0.7, 0.7, 0, 0)] },
      ],
    });

    const hits = doc.search(v(1, 0, 0, 0));
    expect(Array.isArray(hits)).toBe(true);

    // The search pipeline strips `bestVec` from returned hits.
    if (hits.length > 0) expect(hits[0].bestVec).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toBuffer / fromBuffer round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("Document — toBuffer / fromBuffer round-trip", () => {
  test("fields are recovered byte-for-byte", () => {
    const original = Document.fromSpec({
      documentId: "theme|round-trip",
      vecDim: 4,
      sections: [
        { range: [0, 50],    vectors: [v(1, 0, 0, 0), v(0, 1, 0, 0)] },
        { range: [50, 150],  vectors: [v(0.5, 0.5, 0.5, 0.5)] },
        { range: [150, 300], vectors: [] },
      ],
    });

    const buf = original.toBuffer();
    const restored = Document.fromBuffer(buf);

    expect(restored.documentId).toBe(original.documentId);
    expect(restored.version).toBe(original.version);
    expect(restored.indexDim).toBe(original.indexDim);
    expect(restored.vecDim).toBe(original.vecDim);
    expect(restored.numSections).toBe(original.numSections);
    expect(restored.totalVecs).toBe(original.totalVecs);
    expect(Array.from(restored.indexBuffer)).toEqual(Array.from(original.indexBuffer));
    expect(Array.from(restored.vecBuffer)).toEqual(Array.from(original.vecBuffer));
    expect(Array.from(restored.vecOffsets)).toEqual(Array.from(original.vecOffsets));
  });

  test("toBuffer produces a fresh Buffer not sharing storage with internal views", () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }],
    });

    const buf = doc.toBuffer();
    expect(buf).toBeInstanceOf(Buffer);
    // The Document's internal buffers were allocated freshly by buildFromSpec;
    // the serialized output is a separate allocation.
    expect(buf.buffer).not.toBe(doc.vecBuffer.buffer);
    expect(buf.buffer).not.toBe(doc.indexBuffer.buffer);
  });

  test("toBuffer length matches the expected layout size", () => {
    const documentId = "x|y";
    const dim = 4;
    const doc = Document.fromSpec({
      documentId,
      vecDim: dim,
      sections: [
        { range: [0, 10],  vectors: [v(1, 0, 0, 0), v(0, 1, 0, 0)] },
        { range: [10, 20], vectors: [v(0, 0, 1, 0)] },
      ],
    });

    const buf = doc.toBuffer();
    const idBytes  = Buffer.byteLength(documentId, "utf8");
    const idPadded = (idBytes + 3) & ~3;
    const expected = HEADER_BYTES + idPadded + (2 * 3 * 4) + (3 * dim * 4);
    expect(buf.length).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// write — disk I/O
// ─────────────────────────────────────────────────────────────────────────────

describe("Document — write", () => {
  test("writes the toBuffer() bytes to the given filepath", async () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }],
    });

    const filepath = path.join(tmpRoot, "write-basic.bin");
    await doc.write(filepath);

    const onDisk = await fs.readFile(filepath);
    expect(Buffer.compare(onDisk, doc.toBuffer())).toBe(0);
  });

  test("returns the Document instance for chaining", async () => {
    const doc = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }],
    });

    const result = await doc.write(path.join(tmpRoot, "write-chain.bin"));
    expect(result).toBe(doc);
  });

  test("written file round-trips back to an equivalent Document", async () => {
    const original = Document.fromSpec({
      documentId: "biology|water",
      vecDim: 4,
      sections: [
        { range: [0, 50],   vectors: [v(1, 0, 0, 0), v(0, 1, 0, 0)] },
        { range: [50, 100], vectors: [v(0.5, 0.5, 0.5, 0.5)] },
      ],
    });

    const filepath = path.join(tmpRoot, "round-trip.bin");
    await original.write(filepath);

    const restored = await Document.create(filepath);

    expect(restored.documentId).toBe(original.documentId);
    expect(restored.numSections).toBe(original.numSections);
    expect(restored.totalVecs).toBe(original.totalVecs);
    expect(Array.from(restored.vecBuffer)).toEqual(Array.from(original.vecBuffer));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Static factories — fromBuffer, fromSpec
// ─────────────────────────────────────────────────────────────────────────────

describe("Document — static factories", () => {
  test("fromBuffer parses a buffer into a Document", () => {
    const buf = Document.fromSpec({
      documentId: "x",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }],
    }).toBuffer();

    const doc = Document.fromBuffer(buf);
    expect(doc).toBeInstanceOf(Document);
    expect(doc.documentId).toBe("x");
  });

  test("fromSpec builds a Document from a spec", () => {
    const doc = Document.fromSpec({
      documentId: "spec-built",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }],
    });

    expect(doc).toBeInstanceOf(Document);
    expect(doc.documentId).toBe("spec-built");
    expect(doc.numSections).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Document.create — input-type dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe("Document — create (dispatch)", () => {
  test("create(string) reads from disk", async () => {
    const original = Document.fromSpec({
      documentId: "from-string",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }],
    });

    const filepath = path.join(tmpRoot, "create-string.bin");
    await original.write(filepath);

    const restored = await Document.create(filepath);
    expect(restored).toBeInstanceOf(Document);
    expect(restored.documentId).toBe("from-string");
  });

  test("create(Buffer) parses raw bytes", async () => {
    const original = Document.fromSpec({
      documentId: "from-buffer",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }],
    });

    const restored = await Document.create(original.toBuffer());
    expect(restored).toBeInstanceOf(Document);
    expect(restored.documentId).toBe("from-buffer");
  });

  test("create(spec) builds from a spec object", async () => {
    const restored = await Document.create({
      documentId: "from-spec",
      vecDim: 4,
      sections: [{ range: [0, 10], vectors: [v(1, 0, 0, 0)] }],
    });

    expect(restored).toBeInstanceOf(Document);
    expect(restored.documentId).toBe("from-spec");
  });

  test("create rejects when the filepath does not exist", async () => {
    await expect(Document.create(path.join(tmpRoot, "does-not-exist.bin"))).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export conventions
// ─────────────────────────────────────────────────────────────────────────────

describe("Document — module export conventions", () => {
  test("the export is the class itself", () => {
    expect(typeof Document).toBe("function");
    expect(Document.prototype.constructor).toBe(Document);
  });

  test("exposes a self-referential .Document property", () => {
    expect(Document.Document).toBe(Document);
  });

  test("the exported class is frozen", () => {
    expect(Object.isFrozen(Document)).toBe(true);
  });
});
