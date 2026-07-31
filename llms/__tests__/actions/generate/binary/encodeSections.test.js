"use strict";

// Mock Document BEFORE requiring encodeSections.
jest.mock("../../../../src/VectorStore/Document", () => {
  const mockToBuffer = jest.fn(() => Buffer.from("mock-vect-binary"));
  const mockFromSpec = jest.fn(spec => ({
    spec,
    toBuffer: mockToBuffer,
  }));
  return {
    fromSpec: mockFromSpec,
    __mockToBuffer: mockToBuffer,
    __mockFromSpec: mockFromSpec,
  };
});

const Document = require("../../../../src/VectorStore/Document");
const encodeSections = require("../../../../src/actions/generate/binary/encodeSections");

const { __mockFromSpec, __mockToBuffer } = Document;

beforeEach(() => {
  __mockFromSpec.mockClear();
  __mockToBuffer.mockClear();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const fakeVec = (label) => new Float32Array([label.charCodeAt(0) || 0, label.length]);

const makeSection = (vecPromises = []) => ({
  range:       [0, 100],
  breadcrumbs: "B",
  content:     "Content.",
  vecs:        vecPromises,
});

const baseOptions = (overrides = {}) => ({
  sections:   [makeSection([Promise.resolve(fakeVec("a"))])],
  documentId: "test|doc",
  vecDim:     2,
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("encodeSections — happy path", () => {
  test("returns a Buffer", async () => {
    const result = await encodeSections(baseOptions());
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  test("calls Document.fromSpec once", async () => {
    await encodeSections(baseOptions());
    expect(__mockFromSpec).toHaveBeenCalledTimes(1);
  });

  test("passes documentId and vecDim to Document.fromSpec", async () => {
    await encodeSections(baseOptions({
      documentId: "biocides|water_chemistry",
      vecDim: 384,
    }));
    const spec = __mockFromSpec.mock.calls[0][0];
    expect(spec.documentId).toBe("biocides|water_chemistry");
    expect(spec.vecDim).toBe(384);
  });

  test("passes resolved vectors per section to Document.fromSpec", async () => {
    const v1 = fakeVec("a");
    const v2 = fakeVec("b");
    const sections = [makeSection([Promise.resolve(v1), Promise.resolve(v2)])];
    await encodeSections(baseOptions({ sections }));
    const spec = __mockFromSpec.mock.calls[0][0];
    expect(spec.sections).toHaveLength(1);
    expect(spec.sections[0].vectors).toEqual([v1, v2]);
    expect(spec.sections[0].range).toEqual([0, 100]);
  });

  test("preserves vector order from the vecs array", async () => {
    const v1 = fakeVec("a"), v2 = fakeVec("b"), v3 = fakeVec("c");
    const sections = [makeSection([
      Promise.resolve(v1),
      Promise.resolve(v2),
      Promise.resolve(v3),
    ])];
    await encodeSections(baseOptions({ sections }));
    const spec = __mockFromSpec.mock.calls[0][0];
    expect(spec.sections[0].vectors[0]).toBe(v1);
    expect(spec.sections[0].vectors[1]).toBe(v2);
    expect(spec.sections[0].vectors[2]).toBe(v3);
  });

  test("handles multiple sections", async () => {
    const sections = [
      makeSection([Promise.resolve(fakeVec("a"))]),
      makeSection([Promise.resolve(fakeVec("b")), Promise.resolve(fakeVec("c"))]),
      makeSection([Promise.resolve(fakeVec("d"))]),
    ];
    sections[0].range = [0, 50];
    sections[1].range = [50, 150];
    sections[2].range = [150, 200];

    await encodeSections(baseOptions({ sections }));
    const spec = __mockFromSpec.mock.calls[0][0];
    expect(spec.sections).toHaveLength(3);
    expect(spec.sections[0].vectors).toHaveLength(1);
    expect(spec.sections[1].vectors).toHaveLength(2);
    expect(spec.sections[2].vectors).toHaveLength(1);
    expect(spec.sections[0].range).toEqual([0, 50]);
    expect(spec.sections[1].range).toEqual([50, 150]);
    expect(spec.sections[2].range).toEqual([150, 200]);
  });

  test("empty sections array produces empty sections in spec", async () => {
    await encodeSections(baseOptions({ sections: [] }));
    const spec = __mockFromSpec.mock.calls[0][0];
    expect(spec.sections).toEqual([]);
  });

  test("section with empty vecs array gets empty vectors array", async () => {
    const sections = [makeSection([])];
    await encodeSections(baseOptions({ sections }));
    const spec = __mockFromSpec.mock.calls[0][0];
    expect(spec.sections[0].vectors).toEqual([]);
  });

  test("section without vecs property gets empty vectors array", async () => {
    const sections = [{ range: [0, 10] }];  // no vecs at all
    await encodeSections(baseOptions({ sections }));
    const spec = __mockFromSpec.mock.calls[0][0];
    expect(spec.sections[0].vectors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parallel resolution
// ─────────────────────────────────────────────────────────────────────────────

describe("encodeSections — parallelism", () => {
  test("all vectorize Promises resolved before Document.fromSpec is called", async () => {
    // Stagger Promises so the test would fail if resolution were serial.
    const slowVec = (label, delay) => new Promise(r =>
      setTimeout(() => r(fakeVec(label)), delay));

    const sections = [
      makeSection([slowVec("a", 20), slowVec("b", 10)]),
      makeSection([slowVec("c", 5),  slowVec("d", 15)]),
    ];
    await encodeSections(baseOptions({ sections }));
    expect(__mockFromSpec).toHaveBeenCalledTimes(1);
    const spec = __mockFromSpec.mock.calls[0][0];
    for (const s of spec.sections) {
      for (const v of s.vectors) {
        expect(v).toBeInstanceOf(Float32Array);
      }
    }
  });

  test("all sections' Promises in flight concurrently (not serialized)", async () => {
    // Each section takes 50ms. If serial, 5 sections = 250ms.
    // If parallel, ~50ms. We allow generous slack.
    const slowVec = () => new Promise(r =>
      setTimeout(() => r(fakeVec("x")), 50));

    const sections = Array.from({ length: 5 }, () =>
      makeSection([slowVec()]));

    const start = Date.now();
    await encodeSections(baseOptions({ sections }));
    const elapsed = Date.now() - start;
    // Parallel should be ~50ms. Serial would be ~250ms. Allow 150ms.
    expect(elapsed).toBeLessThan(150);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure tolerance
// ─────────────────────────────────────────────────────────────────────────────

describe("encodeSections — failure tolerance", () => {
  test("rejected vector is dropped, others survive", async () => {
    const v1 = fakeVec("a");
    const v2 = fakeVec("b");
    const sections = [makeSection([
      Promise.resolve(v1),
      Promise.reject(new Error("vectorize hiccup")),
      Promise.resolve(v2),
    ])];
    const onSectionError = jest.fn();
    await encodeSections(baseOptions({ sections, onSectionError }));
    const spec = __mockFromSpec.mock.calls[0][0];
    expect(spec.sections[0].vectors).toHaveLength(2);
    expect(spec.sections[0].vectors).toEqual([v1, v2]);
    expect(onSectionError).toHaveBeenCalledTimes(1);
  });

  test("onSectionError callback receives section index and error", async () => {
    const sections = [
      makeSection([Promise.resolve(fakeVec("ok"))]),
      makeSection([Promise.reject(new Error("bad vec"))]),
    ];
    const onSectionError = jest.fn();
    await encodeSections(baseOptions({ sections, onSectionError }));
    expect(onSectionError).toHaveBeenCalledTimes(1);
    expect(onSectionError.mock.calls[0][0]).toBe(1);  // index 1
    expect(onSectionError.mock.calls[0][1]).toBeInstanceOf(Error);
  });

  test("all vectors fail in a section: section gets empty vectors, Document still built", async () => {
    const sections = [makeSection([
      Promise.reject(new Error("a")),
      Promise.reject(new Error("b")),
    ])];
    const onSectionError = jest.fn();
    await encodeSections(baseOptions({ sections, onSectionError }));
    const spec = __mockFromSpec.mock.calls[0][0];
    expect(spec.sections[0].vectors).toEqual([]);
    expect(onSectionError).toHaveBeenCalledTimes(2);
  });

  test("no callback: failures are silently tolerated", async () => {
    const sections = [makeSection([Promise.reject(new Error("hiccup"))])];
    await expect(encodeSections(baseOptions({ sections })))
      .resolves.toBeInstanceOf(Buffer);
  });

  test("failure in one section doesn't affect others", async () => {
    const v1 = fakeVec("a"), v2 = fakeVec("b");
    const sections = [
      makeSection([Promise.resolve(v1)]),
      makeSection([Promise.reject(new Error("x"))]),
      makeSection([Promise.resolve(v2)]),
    ];
    const onSectionError = jest.fn();
    await encodeSections(baseOptions({ sections, onSectionError }));
    const spec = __mockFromSpec.mock.calls[0][0];
    expect(spec.sections[0].vectors).toEqual([v1]);
    expect(spec.sections[1].vectors).toEqual([]);
    expect(spec.sections[2].vectors).toEqual([v2]);
    expect(onSectionError).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe("encodeSections — input validation", () => {
  test("throws when sections is not an array", async () => {
    await expect(encodeSections(baseOptions({ sections: "no" })))
      .rejects.toThrow(/sections must be an array/);
  });

  test("throws when documentId is missing", async () => {
    await expect(encodeSections(baseOptions({ documentId: undefined })))
      .rejects.toThrow(/documentId must be a non-empty string/);
  });

  test("throws when documentId is empty", async () => {
    await expect(encodeSections(baseOptions({ documentId: "" })))
      .rejects.toThrow(/documentId must be a non-empty string/);
  });

  test("throws when vecDim is missing", async () => {
    await expect(encodeSections(baseOptions({ vecDim: undefined })))
      .rejects.toThrow(/vecDim must be a positive integer/);
  });

  test("throws when vecDim is zero", async () => {
    await expect(encodeSections(baseOptions({ vecDim: 0 })))
      .rejects.toThrow(/vecDim must be a positive integer/);
  });

  test("throws when vecDim is negative", async () => {
    await expect(encodeSections(baseOptions({ vecDim: -1 })))
      .rejects.toThrow(/vecDim must be a positive integer/);
  });

  test("throws when vecDim is not an integer", async () => {
    await expect(encodeSections(baseOptions({ vecDim: 3.14 })))
      .rejects.toThrow(/vecDim must be a positive integer/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Document.fromSpec failure
// ─────────────────────────────────────────────────────────────────────────────

describe("encodeSections — Document failure propagation", () => {
  test("Document.fromSpec throwing propagates as a fundamental error", async () => {
    __mockFromSpec.mockImplementationOnce(() => {
      throw new Error("malformed spec");
    });
    await expect(encodeSections(baseOptions()))
      .rejects.toThrow(/malformed spec/);
  });

  test("toBuffer throwing propagates", async () => {
    __mockToBuffer.mockImplementationOnce(() => {
      throw new Error("serialization failure");
    });
    await expect(encodeSections(baseOptions()))
      .rejects.toThrow(/serialization failure/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────────────

describe("encodeSections — module export", () => {
  test("module is the function", () => {
    expect(typeof encodeSections).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(encodeSections)).toBe(true);
  });

  test("self-referential property", () => {
    expect(encodeSections.encodeSections).toBe(encodeSections);
  });
});
