"use strict";

/**
 * @file detectFrustration.test.js
 * @brief Unit tests for the frustration-signal detector (v4).
 *
 * v4: repeated punctuation scoring is driven by EXCESS CHARACTER COUNT,
 * not run count. Run counts preserved as diagnostic + back-compat
 * fields. All other v2/v3 behavior preserved.
 */

const detectFrustration = require("../../../src/xenova/buildAnalyzeQuery/detectFrustration");

// ─────────────────────────────────────────────────────────────────────────────
// Shouting signal (gradient)
// ─────────────────────────────────────────────────────────────────────────────

describe("detectFrustration — shouting (gradient)", () => {
  test("ALL CAPS query → shouting=true, allCaps=true", () => {
    const r = detectFrustration("THIS IS BROKEN");
    expect(r.shouting).toBe(true);
    expect(r.allCaps).toBe(true);
  });

  test("lowercase → shouting=false", () => {
    const r = detectFrustration("this is fine");
    expect(r.shouting).toBe(false);
    expect(r.allCaps).toBe(false);
  });

  test("short ALL CAPS (≤3 alpha chars) → allCaps=true but shouting=false", () => {
    const r = detectFrustration("PH");
    expect(r.allCaps).toBe(true);
    expect(r.shouting).toBe(false);
  });

  test("mixed case under threshold → shouting=false", () => {
    const r = detectFrustration("This Is Mixed Case");
    expect(r.shouting).toBe(false);
  });

  test("majority uppercase passes threshold", () => {
    const r = detectFrustration("HELP");
    expect(r.shouting).toBe(true);
    expect(r.contributions.shouting).toBeCloseTo(detectFrustration.WEIGHTS.shouting, 5);
  });

  test("queries with no letters → shouting=false", () => {
    const r = detectFrustration("123 456");
    expect(r.shouting).toBe(false);
    expect(r.allCaps).toBe(false);
  });

  test("gradient: ~50% caps → partial shouting contribution", () => {
    const r = detectFrustration("HELLO WORLD this is calm");
    expect(r.shouting).toBe(true);
    expect(r.contributions.shouting).toBeGreaterThan(0);
    expect(r.contributions.shouting).toBeLessThan(detectFrustration.WEIGHTS.shouting);
  });

  test("allCaps vs shouting distinction", () => {
    const long = detectFrustration("EVERYTHING IS BROKEN HERE");
    expect(long.allCaps).toBe(true);
    expect(long.shouting).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Repeated punctuation — run counting (back-compat)
// ─────────────────────────────────────────────────────────────────────────────

describe("detectFrustration — repeated punctuation: run counting (back-compat)", () => {
  test("single ! or ? not counted as a run", () => {
    expect(detectFrustration("hello!").repeatedPunctCount).toBe(0);
    expect(detectFrustration("really?").repeatedPunctCount).toBe(0);
  });

  test("'!!!' → one exclamation run", () => {
    const r = detectFrustration("thanks!!!");
    expect(r.repeatedPunctCount).toBe(1);
    expect(r.repeatedPunctByType).toEqual({
      exclamation: 1, question: 0, mixed: 0, total: 1,
    });
  });

  test("'???' → one question run", () => {
    const r = detectFrustration("why???");
    expect(r.repeatedPunctByType).toEqual({
      exclamation: 0, question: 1, mixed: 0, total: 1,
    });
  });

  test("'!!! ???' → one exclamation + one question run (space separates)", () => {
    const r = detectFrustration("help!!! why???");
    expect(r.repeatedPunctByType).toEqual({
      exclamation: 1, question: 1, mixed: 0, total: 2,
    });
  });

  test("adjacent '??!!' → one mixed run", () => {
    // No whitespace between → regex sees one continuous run.
    const r = detectFrustration("hello??!!");
    expect(r.repeatedPunctByType).toEqual({
      exclamation: 0, question: 0, mixed: 1, total: 1,
    });
  });

  test("'!?!?' → one mixed run", () => {
    const r = detectFrustration("seriously!?!?");
    expect(r.repeatedPunctByType.mixed).toBe(1);
  });

  test("no punctuation → 0 across the board", () => {
    const r = detectFrustration("what is pH");
    expect(r.repeatedPunctCount).toBe(0);
    expect(r.repeatedPunctByType).toEqual({
      exclamation: 0, question: 0, mixed: 0, total: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Repeated punctuation — excess char counting (NEW in v4)
// ─────────────────────────────────────────────────────────────────────────────

describe("detectFrustration — repeated punctuation: excess char counting (v4)", () => {
  test("single mark → 0 excess", () => {
    expect(detectFrustration("hello!").repeatedPunctExcess.total).toBe(0);
    expect(detectFrustration("really?").repeatedPunctExcess.total).toBe(0);
  });

  test("'!!' → 1 excess", () => {
    const r = detectFrustration("hello!!");
    expect(r.repeatedPunctExcess).toEqual({
      exclamation: 1, question: 0, mixed: 0, total: 1,
    });
  });

  test("'!!!' → 2 excess", () => {
    const r = detectFrustration("hello!!!");
    expect(r.repeatedPunctExcess.exclamation).toBe(2);
    expect(r.repeatedPunctExcess.total).toBe(2);
  });

  test("'!!!!!!' → 5 excess (caps the signal)", () => {
    const r = detectFrustration("hello!!!!!!");
    expect(r.repeatedPunctExcess.exclamation).toBe(5);
    expect(r.repeatedPunctExcess.total).toBe(5);
  });

  test("longer keymash beyond cap → excess counted, but contribution capped", () => {
    // "hello!!!!!!!!!!!!!" — 13 ! chars → 12 excess. Stored as 12,
    // but the score uses Math.min(1, 12 / cap=5) = 1.0.
    const r = detectFrustration("hello!!!!!!!!!!!!!!");
    expect(r.repeatedPunctExcess.exclamation).toBe(13);
    expect(r.contributions.repeatedPunct).toBeCloseTo(detectFrustration.WEIGHTS.repeatedPunct, 5);
  });

  test("'???' → 2 excess in question bucket", () => {
    const r = detectFrustration("why???");
    expect(r.repeatedPunctExcess).toEqual({
      exclamation: 0, question: 2, mixed: 0, total: 2,
    });
  });

  test("mixed run '??!!!!!!' (8 chars) → 7 excess in mixed bucket", () => {
    const r = detectFrustration("hello??!!!!!!");
    expect(r.repeatedPunctExcess.mixed).toBe(7);
    expect(r.repeatedPunctExcess.exclamation).toBe(0);
    expect(r.repeatedPunctExcess.question).toBe(0);
  });

  test("multiple runs sum their excess", () => {
    // "!!! ??? !!" → 2 + 2 + 1 = 5 excess
    const r = detectFrustration("a!!! b??? c!!");
    expect(r.repeatedPunctExcess.exclamation).toBe(3);  // !!! + !! → 2 + 1 = 3
    expect(r.repeatedPunctExcess.question).toBe(2);     // ???     → 2
    expect(r.repeatedPunctExcess.total).toBe(5);
  });

  test("effective excess weights ? at 0.5 and ! at 1.0", () => {
    // 4 excess in ? → 4 × 0.5 = 2.0 effective
    const q = detectFrustration("really????");
    expect(q.repeatedPunctEffectiveExcess).toBeCloseTo(1.5, 5);

    // 4 excess in ! → 4 × 1.0 = 4.0 effective
    const e = detectFrustration("really!!!!!");
    expect(e.repeatedPunctEffectiveExcess).toBeCloseTo(4, 5);
  });

  test("mixed bucket treated as full weight (like exclamation)", () => {
    const r = detectFrustration("hello!?!?!?");
    expect(r.repeatedPunctEffectiveExcess).toBeCloseTo(r.repeatedPunctExcess.mixed, 5);
  });

  test("score scales with intensity", () => {
    const mild   = detectFrustration("hello!!");      // 1 excess
    const medium = detectFrustration("hello!!!!");    // 3 excess
    const max    = detectFrustration("hello!!!!!!"); // 5 excess (cap)
    const beyond = detectFrustration("hello!!!!!!!!!!"); // 9 excess (over cap)

    expect(mild.score).toBeLessThan(medium.score);
    expect(medium.score).toBeLessThan(max.score);
    // At and beyond cap, contribution is identical.
    expect(max.contributions.repeatedPunct).toBeCloseTo(beyond.contributions.repeatedPunct, 5);
  });

  test("question excess needs twice as many chars to hit cap", () => {
    // 5 excess ? at 0.5 weight = 2.5 effective (half of cap=5)
    const halfCap = detectFrustration("hmm??????");  // 5 excess ?
    // 10 excess ? at 0.5 = 5.0 effective (full cap)
    const fullCap = detectFrustration("hmm???????????");  // 11 ? → 10 excess

    expect(halfCap.contributions.repeatedPunct)
      .toBeLessThan(fullCap.contributions.repeatedPunct);
    expect(fullCap.contributions.repeatedPunct)
      .toBeCloseTo(detectFrustration.WEIGHTS.repeatedPunct, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Urgent keywords signal (expanded vocabulary)
// ─────────────────────────────────────────────────────────────────────────────

describe("detectFrustration — urgent keywords (expanded vocabulary)", () => {
  test("'urgent' matches", () => {
    expect(detectFrustration("this is urgent").urgentKeywords).toContain("urgent");
  });

  test("'asap' matches", () => {
    expect(detectFrustration("need help asap").urgentKeywords).toContain("asap");
  });

  test("'broken' matches", () => {
    expect(detectFrustration("the system is broken").urgentKeywords).toContain("broken");
  });

  test("multi-word phrase 'not working' matches as a phrase", () => {
    expect(detectFrustration("this is not working").urgentKeywords).toContain("not working");
  });

  test("'doesn't work' matches", () => {
    expect(detectFrustration("the valve doesn't work").urgentKeywords).toContain("doesn't work");
  });

  test("case-insensitive matching", () => {
    expect(detectFrustration("URGENT request").urgentKeywords).toContain("urgent");
  });

  test("no urgent words → empty array", () => {
    expect(detectFrustration("what is pH").urgentKeywords).toEqual([]);
  });

  test("'now' inside another word does NOT match", () => {
    expect(detectFrustration("I need knowledge").urgentKeywords).toEqual([]);
  });

  test("v4: 'help' matches as urgent keyword", () => {
    expect(detectFrustration("I need help").urgentKeywords).toContain("help");
  });

  test("v4: longer phrase wins when overlapping", () => {
    // "please help me" matches the PHRASE "please help" (longer phrase
    // wins; "help" and "help me" are skipped due to overlap).
    const r = detectFrustration("please help me");
    expect(r.urgentKeywords).toContain("please help");
    const overlaps = r.urgentKeywords.filter(kw => kw === "help" || kw === "help me");
    expect(overlaps).toEqual([]);
  });

  test("v4: 'emergency' matches", () => {
    expect(detectFrustration("this is an emergency").urgentKeywords).toContain("emergency");
  });

  test("v4: 'stuck' matches", () => {
    expect(detectFrustration("I'm stuck").urgentKeywords).toContain("stuck");
  });

  test("v4: 'panic' matches", () => {
    expect(detectFrustration("starting to panic").urgentKeywords).toContain("panic");
  });

  test("v4: 'right now' matches as a phrase", () => {
    expect(detectFrustration("need this right now").urgentKeywords).toContain("right now");
  });

  test("multiple distinct urgent keywords accumulate", () => {
    const r = detectFrustration("urgent! broken now!");
    expect(r.urgentKeywords.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profanity signal (tiered)
// ─────────────────────────────────────────────────────────────────────────────

describe("detectFrustration — profanity (tiered)", () => {
  test("'damn' detected as light", () => {
    const r = detectFrustration("this damn thing");
    expect(r.profanity).toBe(true);
    expect(r.profanityTier).toBe("light");
  });

  test("'hell' detected as light", () => {
    const r = detectFrustration("what the hell");
    expect(r.profanityTier).toBe("light");
  });

  test("'crap' detected as light", () => {
    const r = detectFrustration("oh crap");
    expect(r.profanityTier).toBe("light");
  });

  test("'fuck' detected as heavy", () => {
    const r = detectFrustration("what the fuck");
    expect(r.profanity).toBe(true);
    expect(r.profanityTier).toBe("heavy");
  });

  test("'shit' detected as heavy", () => {
    const r = detectFrustration("oh shit");
    expect(r.profanityTier).toBe("heavy");
  });

  test("'wtf' detected as heavy", () => {
    const r = detectFrustration("wtf is happening");
    expect(r.profanityTier).toBe("heavy");
  });

  test("case-insensitive heavy match", () => {
    expect(detectFrustration("WTF system").profanityTier).toBe("heavy");
  });

  test("heavy beats light when both present", () => {
    const r = detectFrustration("damn it fucking thing");
    expect(r.profanityTier).toBe("heavy");
  });

  test("no profanity → null tier", () => {
    const r = detectFrustration("what is pH");
    expect(r.profanity).toBe(false);
    expect(r.profanityTier).toBeNull();
  });

  test("light profanity contributes less than heavy", () => {
    const light = detectFrustration("damn it");
    const heavy = detectFrustration("fuck it");
    expect(light.contributions.profanity)
      .toBeLessThan(heavy.contributions.profanity);
    expect(light.contributions.profanity)
      .toBeCloseTo(
        detectFrustration.WEIGHTS.profanity * detectFrustration.PROFANITY_LIGHT_MULTIPLIER,
        5
      );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Heavy-profanity floor
// ─────────────────────────────────────────────────────────────────────────────

describe("detectFrustration — heavy-profanity floor", () => {
  test("'wtf' alone reaches frustrated band via floor", () => {
    const r = detectFrustration("wtf");
    expect(r.score).toBeGreaterThanOrEqual(detectFrustration.PROFANITY_HEAVY_FLOOR);
    expect(r.floorApplied).toBe(true);
  });

  test("'fuck' alone reaches frustrated band", () => {
    const r = detectFrustration("fuck");
    expect(r.score).toBeGreaterThanOrEqual(detectFrustration.PROFANITY_HEAVY_FLOOR);
  });

  test("light profanity alone does NOT trigger floor", () => {
    const r = detectFrustration("damn");
    expect(r.floorApplied).toBe(false);
    expect(r.score).toBeLessThan(detectFrustration.PROFANITY_HEAVY_FLOOR);
  });

  test("no profanity → no floor applied", () => {
    const r = detectFrustration("what is pH");
    expect(r.floorApplied).toBe(false);
  });

  test("floor only lifts, never lowers — high-scoring query stays high", () => {
    const r = detectFrustration("FUCK THIS IS BROKEN NOW HELP!!! NOT WORKING!!!");
    expect(r.score).toBeGreaterThan(detectFrustration.PROFANITY_HEAVY_FLOOR);
    expect(r.floorApplied).toBe(false);  // sum was already > floor
  });

  test("floor applied for heavy + tiny secondary signals", () => {
    // "wtf?" — heavy profanity + single ? (no run). Sum = 0.4; floor lifts to 0.5.
    const r = detectFrustration("wtf?");
    expect(r.floorApplied).toBe(true);
    expect(r.score).toBe(detectFrustration.PROFANITY_HEAVY_FLOOR);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Composite score
// ─────────────────────────────────────────────────────────────────────────────

describe("detectFrustration — composite score", () => {
  test("neutral query → score 0", () => {
    expect(detectFrustration("what is pH?").score).toBe(0);
  });

  test("only shouting (full ratio) → equals shouting weight", () => {
    const r = detectFrustration("HELLO WORLD");
    expect(r.score).toBeCloseTo(detectFrustration.WEIGHTS.shouting, 1);
  });

  test("'hello!!' (1 excess !) → ~0.04", () => {
    // 1 excess × 1.0 weight = 1 effective / cap 5 = 0.2 → 0.2 × 0.2 weight = 0.04
    const r = detectFrustration("hello!!");
    expect(r.score).toBeGreaterThan(0.02);
    expect(r.score).toBeLessThan(0.08);
  });

  test("'hello!!!!!!' (5 excess !) → ~0.20 (maxes punct signal)", () => {
    const r = detectFrustration("hello!!!!!!");
    expect(r.contributions.repeatedPunct).toBeCloseTo(detectFrustration.WEIGHTS.repeatedPunct, 5);
  });

  test("'why??' (1 excess ?) → ~0.02 (half weight)", () => {
    const r = detectFrustration("why??");
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(0.04);
  });

  test("intensity matters: more chars in a run → higher score", () => {
    const short = detectFrustration("hello!!");
    const long  = detectFrustration("hello!!!!!");
    expect(short.score).toBeLessThan(long.score);
  });

  test("only one urgent keyword (non-help) → ~0.125", () => {
    const r = detectFrustration("need it asap");
    expect(r.score).toBeGreaterThan(0.10);
    expect(r.score).toBeLessThan(0.15);
  });

  test("only light profanity → ~0.24", () => {
    const r = detectFrustration("this damn thing");
    expect(r.score).toBeCloseTo(0.24, 2);
  });

  test("heavy profanity → at least the floor (~0.5)", () => {
    const r = detectFrustration("what the fuck");
    expect(r.score).toBeGreaterThanOrEqual(detectFrustration.PROFANITY_HEAVY_FLOOR);
  });

  test("v4 reference: 'WTF HELP ME!!! green slime!!!' scores in frustrated+ band", () => {
    // Heavy (0.4) + help-me (0.125) + 2 ! runs (3 excess total → 3/5 = 0.6 → 0.12)
    // ≈ 0.645
    const r = detectFrustration("WTF HELP ME!!! green slime!!!");
    expect(r.score).toBeGreaterThan(0.55);
  });

  test("v4 reference: 'WTF?????!!!!!! HELP ME!!! green slime!!!' scores higher", () => {
    // Same components but the WTF run is much longer — mixed run with
    // ~10 excess chars caps the punct signal at 0.20.
    const r = detectFrustration("WTF?????!!!!!! HELP ME!!! green slime!!!");
    expect(r.score).toBeGreaterThan(0.7);
  });

  test("score is clamped at 1", () => {
    const r = detectFrustration("THIS DAMN FUCKING BROKEN URGENT ASAP NOW!!! ??? !!!");
    expect(r.score).toBeLessThanOrEqual(1);
  });

  test("score is at least 0", () => {
    expect(detectFrustration("").score).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contributions object
// ─────────────────────────────────────────────────────────────────────────────

describe("detectFrustration — contributions (diagnostic)", () => {
  test("contributions are returned for every signal", () => {
    const r = detectFrustration("anything");
    expect(r.contributions).toHaveProperty("shouting");
    expect(r.contributions).toHaveProperty("repeatedPunct");
    expect(r.contributions).toHaveProperty("urgentKeywords");
    expect(r.contributions).toHaveProperty("profanity");
  });

  test("contributions are zero for empty input", () => {
    const r = detectFrustration("");
    expect(r.contributions).toEqual({
      shouting: 0, repeatedPunct: 0, urgentKeywords: 0, profanity: 0,
    });
  });

  test("contributions sum to raw score (when floor not applied)", () => {
    const r = detectFrustration("help asap broken!!!");
    expect(r.floorApplied).toBe(false);
    const sum =
      r.contributions.shouting +
      r.contributions.repeatedPunct +
      r.contributions.urgentKeywords +
      r.contributions.profanity;
    expect(r.score).toBeCloseTo(Math.min(1, sum), 5);
  });

  test("each individual contribution is bounded by its weight", () => {
    const r = detectFrustration("URGENT ASAP BROKEN HELP!!! ???");
    expect(r.contributions.shouting)
      .toBeLessThanOrEqual(detectFrustration.WEIGHTS.shouting);
    expect(r.contributions.repeatedPunct)
      .toBeLessThanOrEqual(detectFrustration.WEIGHTS.repeatedPunct);
    expect(r.contributions.urgentKeywords)
      .toBeLessThanOrEqual(detectFrustration.WEIGHTS.urgentKeywords);
    expect(r.contributions.profanity)
      .toBeLessThanOrEqual(detectFrustration.WEIGHTS.profanity);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge inputs
// ─────────────────────────────────────────────────────────────────────────────

describe("detectFrustration — edge inputs", () => {
  test("empty string → all signals false / empty / 0", () => {
    const r = detectFrustration("");
    expect(r.score).toBe(0);
    expect(r.shouting).toBe(false);
    expect(r.allCaps).toBe(false);
    expect(r.repeatedPunctCount).toBe(0);
    expect(r.repeatedPunctExcess.total).toBe(0);
    expect(r.repeatedPunctEffectiveExcess).toBe(0);
    expect(r.urgentKeywords).toEqual([]);
    expect(r.profanity).toBe(false);
    expect(r.profanityTier).toBeNull();
    expect(r.floorApplied).toBe(false);
  });

  test("null input → safe defaults", () => {
    const r = detectFrustration(null);
    expect(r.score).toBe(0);
    expect(r.shouting).toBe(false);
  });

  test("undefined input → safe defaults", () => {
    const r = detectFrustration(undefined);
    expect(r.score).toBe(0);
  });

  test("whitespace-only → safe defaults", () => {
    const r = detectFrustration("   ");
    expect(r.score).toBe(0);
  });

  test("single character → no signals", () => {
    expect(detectFrustration("?").repeatedPunctCount).toBe(0);
    expect(detectFrustration("!").repeatedPunctCount).toBe(0);
    expect(detectFrustration("?").repeatedPunctExcess.total).toBe(0);
    expect(detectFrustration("!").repeatedPunctExcess.total).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Module export shape
// ─────────────────────────────────────────────────────────────────────────────

describe("detectFrustration — module export", () => {
  test("module is frozen", () => {
    expect(Object.isFrozen(detectFrustration)).toBe(true);
  });

  test("self-referential property", () => {
    expect(detectFrustration.detectFrustration).toBe(detectFrustration);
  });

  test("exposes tuning constants", () => {
    expect(detectFrustration.WEIGHTS).toBeDefined();
    expect(detectFrustration.REPEATED_PUNCT_WEIGHTS).toBeDefined();
    expect(detectFrustration.SHOUTING_RATIO_START).toBe(0.4);
    expect(detectFrustration.SHOUTING_RATIO_FULL).toBe(0.7);
    expect(detectFrustration.REPEATED_PUNCT_EXCESS_CAP).toBe(5);
    expect(detectFrustration.URGENT_KEYWORDS_CAP).toBe(2);
    expect(detectFrustration.PROFANITY_LIGHT_MULTIPLIER).toBe(0.6);
    expect(detectFrustration.PROFANITY_HEAVY_FLOOR).toBe(0.5);
  });

  test("exposes vocabulary arrays", () => {
    expect(detectFrustration.URGENT_KEYWORDS).toContain("help");
    expect(detectFrustration.URGENT_KEYWORDS).toContain("emergency");
    expect(detectFrustration.PROFANITY_HEAVY).toContain("fuck");
    expect(detectFrustration.PROFANITY_HEAVY).toContain("wtf");
    expect(detectFrustration.PROFANITY_LIGHT).toContain("damn");
  });
});