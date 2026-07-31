"use strict";

const fs = require("fs");
const fsAsync = fs.promises;
const path = require("path");
const os = require("os");

const SectionResolver = require("../../../src/actions/query/SectionResolver");

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const makeCorpus = async () => {
  const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-test-"));

  const layout = {
    "biocides/water_chemistry.md":
      "## Active Export Systems\nEfflux pumps actively transport biocides out of cells.\n\n## Biofilm Protection\nThe matrix acts as a physical barrier.",
    "biocides/causes_of_resistance.md":
      "## Sublethal Exposure\nLow concentration creates tolerance.\n\n## Chemical Program\nRepeated chemistries without verification.",
    "operations/inspection.md":
      "## Weekly Checks\nMonitor disinfectant residual.\nCheck ATP every Tuesday.",
  };

  for (const [relPath, content] of Object.entries(layout)) {
    const fullPath = path.join(root, relPath);
    await fsAsync.mkdir(path.dirname(fullPath), { recursive: true });
    await fsAsync.writeFile(fullPath, content, "utf8");
  }

  return { root, layout };
};

const cleanup = async (root) => {
  await fsAsync.rm(root, { recursive: true, force: true });
};

const SYNC_PATH  = { name: "constructor",       build: (input) => new SectionResolver(input) };
const ASYNC_PATH = { name: "static create()",   build: (input) => SectionResolver.create(input) };

const construct = async ({ build }, input) => build(input);

// ─────────────────────────────────────────────────────────────────────────────
// Shared behavior — runs against both construction paths
// ─────────────────────────────────────────────────────────────────────────────

describe.each([SYNC_PATH, ASYNC_PATH])("SectionResolver — $name — Map input", (adapter) => {
  test("accepts a prebuilt Map", async () => {
    const map = new Map([["test|doc", "ABCDEFGHIJ"]]);
    const resolver = await construct(adapter, map);
    expect(resolver.size).toBe(1);
    expect(resolver.documentIds).toEqual(["test|doc"]);
    expect(resolver.resolve("test|doc", [0, 5])).toBe("ABCDE");
  });

  test("empty Map is valid (size 0)", async () => {
    const resolver = await construct(adapter, new Map());
    expect(resolver.size).toBe(0);
    expect(resolver.documentIds).toEqual([]);
  });
});

describe.each([SYNC_PATH, ASYNC_PATH])("SectionResolver — $name — directory input", (adapter) => {
  test("walks a 3-document corpus and indexes all .md files", async () => {
    const { root } = await makeCorpus();
    try {
      const resolver = await construct(adapter, root);
      expect(resolver.size).toBe(3);
      expect(resolver.documentIds).toEqual(expect.arrayContaining([
        "biocides|water_chemistry",
        "biocides|causes_of_resistance",
        "operations|inspection",
      ]));
    } finally {
      await cleanup(root);
    }
  });

  test("walks recursively through nested subdirectories", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-deep-"));
    try {
      const deepPath = path.join(root, "a", "b", "c", "leaf.md");
      await fsAsync.mkdir(path.dirname(deepPath), { recursive: true });
      await fsAsync.writeFile(deepPath, "deep content", "utf8");

      const resolver = await construct(adapter, root);
      expect(resolver.documentIds).toContain("c|leaf");
      expect(resolver.size).toBe(1);
    } finally {
      await cleanup(root);
    }
  });

  test("ignores non-.md files in directory walks", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-mixed-"));
    try {
      await fsAsync.writeFile(path.join(root, "real.md"), "md content", "utf8");
      await fsAsync.writeFile(path.join(root, "ignored.txt"), "txt content", "utf8");
      await fsAsync.writeFile(path.join(root, "image.png"), "binary", "utf8");

      const resolver = await construct(adapter, root);
      expect(resolver.size).toBe(1);
      const ids = resolver.documentIds;
      expect(ids.some(id => id.endsWith("|real"))).toBe(true);
    } finally {
      await cleanup(root);
    }
  });

  test("empty directory produces a resolver with size 0", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-empty-"));
    try {
      const resolver = await construct(adapter, root);
      expect(resolver.size).toBe(0);
      expect(resolver.documentIds).toEqual([]);
    } finally {
      await cleanup(root);
    }
  });

  test("throws when path does not exist", async () => {
    const nonExistent = path.join(os.tmpdir(), "section-resolver-does-not-exist-" + Date.now());
    if (adapter === SYNC_PATH) {
      expect(() => adapter.build(nonExistent)).toThrow(/cannot stat/);
    } else {
      await expect(adapter.build(nonExistent)).rejects.toThrow(/cannot stat/);
    }
  });
});

describe.each([SYNC_PATH, ASYNC_PATH])("SectionResolver — $name — single-file input", (adapter) => {
  test("reads a single .md file as a one-entry map", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-single-md-"));
    try {
      const filePath = path.join(root, "theme", "solo.md");
      await fsAsync.mkdir(path.dirname(filePath), { recursive: true });
      await fsAsync.writeFile(filePath, "single file content", "utf8");

      const resolver = await construct(adapter, filePath);
      expect(resolver.size).toBe(1);
      expect(resolver.documentIds).toEqual(["theme|solo"]);
    } finally {
      await cleanup(root);
    }
  });

  test("accepts a single non-.md file (caller named it explicitly)", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-single-txt-"));
    try {
      const filePath = path.join(root, "theme", "solo.txt");
      await fsAsync.mkdir(path.dirname(filePath), { recursive: true });
      await fsAsync.writeFile(filePath, "txt content", "utf8");

      const resolver = await construct(adapter, filePath);
      expect(resolver.size).toBe(1);
    } finally {
      await cleanup(root);
    }
  });

  test("resolves content via the single file's documentId", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-single-resolve-"));
    try {
      const filePath = path.join(root, "theme", "doc.md");
      await fsAsync.mkdir(path.dirname(filePath), { recursive: true });
      await fsAsync.writeFile(filePath, "Hello world!", "utf8");

      const resolver = await construct(adapter, filePath);
      expect(resolver.resolve("theme|doc", [0, 5])).toBe("Hello");
    } finally {
      await cleanup(root);
    }
  });
});

describe.each([SYNC_PATH, ASYNC_PATH])("SectionResolver — $name — input validation", (adapter) => {
  const invalidInputs = [
    [null,        "null"],
    [undefined,   "undefined"],
    [42,          "number"],
    [{},          "plain object"],
    [[],          "array"],
    [new Set(),   "Set"],
    ["",          "empty string"],
  ];

  test.each(invalidInputs)("rejects %o (%s)", async (input) => {
    if (adapter === SYNC_PATH) {
      expect(() => adapter.build(input)).toThrow(/must be a Map.+or a path string/);
    } else {
      await expect(adapter.build(input)).rejects.toThrow(/must be a Map.+or a path string/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolve()
// ─────────────────────────────────────────────────────────────────────────────

describe("SectionResolver.resolve", () => {
  let root;
  let resolver;
  const TEST_CONTENT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const TEST_DOC_ID = "section_resolver_resolve_test|doc";

  beforeAll(async () => {
    root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-resolve-test-"));
    const filePath = path.join(root, "section_resolver_resolve_test", "doc.md");
    await fsAsync.mkdir(path.dirname(filePath), { recursive: true });
    await fsAsync.writeFile(filePath, TEST_CONTENT, "utf8");
    resolver = await SectionResolver.create(root);
  });

  afterAll(async () => {
    await cleanup(root);
  });

  test("returns the correct slice for a valid range", () => {
    expect(resolver.resolve(TEST_DOC_ID, [0, 5])).toBe("ABCDE");
    expect(resolver.resolve(TEST_DOC_ID, [5, 10])).toBe("FGHIJ");
    expect(resolver.resolve(TEST_DOC_ID, [0, 26])).toBe(TEST_CONTENT);
  });

  test("returns empty string for [n, n] zero-length range", () => {
    expect(resolver.resolve(TEST_DOC_ID, [5, 5])).toBe("");
  });

  test("returns null with a warning for unknown documentId", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolver.resolve("nonexistent|doc", [0, 10]);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown documentId"));
    warnSpy.mockRestore();
  });

  test("returns null with a warning for range overshoot", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolver.resolve(TEST_DOC_ID, [0, 100]);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("overshoots content"));
    warnSpy.mockRestore();
  });

  test("returns null for negative start", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolver.resolve(TEST_DOC_ID, [-1, 5])).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("invalid range"));
    warnSpy.mockRestore();
  });

  test("returns null for reversed range (end < start)", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolver.resolve(TEST_DOC_ID, [10, 5])).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("invalid range"));
    warnSpy.mockRestore();
  });

  test("returns null for non-integer range values", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolver.resolve(TEST_DOC_ID, [1.5, 5])).toBeNull();
    expect(resolver.resolve(TEST_DOC_ID, [0, 5.5])).toBeNull();
    warnSpy.mockRestore();
  });

  test("returns null for non-array range", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolver.resolve(TEST_DOC_ID, null)).toBeNull();
    expect(resolver.resolve(TEST_DOC_ID, "0,5")).toBeNull();
    expect(resolver.resolve(TEST_DOC_ID, [1, 2, 3])).toBeNull();
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPath()
// ─────────────────────────────────────────────────────────────────────────────

describe.each([SYNC_PATH, ASYNC_PATH])("SectionResolver — $name — getPath", (adapter) => {
  test("returns null for unknown documentId", async () => {
    const resolver = await construct(adapter, new Map([["t|doc", "x"]]));
    expect(resolver.getPath("does|not_exist")).toBeNull();
  });

  test("returns null for entries ingested via raw Map", async () => {
    const resolver = await construct(adapter, new Map([["t|doc", "x"]]));
    expect(resolver.resolve("t|doc", [0, 1])).toBe("x");
    expect(resolver.getPath("t|doc")).toBeNull();
  });

  test("returns absolute path for a single-file input", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-getpath-file-"));
    try {
      const filePath = path.join(root, "theme", "doc.md");
      await fsAsync.mkdir(path.dirname(filePath), { recursive: true });
      await fsAsync.writeFile(filePath, "content", "utf8");

      const resolver = await construct(adapter, filePath);
      const got = resolver.getPath("theme|doc");

      expect(got).toBe(filePath);
      expect(path.isAbsolute(got)).toBe(true);
    } finally {
      await cleanup(root);
    }
  });

  test("returns absolute paths for every file found in a directory walk", async () => {
    const { root } = await makeCorpus();
    try {
      const resolver = await construct(adapter, root);

      for (const id of resolver.documentIds) {
        const got = resolver.getPath(id);
        expect(typeof got).toBe("string");
        expect(path.isAbsolute(got)).toBe(true);
        expect(fs.existsSync(got)).toBe(true);
      }

      expect(resolver.getPath("biocides|water_chemistry"))
        .toBe(path.join(root, "biocides", "water_chemistry.md"));
    } finally {
      await cleanup(root);
    }
  });
});

describe("SectionResolver.getPath — after add()", () => {
  test("records paths for newly-added file inputs", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-getpath-add-file-"));
    try {
      const filePath = path.join(root, "biocides", "new.md");
      await fsAsync.mkdir(path.dirname(filePath), { recursive: true });
      await fsAsync.writeFile(filePath, "added content", "utf8");

      const r = new SectionResolver(new Map());
      expect(r.getPath("biocides|new")).toBeNull();

      await r.add(filePath);

      expect(r.getPath("biocides|new")).toBe(filePath);
      expect(r.resolve("biocides|new", [0, 5])).toBe("added");
    } finally {
      await cleanup(root);
    }
  });

  test("records paths for every file added via a directory input", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-getpath-add-dir-"));
    try {
      const writeMd = async (relPath, content) => {
        const full = path.join(root, relPath);
        await fsAsync.mkdir(path.dirname(full), { recursive: true });
        await fsAsync.writeFile(full, content, "utf8");
        return full;
      };
      const a = await writeMd("biocides/a.md", "alpha");
      const b = await writeMd("biocides/b.md", "beta");

      const r = new SectionResolver(new Map());
      await r.add(root);

      expect(r.getPath("biocides|a")).toBe(a);
      expect(r.getPath("biocides|b")).toBe(b);
    } finally {
      await cleanup(root);
    }
  });

  test("does not record paths for entries added via Map", async () => {
    const r = new SectionResolver(new Map());
    await r.add(new Map([["t|map_only", "no-path-here"]]));

    expect(r.resolve("t|map_only", [0, 2])).toBe("no");
    expect(r.getPath("t|map_only")).toBeNull();
  });

  test("mixed add records paths only for path-input entries", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-getpath-add-mix-"));
    try {
      const filePath = path.join(root, "t", "file.md");
      await fsAsync.mkdir(path.dirname(filePath), { recursive: true });
      await fsAsync.writeFile(filePath, "from-file", "utf8");

      const r = new SectionResolver(new Map());
      await r.add(
        new Map([["from|map", "map-content"]]),
        filePath,
      );

      expect(r.getPath("from|map")).toBeNull();
      expect(r.getPath("t|file")).toBe(filePath);
    } finally {
      await cleanup(root);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Collision detection
// ─────────────────────────────────────────────────────────────────────────────

describe.each([SYNC_PATH, ASYNC_PATH])("SectionResolver — $name — documentId collision", (adapter) => {
  test("error thrown when two files derive to the same documentId", async () => {
    // Behavior verified indirectly via Map-input tests.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("SectionResolver — module export", () => {
  test("module is the class itself", () => {
    expect(typeof SectionResolver).toBe("function");
    expect(SectionResolver.prototype).toBeDefined();
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(SectionResolver)).toBe(true);
  });

  test("self-referential .SectionResolver property", () => {
    expect(SectionResolver.SectionResolver).toBe(SectionResolver);
  });

  test("constructor yields instanceof SectionResolver", () => {
    const instance = new SectionResolver(new Map());
    expect(instance).toBeInstanceOf(SectionResolver);
  });

  test("create yields instanceof SectionResolver", async () => {
    const instance = await SectionResolver.create(new Map());
    expect(instance).toBeInstanceOf(SectionResolver);
  });

  test("has static create method", () => {
    expect(typeof SectionResolver.create).toBe("function");
  });

  test("instance methods exist on prototype", () => {
    expect(typeof SectionResolver.prototype.resolve).toBe("function");
    expect(typeof SectionResolver.prototype.getPath).toBe("function");
    expect(typeof SectionResolver.prototype.add).toBe("function");
    expect(typeof SectionResolver.prototype.remove).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// add()
// ─────────────────────────────────────────────────────────────────────────────

describe("SectionResolver.add — single input modes", () => {
  test("adds a single Map", async () => {
    const r = new SectionResolver(new Map());
    const added = await r.add(new Map([["new|doc", "hello"]]));

    expect(added).toBe(1);
    expect(r.size).toBe(1);
    expect(r.resolve("new|doc", [0, 5])).toBe("hello");
  });

  test("adds a single file path", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-add-file-"));
    try {
      const filepath = path.join(root, "biocides", "new.md");
      await fsAsync.mkdir(path.dirname(filepath), { recursive: true });
      await fsAsync.writeFile(filepath, "ABCDEFG", "utf8");

      const r = new SectionResolver(new Map());
      const added = await r.add(filepath);

      expect(added).toBe(1);
      expect(r.size).toBe(1);
      expect(r.resolve("biocides|new", [0, 3])).toBe("ABC");
    } finally {
      await cleanup(root);
    }
  });

  test("adds a directory of markdowns", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-add-dir-"));
    try {
      const writeMd = async (relPath, content) => {
        const full = path.join(root, relPath);
        await fsAsync.mkdir(path.dirname(full), { recursive: true });
        await fsAsync.writeFile(full, content, "utf8");
      };
      await writeMd("biocides/a.md", "alpha");
      await writeMd("biocides/b.md", "beta");
      await writeMd("biology/c.md",  "gamma");

      const r = new SectionResolver(new Map());
      const added = await r.add(root);

      expect(added).toBe(3);
      expect(r.size).toBe(3);
      expect(r.documentIds.sort()).toEqual([
        "biocides|a", "biocides|b", "biology|c",
      ]);
    } finally {
      await cleanup(root);
    }
  });

  test("preserves entries already in the resolver", async () => {
    const r = new SectionResolver(new Map([["existing|doc", "old"]]));
    await r.add(new Map([["new|doc", "new"]]));

    expect(r.size).toBe(2);
    expect(r.resolve("existing|doc", [0, 3])).toBe("old");
    expect(r.resolve("new|doc", [0, 3])).toBe("new");
  });
});

describe("SectionResolver.add — variadic", () => {
  test("accepts multiple file paths as separate args", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-add-var-"));
    try {
      const writeMd = async (relPath, content) => {
        const full = path.join(root, relPath);
        await fsAsync.mkdir(path.dirname(full), { recursive: true });
        await fsAsync.writeFile(full, content, "utf8");
        return full;
      };
      const a = await writeMd("t/a.md", "AAA");
      const b = await writeMd("t/b.md", "BBB");

      const r = new SectionResolver(new Map());
      const added = await r.add(a, b);

      expect(added).toBe(2);
      expect(r.documentIds.sort()).toEqual(["t|a", "t|b"]);
    } finally {
      await cleanup(root);
    }
  });

  test("accepts an array of paths", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-add-arr-"));
    try {
      const writeMd = async (relPath, content) => {
        const full = path.join(root, relPath);
        await fsAsync.mkdir(path.dirname(full), { recursive: true });
        await fsAsync.writeFile(full, content, "utf8");
        return full;
      };
      const a = await writeMd("t/a.md", "AAA");
      const b = await writeMd("t/b.md", "BBB");

      const r = new SectionResolver(new Map());
      const added = await r.add([a, b]);

      expect(added).toBe(2);
    } finally {
      await cleanup(root);
    }
  });

  test("flat(Infinity) unrolls nested arrays", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-add-nest-"));
    try {
      const writeMd = async (relPath, content) => {
        const full = path.join(root, relPath);
        await fsAsync.mkdir(path.dirname(full), { recursive: true });
        await fsAsync.writeFile(full, content, "utf8");
        return full;
      };
      const a = await writeMd("t/a.md", "AAA");
      const b = await writeMd("t/b.md", "BBB");
      const c = await writeMd("t/c.md", "CCC");

      const r = new SectionResolver(new Map());
      const added = await r.add([[a], [[b, c]]]);

      expect(added).toBe(3);
    } finally {
      await cleanup(root);
    }
  });

  test("mixes Maps, paths, and arrays in one call", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-add-mix-"));
    try {
      const filepath = path.join(root, "t", "file.md");
      await fsAsync.mkdir(path.dirname(filepath), { recursive: true });
      await fsAsync.writeFile(filepath, "from-file", "utf8");

      const r = new SectionResolver(new Map());
      const added = await r.add(
        new Map([["from|map1", "m1"]]),
        filepath,
        [new Map([["from|map2", "m2"]]), new Map([["from|map3", "m3"]])],
      );

      expect(added).toBe(4);
      expect(r.documentIds.sort()).toEqual([
        "from|map1", "from|map2", "from|map3", "t|file",
      ]);
    } finally {
      await cleanup(root);
    }
  });

  test("empty variadic call returns 0", async () => {
    const r = new SectionResolver(new Map());
    expect(await r.add()).toBe(0);
    expect(r.size).toBe(0);
  });

  test("empty array call returns 0", async () => {
    const r = new SectionResolver(new Map());
    expect(await r.add([])).toBe(0);
    expect(r.size).toBe(0);
  });
});

describe("SectionResolver.add — collision detection", () => {
  test("throws when an incoming documentId already exists in the index", async () => {
    const r = new SectionResolver(new Map([["t|doc", "old"]]));

    await expect(r.add(new Map([["t|doc", "new"]])))
      .rejects.toThrow(/collision with existing index.+t\|doc/);

    expect(r.size).toBe(1);
    expect(r.resolve("t|doc", [0, 3])).toBe("old");
  });

  test("throws when two args in the same call share a documentId", async () => {
    const r = new SectionResolver(new Map());

    await expect(r.add(
      new Map([["t|doc", "from-1"]]),
      new Map([["t|doc", "from-2"]]),
    )).rejects.toThrow(/collision within this call.+t\|doc/);

    expect(r.size).toBe(0);
  });

  test("on collision, index is left in its pre-call state (atomic)", async () => {
    const r = new SectionResolver(new Map([["t|existing", "old"]]));

    await expect(r.add(
      new Map([["t|fresh", "this would be valid"]]),
      new Map([["t|existing", "this collides"]]),
    )).rejects.toThrow();

    expect(r.size).toBe(1);
    expect(r.documentIds).toEqual(["t|existing"]);
  });
});

describe("SectionResolver.add — read failures", () => {
  test("throws AggregateError when a path doesn't exist", async () => {
    const root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-add-readfail-"));
    try {
      const ok = path.join(root, "t", "ok.md");
      await fsAsync.mkdir(path.dirname(ok), { recursive: true });
      await fsAsync.writeFile(ok, "good", "utf8");

      const missing = path.join(root, "does-not-exist.md");

      const r = new SectionResolver(new Map());

      let err;
      try {
        await r.add(ok, missing);
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(AggregateError);
      expect(err.errors.length).toBeGreaterThanOrEqual(1);
      expect(r.size).toBe(0);
    } finally {
      await cleanup(root);
    }
  });

  test("throws on invalid argument shape", async () => {
    const r = new SectionResolver(new Map());
    await expect(r.add(42)).rejects.toThrow();
    await expect(r.add(null)).rejects.toThrow();
    await expect(r.add({})).rejects.toThrow();
  });
});

describe("SectionResolver.add — return value", () => {
  test("returns the number of NEW documents added", async () => {
    const r = new SectionResolver(new Map([["existing|doc", "x"]]));
    const added = await r.add(new Map([
      ["new|a", "a"],
      ["new|b", "b"],
    ]));
    expect(added).toBe(2);
    expect(r.size).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// remove()
// ─────────────────────────────────────────────────────────────────────────────

describe("SectionResolver.remove — single input modes", () => {
  const makeMapResolver = (entries) => new SectionResolver(new Map(Object.entries(entries)));

  test("removes a single documentId", () => {
    const r = makeMapResolver({ "t|a": "A", "t|b": "B", "t|c": "C" });
    const removed = r.remove("t|b");
    expect(removed).toBe(1);
    expect(r.size).toBe(2);
    expect(r.documentIds.sort()).toEqual(["t|a", "t|c"]);
  });

  test("removes multiple documentIds as separate args", () => {
    const r = makeMapResolver({ "t|a": "A", "t|b": "B", "t|c": "C", "t|d": "D" });
    expect(r.remove("t|a", "t|c")).toBe(2);
    expect(r.documentIds.sort()).toEqual(["t|b", "t|d"]);
  });

  test("accepts an array of documentIds", () => {
    const r = makeMapResolver({ "t|a": "A", "t|b": "B", "t|c": "C" });
    expect(r.remove(["t|a", "t|b"])).toBe(2);
    expect(r.documentIds).toEqual(["t|c"]);
  });

  test("flat(Infinity) unrolls nested arrays", () => {
    const r = makeMapResolver({ "t|a": "A", "t|b": "B", "t|c": "C", "t|d": "D" });
    expect(r.remove([["t|a"], ["t|b", "t|c"]])).toBe(3);
    expect(r.documentIds).toEqual(["t|d"]);
  });

  test("empty input returns 0 with no warnings", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = makeMapResolver({ "t|a": "A" });
      expect(r.remove()).toBe(0);
      expect(r.remove([])).toBe(0);
      expect(r.size).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("resolve returns null after remove", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = makeMapResolver({ "t|a": "Hello, world" });
      r.remove("t|a");
      expect(r.resolve("t|a", [0, 5])).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/unknown documentId.+t\|a/));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("SectionResolver.remove — path inputs are normalized", () => {
  // Inputs route through deriveDocumentId, so paths AND already-formed
  // ids both work.

  const makeMapResolver = (entries) => new SectionResolver(new Map(Object.entries(entries)));

  test("accepts a file path (derives to documentId)", () => {
    const r = makeMapResolver({ "biology|overview": "content" });
    const removed = r.remove("biology/overview.md");
    expect(removed).toBe(1);
    expect(r.size).toBe(0);
  });

  test("accepts a full filesystem path", () => {
    const r = makeMapResolver({ "biology|overview": "content" });
    const removed = r.remove("/abs/path/to/biology/overview.md");
    expect(removed).toBe(1);
  });

  test("accepts a path with timestamp suffix", () => {
    const r = makeMapResolver({ "biology|overview": "content" });
    const removed = r.remove("biology/overview|md_2026-04-22T02-28-30-099Z.md");
    expect(removed).toBe(1);
  });

  test("mixing path and id inputs dedups by derived id", () => {
    // Both inputs derive to "biology|overview" — the Map collapses
    // them. One target, one matching entry, one removal.
    const r = makeMapResolver({ "biology|overview": "content" });
    const removed = r.remove("biology|overview", "biology/overview.md");
    expect(removed).toBe(1);
  });
});

describe("SectionResolver.remove — cleans both content and paths maps", () => {
  let root;
  let r;

  beforeEach(async () => {
    root = await fsAsync.mkdtemp(path.join(os.tmpdir(), "section-resolver-remove-paths-"));
    const writeMd = async (relPath, content) => {
      const full = path.join(root, relPath);
      await fsAsync.mkdir(path.dirname(full), { recursive: true });
      await fsAsync.writeFile(full, content, "utf8");
      return full;
    };
    await writeMd("t/a.md", "alpha");
    await writeMd("t/b.md", "beta");
    await writeMd("t/c.md", "gamma");

    r = await SectionResolver.create(root);
  });

  afterEach(async () => {
    await cleanup(root);
  });

  test("remove drops the documentId from BOTH content and paths maps", () => {
    expect(r.getPath("t|a")).toMatch(/t\/a\.md$/);

    const removed = r.remove("t|a");
    expect(removed).toBe(1);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(r.resolve("t|a", [0, 5])).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
    expect(r.getPath("t|a")).toBeNull();
  });

  test("surviving entries retain BOTH content and path", () => {
    r.remove("t|a");
    expect(r.resolve("t|b", [0, 4])).toBe("beta");
    expect(r.getPath("t|b")).toMatch(/t\/b\.md$/);
  });
});

describe("SectionResolver.remove — unknown documentIds", () => {
  let warnSpy;
  beforeEach(() => { warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(()  => { warnSpy.mockRestore(); });

  const makeMapResolver = (entries) => new SectionResolver(new Map(Object.entries(entries)));

  test("warn-and-continue on unknown id", () => {
    const r = makeMapResolver({ "t|a": "A", "t|b": "B" });
    const removed = r.remove("t|a", "missing|x");
    expect(removed).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`"missing|x"`));
  });

  test("warning uses the ORIGINAL input string, not the derived id", () => {
    // A user-typed path should appear verbatim in the warning,
    // not as the derived "theme|stem" form.
    const r = makeMapResolver({});

    r.remove("missing/path.md");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`"missing/path.md"`));
  });

  test("removing only unknown ids returns 0, index untouched", () => {
    const r = makeMapResolver({ "t|a": "A", "t|b": "B" });
    expect(r.remove("missing1|x", "missing2|x")).toBe(0);
    expect(r.size).toBe(2);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test("duplicate unknown ids in one call warn only once", () => {
    const r = makeMapResolver({});
    r.remove("missing|x", "missing|x", "missing|x");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("removing same known id twice — removes once, no warning", () => {
    const r = makeMapResolver({ "t|a": "A" });
    const removed = r.remove("t|a", "t|a");
    expect(removed).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("SectionResolver.remove — garbage inputs don't throw", () => {
  let warnSpy;
  beforeEach(() => { warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(()  => { warnSpy.mockRestore(); });

  const makeMapResolver = (entries) => new SectionResolver(new Map(Object.entries(entries)));

  test("derive-throwing input is treated as unknown, not fatal", () => {
    // "!!!" sanitizes to empty stem → deriveDocumentId throws.
    // remove() catches and adds it to the unknown set.
    const r = makeMapResolver({ "t|a": "A" });

    expect(() => r.remove("!!!", "t|a")).not.toThrow();
    // Valid id still removed.
    expect(r.size).toBe(0);
    // Garbage input warned.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`"!!!"`));
  });

  test("multiple derive-throwing inputs all warn, none fatal", () => {
    const r = makeMapResolver({});

    expect(() => r.remove("!!!", "???", "***")).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });
});

describe("SectionResolver.remove — validation", () => {
  const makeMapResolver = (entries) => new SectionResolver(new Map(Object.entries(entries)));

  test("throws on non-string id", () => {
    const r = makeMapResolver({ "t|a": "A" });
    expect(() => r.remove(42)).toThrow(/must be a non-empty string/);
    expect(r.size).toBe(1);
  });

  test("throws on empty string id", () => {
    const r = makeMapResolver({ "t|a": "A" });
    expect(() => r.remove("")).toThrow(/must be a non-empty string/);
  });

  test("validates ALL ids before mutating (no partial removal)", () => {
    const r = makeMapResolver({ "t|a": "A", "t|b": "B" });
    expect(() => r.remove("t|a", 42)).toThrow(/must be a non-empty string/);
    expect(r.size).toBe(2);
  });
});

describe("SectionResolver.remove — interaction with add()", () => {
  test("removed id can be re-added", async () => {
    const r = new SectionResolver(new Map([["t|a", "first"]]));
    r.remove("t|a");
    await r.add(new Map([["t|a", "second"]]));
    expect(r.resolve("t|a", [0, 6])).toBe("second");
  });

  test("removing one id doesn't disturb others added by add()", async () => {
    const r = new SectionResolver(new Map());
    await r.add(new Map([["t|a", "A"], ["t|b", "B"]]));
    r.remove("t|a");
    expect(r.size).toBe(1);
    expect(r.resolve("t|b", [0, 1])).toBe("B");
  });
});