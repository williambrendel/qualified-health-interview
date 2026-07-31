"use strict";

const serializeQueryContext = require("../../src/xenova/serializeQueryContext");
const { FRUSTRATION_BUCKETS, frustrationLevel, buildIntents } = serializeQueryContext;

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal analyzer output for a single-intent technical query.
 * Use as a base; merge with overrides to test specific scenarios.
 */
const baseAnalysis = () => ({
  query: "what causes biofilm",
  corrected: "what causes biofilm",
  greeting: false,
  frustration: { score: 0.0 },
  segments: [
    { text: "what causes biofilm", classification: { label: "TECHNICAL" } },
  ],
});

const baseResult = (overrides = {}) => ({
  score: 0.612,
  documentId: "biocides|water_chemistry",
  range: [3331, 3631],
  sectionText: "Biofilm forms when microbes attach to surfaces.",
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// frustrationLevel
// ─────────────────────────────────────────────────────────────────────────────

describe("frustrationLevel — bucket boundaries", () => {
  /**
   * Buckets walked in descending threshold order. Score >= 0.8 →
   * very_frustrated; >= 0.5 → frustrated; >= 0.2 → mildly_frustrated;
   * < 0.2 → null (omit the line).
   *
   * Boundary tests pin the exact threshold semantics: 0.5 is
   * "frustrated" not "mildly_frustrated", 0.8 is "very_frustrated"
   * not "frustrated". This catches off-by-one errors in the
   * threshold comparisons.
   */
  test("score 0.85 → very_frustrated", () => {
    expect(frustrationLevel(0.85)).toBe("very_frustrated");
  });

  test("score exactly 0.8 → very_frustrated (boundary inclusive)", () => {
    expect(frustrationLevel(0.8)).toBe("very_frustrated");
  });

  test("score 0.79 → frustrated (just below high boundary)", () => {
    expect(frustrationLevel(0.79)).toBe("frustrated");
  });

  test("score 0.6 → frustrated", () => {
    expect(frustrationLevel(0.6)).toBe("frustrated");
  });

  test("score exactly 0.5 → frustrated (boundary inclusive)", () => {
    expect(frustrationLevel(0.5)).toBe("frustrated");
  });

  test("score 0.49 → mildly_frustrated (just below mid boundary)", () => {
    expect(frustrationLevel(0.49)).toBe("mildly_frustrated");
  });

  test("score 0.3 → mildly_frustrated", () => {
    expect(frustrationLevel(0.3)).toBe("mildly_frustrated");
  });

  test("score exactly 0.2 → mildly_frustrated (boundary inclusive)", () => {
    expect(frustrationLevel(0.2)).toBe("mildly_frustrated");
  });

  test("score 0.19 → null (just below lowest threshold)", () => {
    expect(frustrationLevel(0.19)).toBe(null);
  });

  test("score 0.0 → null", () => {
    expect(frustrationLevel(0.0)).toBe(null);
  });

  test("score exactly 1.0 → very_frustrated", () => {
    expect(frustrationLevel(1.0)).toBe("very_frustrated");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildIntents
// ─────────────────────────────────────────────────────────────────────────────

describe("buildIntents — intent assembly", () => {
  /**
   * Combines two sources: greeting flag → "GREETING", segment
   * classifications → their labels. Output is deduplicated, with
   * GREETING ordered first when present and other labels sorted
   * alphabetically.
   */

  test("single TECHNICAL segment, no greeting", () => {
    const result = buildIntents({
      greeting: false,
      segments: [{ classification: { label: "TECHNICAL" } }],
    });
    expect(result).toEqual(["TECHNICAL"]);
  });

  test("single SUPPORT segment", () => {
    const result = buildIntents({
      greeting: false,
      segments: [{ classification: { label: "SUPPORT" } }],
    });
    expect(result).toEqual(["SUPPORT"]);
  });

  test("greeting + TECHNICAL puts GREETING first", () => {
    const result = buildIntents({
      greeting: true,
      segments: [{ classification: { label: "TECHNICAL" } }],
    });
    expect(result).toEqual(["GREETING", "TECHNICAL"]);
  });

  test("multiple distinct intents, no greeting, alphabetical order", () => {
    const result = buildIntents({
      greeting: false,
      segments: [
        { classification: { label: "TECHNICAL" } },
        { classification: { label: "SUPPORT" } },
      ],
    });
    expect(result).toEqual(["SUPPORT", "TECHNICAL"]);
  });

  test("greeting + multiple intents: GREETING first, others sorted", () => {
    const result = buildIntents({
      greeting: true,
      segments: [
        { classification: { label: "TECHNICAL" } },
        { classification: { label: "CONVERSATIONAL" } },
        { classification: { label: "SUPPORT" } },
      ],
    });
    expect(result).toEqual(["GREETING", "CONVERSATIONAL", "SUPPORT", "TECHNICAL"]);
  });

  test("duplicate segment labels are deduplicated", () => {
    const result = buildIntents({
      greeting: false,
      segments: [
        { classification: { label: "TECHNICAL" } },
        { classification: { label: "TECHNICAL" } },
        { classification: { label: "TECHNICAL" } },
      ],
    });
    expect(result).toEqual(["TECHNICAL"]);
  });

  test("only greeting, no segments → just GREETING", () => {
    // This case shouldn't reach the serializer in practice
    // (greeting-only routes to runConversational), but the function
    // handles it cleanly anyway.
    const result = buildIntents({
      greeting: true,
      segments: [],
    });
    expect(result).toEqual(["GREETING"]);
  });

  test("missing segments array is treated as empty", () => {
    const result = buildIntents({
      greeting: true,
      // no segments field
    });
    expect(result).toEqual(["GREETING"]);
  });

  test("segments without classification are silently skipped", () => {
    // Defensive: malformed segments shouldn't crash the serializer.
    // The endpoint should never produce these, but if a bug
    // upstream sends us a segment missing its classification, we
    // skip it rather than throwing.
    const result = buildIntents({
      greeting: false,
      segments: [
        { classification: { label: "TECHNICAL" } },
        { /* no classification */ },
        { classification: { /* no label */ } },
        { classification: { label: "SUPPORT" } },
      ],
    });
    expect(result).toEqual(["SUPPORT", "TECHNICAL"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// serializeQueryContext — top-level output structure
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeQueryContext — minimal happy path", () => {
  /**
   * Smallest valid input: single intent, no frustration, one
   * result. Verifies the overall line structure: User query,
   * User intent, Results header, one row.
   */
  test("produces expected line structure", () => {
    const output = serializeQueryContext(baseAnalysis(), [baseResult()]);
    const expected = [
      "User query: what causes biofilm",
      "User intent: TECHNICAL",
      "Results:[1]{score,documentId,range:[start,end],sectionText}:",
      "- 0.612,biocides|water_chemistry,[3331,3631],Biofilm forms when microbes attach to surfaces.",
    ].join("\n");
    expect(output).toBe(expected);
  });

  test("Frustration line is OMITTED when score is below threshold", () => {
    const output = serializeQueryContext(baseAnalysis(), [baseResult()]);
    expect(output).not.toMatch(/Frustration:/);
  });

  test("User query uses analysis.corrected (with greeting), not query or raw", () => {
    // The LLM sees the spell-corrected form WITH the greeting still
    // attached. This lets the LLM independently verify the GREETING
    // flag in user_intent against the actual text. The cleaned
    // `analysis.query` (greeting peeled) is for retrieval use only,
    // not for the LLM prompt.
    const analysis = {
      ...baseAnalysis(),
      query:     "what causes biofilm",                    // post-peel
      corrected: "hello, what causes biofilm",              // pre-peel, the form we want
    };
    const output = serializeQueryContext(analysis, [baseResult()]);
    expect(output).toMatch(/^User query: hello, what causes biofilm$/m);
    // Sanity: the cleaned (post-peel) form should NOT appear as the
    // value of the User query line.
    expect(output).not.toMatch(/^User query: what causes biofilm$/m);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frustration line
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeQueryContext — frustration line", () => {
  /**
   * The Frustration line appears only when score >= 0.2. Format
   * is "Frustration: {score.toFixed(2)} ({level})". Two decimals
   * for the score keeps it concise — the LLM doesn't need 5
   * digits of precision on a tone signal.
   */

  test("emits 'Frustration: 0.30 (mildly_frustrated)' at low bucket", () => {
    const analysis = { ...baseAnalysis(), frustration: { score: 0.3 } };
    const output = serializeQueryContext(analysis, [baseResult()]);
    expect(output).toMatch(/Frustration: 0\.30 \(mildly_frustrated\)/);
  });

  test("emits 'Frustration: 0.65 (frustrated)' at mid bucket", () => {
    const analysis = { ...baseAnalysis(), frustration: { score: 0.65 } };
    const output = serializeQueryContext(analysis, [baseResult()]);
    expect(output).toMatch(/Frustration: 0\.65 \(frustrated\)/);
  });

  test("emits 'Frustration: 0.90 (very_frustrated)' at high bucket", () => {
    const analysis = { ...baseAnalysis(), frustration: { score: 0.9 } };
    const output = serializeQueryContext(analysis, [baseResult()]);
    expect(output).toMatch(/Frustration: 0\.90 \(very_frustrated\)/);
  });

  test("score 0.15 omits the line entirely", () => {
    const analysis = { ...baseAnalysis(), frustration: { score: 0.15 } };
    const output = serializeQueryContext(analysis, [baseResult()]);
    expect(output).not.toMatch(/Frustration:/);
  });

  test("missing frustration object treated as score 0 (line omitted)", () => {
    const analysis = { ...baseAnalysis() };
    delete analysis.frustration;
    const output = serializeQueryContext(analysis, [baseResult()]);
    expect(output).not.toMatch(/Frustration:/);
  });

  test("Frustration appears AFTER 'User query' and BEFORE 'User intent'", () => {
    const analysis = { ...baseAnalysis(), frustration: { score: 0.6 } };
    const output = serializeQueryContext(analysis, [baseResult()]);
    const lines = output.split("\n");
    expect(lines[0]).toMatch(/^User query: /);
    expect(lines[1]).toMatch(/^Frustration: /);
    expect(lines[2]).toMatch(/^User intent: /);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// User intent line
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeQueryContext — User intent line", () => {
  /**
   * Always present. Comma-separated, GREETING first (when peeled),
   * other labels alphabetical.
   */

  test("single intent → 'User intent: TECHNICAL'", () => {
    const output = serializeQueryContext(baseAnalysis(), [baseResult()]);
    expect(output).toMatch(/User intent: TECHNICAL$/m);
  });

  test("greeting + TECHNICAL → 'User intent: GREETING, TECHNICAL'", () => {
    const analysis = {
      ...baseAnalysis(),
      greeting: true,
    };
    const output = serializeQueryContext(analysis, [baseResult()]);
    expect(output).toMatch(/User intent: GREETING, TECHNICAL$/m);
  });

  test("multiple distinct intents → comma-separated", () => {
    const analysis = {
      ...baseAnalysis(),
      segments: [
        { classification: { label: "TECHNICAL" } },
        { classification: { label: "SUPPORT" } },
      ],
    };
    const output = serializeQueryContext(analysis, [baseResult()]);
    expect(output).toMatch(/User intent: SUPPORT, TECHNICAL$/m);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Results section
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeQueryContext — results section", () => {
  /**
   * Results header has the form `Results:[N]{schema}:` where N is
   * the count and `schema` is the column list. Rows are bulleted
   * with `- `, comma-delimited, range bracketed, sectionText is
   * trailing.
   */

  test("Results header shows count and column schema", () => {
    const output = serializeQueryContext(baseAnalysis(), [baseResult(), baseResult()]);
    expect(output).toMatch(/Results:\[2\]\{score,documentId,range:\[start,end\],sectionText\}:/);
  });

  test("each row is bulleted with '- '", () => {
    const output = serializeQueryContext(baseAnalysis(), [baseResult(), baseResult()]);
    const rows = output.split("\n").filter((line) => line.startsWith("- "));
    expect(rows.length).toBe(2);
  });

  test("score formatted with 3 decimal places", () => {
    const output = serializeQueryContext(baseAnalysis(), [
      baseResult({ score: 0.6122398 }),
    ]);
    expect(output).toMatch(/- 0\.612,/);
  });

  test("score formatted even when value is exactly 1.0", () => {
    const output = serializeQueryContext(baseAnalysis(), [
      baseResult({ score: 1.0 }),
    ]);
    expect(output).toMatch(/- 1\.000,/);
  });

  test("documentId is emitted verbatim including pipe characters", () => {
    // Pipes appear in documentId because of how IDs are formed
    // from document slug + section slug. The serializer doesn't
    // escape them — they survive because commas (not pipes)
    // delimit the columns.
    const output = serializeQueryContext(baseAnalysis(), [
      baseResult({ documentId: "biocides_and_chemical_treatment|causes_of_resistance" }),
    ]);
    expect(output).toMatch(/biocides_and_chemical_treatment\|causes_of_resistance/);
  });

  test("range is bracketed with no internal whitespace", () => {
    const output = serializeQueryContext(baseAnalysis(), [
      baseResult({ range: [123, 4567] }),
    ]);
    expect(output).toMatch(/\[123,4567\]/);
  });

  test("sectionText preserves commas as text (not field delimiters)", () => {
    // SectionText is the trailing field — anything after the third
    // comma is part of the text. The LLM is told this in the
    // prompt. The serializer doesn't escape commas inside the text.
    const output = serializeQueryContext(baseAnalysis(), [
      baseResult({ sectionText: "Biofilm forms in warm, stagnant water." }),
    ]);
    expect(output).toMatch(/Biofilm forms in warm, stagnant water\./);
  });

  test("sectionText with embedded newlines collapses to spaces", () => {
    // Newlines inside sectionText would break line-based parsing
    // — each row must be on its own line. The serializer flattens
    // any whitespace run (including newlines and tabs) to a
    // single space.
    const output = serializeQueryContext(baseAnalysis(), [
      baseResult({ sectionText: "Line one.\nLine two.\n  Line three." }),
    ]);
    expect(output).toMatch(/Line one\. Line two\. Line three\./);
    // Verify no newlines inside the bulleted row.
    const row = output.split("\n").find((l) => l.startsWith("- "));
    expect(row).not.toMatch(/\n/);
  });

  test("sectionText with multiple consecutive spaces is collapsed", () => {
    const output = serializeQueryContext(baseAnalysis(), [
      baseResult({ sectionText: "Many   spaces    here" }),
    ]);
    expect(output).toMatch(/Many spaces here/);
  });

  test("sectionText is trimmed of leading/trailing whitespace", () => {
    const output = serializeQueryContext(baseAnalysis(), [
      baseResult({ sectionText: "   trimmed   " }),
    ]);
    // The row format ends with `,trimmed` — no trailing space.
    expect(output).toMatch(/,trimmed$/m);
  });

  test("empty results emits header with count [0] and no rows", () => {
    // Endpoints should route empty-result cases away from the
    // second-pass LLM, but if we ever do call this with an empty
    // list, it shouldn't crash. The header still emits with count 0.
    const output = serializeQueryContext(baseAnalysis(), []);
    expect(output).toMatch(/Results:\[0\]/);
    const rows = output.split("\n").filter((l) => l.startsWith("- "));
    expect(rows).toEqual([]);
  });

  test("multiple results are emitted in input order (no sorting)", () => {
    // The serializer expects pre-sorted input and does not reorder.
    // If callers pass results in score-descending order, that order
    // is preserved.
    const output = serializeQueryContext(baseAnalysis(), [
      baseResult({ score: 0.8, sectionText: "first" }),
      baseResult({ score: 0.6, sectionText: "second" }),
      baseResult({ score: 0.4, sectionText: "third" }),
    ]);
    const rows = output.split("\n").filter((l) => l.startsWith("- "));
    expect(rows[0]).toMatch(/first$/);
    expect(rows[1]).toMatch(/second$/);
    expect(rows[2]).toMatch(/third$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeQueryContext — realistic scenarios", () => {
  /**
   * End-to-end examples that match what the analyzer would actually
   * produce. These doubled as sanity checks during development:
   * the output should be plausibly parseable by a reasoning LLM
   * without ambiguity.
   */

  test("frustrated multi-intent query with greeting", () => {
    const analysis = {
      query: "biofilm won't go away and i need help",
      corrected: "hi, biofilm won't go away and i need help",
      greeting: true,
      frustration: { score: 0.65 },
      segments: [
        { text: "biofilm won't go away", classification: { label: "TECHNICAL" } },
        { text: "i need help", classification: { label: "SUPPORT" } },
      ],
    };
    const results = [
      baseResult({
        score: 0.612,
        sectionText: "Biofilm protection: the matrix acts as both a physical barrier and chemical buffer.",
      }),
      baseResult({
        score: 0.587,
        range: [4538, 5066],
        sectionText: "For hands-on support, contact your water treatment provider.",
      }),
    ];
    const output = serializeQueryContext(analysis, results);

    expect(output).toMatch(/^User query: hi, biofilm won't go away and i need help$/m);
    expect(output).toMatch(/^Frustration: 0\.65 \(frustrated\)$/m);
    expect(output).toMatch(/^User intent: GREETING, SUPPORT, TECHNICAL$/m);
    expect(output).toMatch(/Results:\[2\]/);
  });

  test("calm single-intent query, no greeting, single result", () => {
    const analysis = baseAnalysis();
    const output = serializeQueryContext(analysis, [baseResult()]);
    const lines = output.split("\n");
    // Order should be: query, intent (no frustration), results header, row
    expect(lines[0]).toMatch(/^User query: /);
    expect(lines[1]).toMatch(/^User intent: /);
    expect(lines[2]).toMatch(/^Results:/);
    expect(lines[3]).toMatch(/^- /);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export
// ─────────────────────────────────────────────────────────────────────────────

describe("serializeQueryContext — module export", () => {
  test("module is the function itself", () => {
    expect(typeof serializeQueryContext).toBe("function");
  });

  test("module is frozen", () => {
    expect(Object.isFrozen(serializeQueryContext)).toBe(true);
  });

  test("self-referential .serializeQueryContext property", () => {
    expect(serializeQueryContext.serializeQueryContext).toBe(serializeQueryContext);
  });

  test("exposes FRUSTRATION_BUCKETS", () => {
    expect(Array.isArray(FRUSTRATION_BUCKETS)).toBe(true);
    expect(FRUSTRATION_BUCKETS.length).toBe(4);
  });

  test("FRUSTRATION_BUCKETS is frozen", () => {
    expect(Object.isFrozen(FRUSTRATION_BUCKETS)).toBe(true);
  });

  test("exposes frustrationLevel helper", () => {
    expect(typeof frustrationLevel).toBe("function");
  });

  test("exposes buildIntents helper", () => {
    expect(typeof buildIntents).toBe("function");
  });
});
