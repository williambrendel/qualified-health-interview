"use strict";

/**
 * @file SpellEngine.test.js
 * @brief Unit tests for SpellEngine.
 *
 * The new SpellEngine constructor is fully variadic — it detects dictionary
 * objects by shape ({ dic, aff }), word arrays by Array.isArray, and
 * corrections by plain object. There is no external mockDic; the engine
 * builds its own nspell instance internally via personal().
 *
 * Unit tests verify behavior via correct() calls — the only observable
 * surface. Integration tests using createEnglish verify end-to-end behavior
 * with the real English dictionary and the production JSON data files.
 */

const SpellEngine = require("../src/SpellEngine");
const corrections = require("./data/corrections.json");
const domainWords = require("./data/domainWords.json");

// ─────────────────────────────────────────────────────────────────────────────
// Construction — basic
// ─────────────────────────────────────────────────────────────────────────────

describe("SpellEngine — construction", () => {
  test("no sources — engine created without error", () => {
    expect(() => SpellEngine.create()).not.toThrow();
  });

  test("instance is frozen", () => {
    expect(Object.isFrozen(SpellEngine.create())).toBe(true);
  });

  test("cannot add properties after construction", () => {
    expect(() => { SpellEngine.create().foo = 1; }).toThrow();
  });

  test("corrections object alone — no error", () => {
    expect(() => SpellEngine.create({ teh: "the" })).not.toThrow();
  });

  test("word array alone — no error", () => {
    expect(() => SpellEngine.create(["Legionella"])).not.toThrow();
  });

  test("null source skipped silently", () => {
    expect(() => SpellEngine.create(null, { teh: "the" })).not.toThrow();
  });

  test("undefined source skipped silently", () => {
    expect(() => SpellEngine.create(undefined, ["word"])).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// correct() — falsy input
// ─────────────────────────────────────────────────────────────────────────────

describe("SpellEngine.correct — falsy input", () => {
  const engine = SpellEngine.create();

  test("null returned as-is",         () => expect(engine.correct(null)).toBeNull());
  test("undefined returned as-is",    () => expect(engine.correct(undefined)).toBeUndefined());
  test("empty string returned as-is", () => expect(engine.correct("")).toBe(""));
  test("0 returned as-is",            () => expect(engine.correct(0)).toBe(0));
});

// ─────────────────────────────────────────────────────────────────────────────
// correct() — punctuation normalization (no dictionary needed)
// ─────────────────────────────────────────────────────────────────────────────

describe("SpellEngine.correct — punctuation normalization", () => {
  const engine = SpellEngine.create();

  test("multiple commas → single",         () => expect(engine.correct("a,,,b")).toBe("a,b"));
  test("multiple exclamation → single",    () => expect(engine.correct("wow!!!")).toBe("wow!"));
  test("multiple question marks → single", () => expect(engine.correct("really???")).toBe("really?"));
  test("four dots → ellipsis",             () => expect(engine.correct("wait....")).toBe("wait..."));
  test("two dots → ellipsis",              () => expect(engine.correct("wait..")).toBe("wait..."));
  test("underscore → hyphen",              () => expect(engine.correct("some_thing")).toBe("some-thing"));
  test("tilde → hyphen",                   () => expect(engine.correct("some~thing")).toBe("some-thing"));
  test("double hyphen → em dash",          () => expect(engine.correct("a--b")).toBe("a—b"));
  test("triple hyphen → em dash",          () => expect(engine.correct("a---b")).toBe("a—b"));
  test("clean input unchanged",            () => expect(engine.correct("Hello world")).toBe("Hello world"));
});

// ─────────────────────────────────────────────────────────────────────────────
// correct() — corrections map (no dictionary needed)
// ─────────────────────────────────────────────────────────────────────────────

describe("SpellEngine.correct — corrections map", () => {
  const engine = SpellEngine.create({ teh: "the", alot: "a lot", legionella: "Legionella" });

  test("correction applied",                    () => expect(engine.correct("teh")).toBe("the"));
  test("multi-word correction",                 () => expect(engine.correct("alot")).toBe("a lot"));
  test("capitalization correction",             () => expect(engine.correct("legionella")).toBe("Legionella"));
  test("case-insensitive key — TEH → the",      () => expect(engine.correct("TEH")).toBe("the"));
  test("word not in corrections — passed through", () => expect(engine.correct("water")).toBe("water"));
  test("punctuation tokens not corrected",      () => expect(engine.correct("teh,alot")).toBe("the,a lot"));
  test("correction in sentence context",        () => expect(engine.correct("teh water")).toBe("the water"));
});

// ─────────────────────────────────────────────────────────────────────────────
// correct() — multiple correction sources merged
// ─────────────────────────────────────────────────────────────────────────────

describe("SpellEngine.correct — multiple correction sources", () => {
  test("two correction objects merged", () => {
    const engine = SpellEngine.create({ teh: "the" }, { alot: "a lot" });
    expect(engine.correct("teh")).toBe("the");
    expect(engine.correct("alot")).toBe("a lot");
  });

  test("later correction object overrides earlier on conflict", () => {
    const engine = SpellEngine.create({ foo: "bar" }, { foo: "baz" });
    expect(engine.correct("foo")).toBe("baz");
  });

  test("interleaved arrays and objects — all applied", () => {
    const engine = SpellEngine.create(
      ["Legionella"],
      { teh: "the" },
      ["biofilm"],
      { alot: "a lot" }
    );
    expect(engine.correct("teh")).toBe("the");
    expect(engine.correct("alot")).toBe("a lot");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// correct() — word array adds to personal dictionary
// ─────────────────────────────────────────────────────────────────────────────

describe("SpellEngine.correct — personal word list", () => {
  test("word added via array treated as correctly spelled — passed through", () => {
    // With empty base dic, "Legionella" would have no suggestions.
    // After adding to personal, nspell.correct() returns true → passed through.
    const engine = SpellEngine.create(["Legionella"]);
    expect(engine.correct("Legionella")).toBe("Legionella");
  });

  test("multiple arrays — all words recognized", () => {
    const engine = SpellEngine.create(["biofilm"], ["alkalinity"]);
    expect(engine.correct("biofilm")).toBe("biofilm");
    expect(engine.correct("alkalinity")).toBe("alkalinity");
  });

  test("word NOT in personal with no suggestions — original kept", () => {
    const engine = SpellEngine.create();
    // "xyzzy" has no suggestions → original returned
    expect(engine.correct("xyzzy")).toBe("xyzzy");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// correct() — real JSON data files (sync, no English dictionary)
// ─────────────────────────────────────────────────────────────────────────────

describe("SpellEngine.correct — real JSON data (no full dictionary)", () => {
  test("corrections.json — teh → the", () => {
    const engine = SpellEngine.create(corrections);
    expect(engine.correct("teh")).toBe("the");
  });

  test("corrections.json — dont → don't", () => {
    const engine = SpellEngine.create(corrections);
    expect(engine.correct("dont")).toBe("don't");
  });

  test("corrections.json — legionella → Legionella", () => {
    const engine = SpellEngine.create(corrections);
    expect(engine.correct("legionella")).toBe("Legionella");
  });

  test("corrections.json — legionela → Legionella (single l)", () => {
    const engine = SpellEngine.create(corrections);
    expect(engine.correct("legionela")).toBe("Legionella");
  });

  test("corrections.json — ph → pH", () => {
    const engine = SpellEngine.create(corrections);
    expect(engine.correct("ph level")).toBe("pH level");
  });

  test("corrections.json — seperate → separate", () => {
    const engine = SpellEngine.create(corrections);
    expect(engine.correct("seperate")).toBe("separate");
  });

  test("corrections.json — alot → a lot", () => {
    const engine = SpellEngine.create(corrections);
    expect(engine.correct("alot")).toBe("a lot");
  });

  test("domainWords.json + corrections — Legionella recognized", () => {
    const engine = SpellEngine.create(domainWords, corrections);
    expect(engine.correct("Legionella")).toBe("Legionella");
    expect(engine.correct("legionella")).toBe("Legionella");
    expect(engine.correct("legionela")).toBe("Legionella");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Data file integrity
// ─────────────────────────────────────────────────────────────────────────────

describe("data file integrity", () => {
  test("corrections.json is a non-empty plain object", () => {
    expect(typeof corrections).toBe("object");
    expect(Array.isArray(corrections)).toBe(false);
    expect(Object.keys(corrections).length).toBeGreaterThan(0);
  });

  test("corrections.json all keys are lowercase", () => {
    for (const key of Object.keys(corrections)) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  test("corrections.json no empty keys or values", () => {
    for (const [k, v] of Object.entries(corrections)) {
      expect(k.length).toBeGreaterThan(0);
      expect(v.length).toBeGreaterThan(0);
    }
  });

  test("domainWords.json is a non-empty array", () => {
    expect(Array.isArray(domainWords)).toBe(true);
    expect(domainWords.length).toBeGreaterThan(0);
  });

  test("domainWords.json all entries are non-empty strings", () => {
    for (const word of domainWords) {
      expect(typeof word).toBe("string");
      expect(word.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SpellEngine.createEnglish — integration with real dictionary
// ─────────────────────────────────────────────────────────────────────────────

describe("SpellEngine.createEnglish", () => {
  test("returns a SpellEngine instance", async () => {
    expect(await SpellEngine.createEnglish()).toBeInstanceOf(SpellEngine);
  }, 10000);

  test("correctly spelled English word recognized", async () => {
    const engine = await SpellEngine.createEnglish();
    expect(engine.correct("water")).toBe("water");
  }, 10000);

  test("nspell suggestion — misspelled common word corrected", async () => {
    const engine = await SpellEngine.createEnglish();
    // nspell should suggest "quick" for "quikc"
    expect(engine.correct("quikc")).toBe("quick");
  }, 10000);

  test("real domainWords.json — Legionella recognized as correct", async () => {
    const engine = await SpellEngine.createEnglish(domainWords);
    expect(engine.correct("Legionella")).toBe("Legionella");
  }, 10000);

  test("real corrections.json — deterministic corrections applied", async () => {
    const engine = await SpellEngine.createEnglish(corrections);
    expect(engine.correct("teh")).toBe("the");
    expect(engine.correct("legionella")).toBe("Legionella");
    expect(engine.correct("legionela")).toBe("Legionella");
    expect(engine.correct("dont")).toBe("don't");
  }, 10000);

  test("domainWords + corrections together — full pipeline", async () => {
    const engine = await SpellEngine.createEnglish(domainWords, corrections);
    expect(engine.correct("Legionella")).toBe("Legionella");   // domain word → correct
    expect(engine.correct("legionella")).toBe("Legionella");   // correction → fixed
    expect(engine.correct("legionela")).toBe("Legionella");    // correction → fixed
    expect(engine.correct("teh quikc")).toBe("the quick");     // correction + nspell
    expect(engine.correct("corrison")).toBe("corrosion");      // correction → fixed
    expect(engine.correct("ph level")).toBe("pH level");       // correction → fixed
  }, 10000);

  test("no sources — no error", async () => {
    await expect(SpellEngine.createEnglish()).resolves.toBeInstanceOf(SpellEngine);
  }, 10000);
});

// ─────────────────────────────────────────────────────────────────────────────
// SpellEngine.create factory
// ─────────────────────────────────────────────────────────────────────────────

describe("SpellEngine.create", () => {
  test("returns a SpellEngine instance", () => {
    expect(SpellEngine.create()).toBeInstanceOf(SpellEngine);
  });

  test("equivalent to new SpellEngine(...sources)", () => {
    const a = new SpellEngine({ teh: "the" });
    const b = SpellEngine.create({ teh: "the" });
    expect(a.correct("teh")).toBe(b.correct("teh"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frozen export
// ─────────────────────────────────────────────────────────────────────────────

describe("SpellEngine — frozen export", () => {
  test("frozen — cannot add properties to export", () => {
    expect(() => { SpellEngine.foo = 1; }).toThrow();
  });

  test("named export matches default", () => {
    expect(SpellEngine.SpellEngine).toBe(SpellEngine);
  });

  test("SpellEngine.create attached", () => {
    expect(typeof SpellEngine.create).toBe("function");
  });

  test("SpellEngine.createEnglish attached", () => {
    expect(typeof SpellEngine.createEnglish).toBe("function");
  });
});