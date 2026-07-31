"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { verifyHypothesis } = require("./verify");
const { generateHypothesis, applicableRules } = require("./index");

const RULES = {
  hypernatremia: { loinc: "2951-2", direction: "high", statement: "Elevated sodium reflects a free-water deficit.", url: "https://example.org/na" },
  hyponatremia: { loinc: "2951-2", direction: "low", statement: "Low sodium is often dilutional.", url: "https://example.org/na2" },
};

function sodiumTicket() {
  return {
    id: "AR-RES1",
    severity: "critical",
    provenance: { loinc: "2951-2", result_id: "RES1", source: "order_results.csv" },
    facts: {
      component: "Sodium", value: 178.593, unit: "mEq/L", direction: "high",
      reference: { low: 136, high: 145 }, outOfRangeBy: 33.593, beyondCritical: true,
      criticalBounds: { low: 120, high: 160 },
    },
  };
}

const goodParsed = {
  assessment: "Markedly elevated sodium, consistent with a free-water deficit such as dehydration.",
  plan: "Consider reviewing volume status and free-water intake, and repeat to confirm.",
  citations: { facts: ["value", "direction", "beyond_critical"], rule: "hypernatremia" },
};

test("verify: admits a well-formed, fully-sourced hypothesis", () => {
  const v = verifyHypothesis(sodiumTicket(), goodParsed, { rules: RULES });
  assert.equal(v.admissible, true, v.reasons.join("; "));
  assert.equal(v.hypothesis.cites.rule.id, "hypernatremia");
  assert.equal(v.hypothesis.cites.rule.url, "https://example.org/na");
  assert.equal(v.hypothesis.cites.facts.length, 3);
});

test("verify: tolerates 'key: value' citation format (normalizes to the key)", () => {
  const parsed = {
    ...goodParsed,
    citations: { facts: ["component: Sodium", "value: 178.593", "beyond_critical: true"], rule: "hypernatremia" },
  };
  const v = verifyHypothesis(sodiumTicket(), parsed, { rules: RULES });
  assert.equal(v.admissible, true, v.reasons.join("; "));
  assert.deepEqual(v.hypothesis.cites.facts.map((f) => f.key).sort(), ["beyond_critical", "component", "value"]);
});

test("verify: rejects an unknown rule id", () => {
  const v = verifyHypothesis(sodiumTicket(), { ...goodParsed, citations: { facts: ["value"], rule: "made_up" } }, { rules: RULES });
  assert.equal(v.admissible, false);
  assert.ok(v.reasons.some((r) => r.includes("made_up")));
});

test("verify: rejects a rule that does not apply to this finding", () => {
  // hyponatremia is direction:low, but this finding is high
  const v = verifyHypothesis(sodiumTicket(), { ...goodParsed, citations: { facts: ["value"], rule: "hyponatremia" } }, { rules: RULES });
  assert.equal(v.admissible, false);
  assert.ok(v.reasons.some((r) => r.includes("does not apply")));
});

test("verify: rejects when NO valid fact is cited (only a bogus label)", () => {
  const v = verifyHypothesis(sodiumTicket(), { ...goodParsed, citations: { facts: ["blood_type"], rule: "hypernatremia" } }, { rules: RULES });
  assert.equal(v.admissible, false);
  assert.ok(v.reasons.some((r) => r.includes("no valid facts")));
});

test("verify: drops a mislabeled fact but keeps a hypothesis that also cites a real fact", () => {
  // Model cites the test name AND a real fact key — the bogus label is cosmetic, dropped.
  const v = verifyHypothesis(sodiumTicket(), { ...goodParsed, citations: { facts: ["Sodium", "value", "direction"], rule: "hypernatremia" } }, { rules: RULES });
  assert.equal(v.admissible, true, v.reasons.join("; "));
  assert.deepEqual(v.hypothesis.cites.facts.map((f) => f.key).sort(), ["direction", "value"]);
});

test("verify: rejects a URL in the text", () => {
  const v = verifyHypothesis(sodiumTicket(), { ...goodParsed, assessment: "See https://sketchy.example for details." }, { rules: RULES });
  assert.equal(v.admissible, false);
  assert.ok(v.reasons.some((r) => r.toLowerCase().includes("url")));
});

test("verify: rejects an emitted decimal value", () => {
  const v = verifyHypothesis(sodiumTicket(), { ...goodParsed, assessment: "Sodium of 178.593 is dangerously high." }, { rules: RULES });
  assert.equal(v.admissible, false);
  assert.ok(v.reasons.some((r) => r.includes("decimal")));
});

test("verify: rejects an integer that restates a sourced value", () => {
  const v = verifyHypothesis(sodiumTicket(), { ...goodParsed, plan: "Address the sodium of 179 promptly." }, { rules: RULES }); // ~round(178.593)
  assert.equal(v.admissible, false);
  assert.ok(v.reasons.some((r) => r.includes("restates")));
});

test("verify: allows benign integers (durations) that are not sourced values", () => {
  const v = verifyHypothesis(sodiumTicket(), { ...goodParsed, plan: "Consider rechecking within 24 hours." }, { rules: RULES });
  assert.equal(v.admissible, true, v.reasons.join("; "));
});

test("verify: allows small benign integers even when they collide with a small sourced number", () => {
  // outOfRangeBy ~1 must not cause "type 1 diabetes" / "1-3 months" to be rejected.
  const ticket = {
    id: "AR-H", severity: "moderate",
    provenance: { loinc: "4548-4", result_id: "H", source: "order_results.csv" },
    facts: { component: "HbA1c", value: 6.6, unit: "%", direction: "high",
      reference: { low: 4.5, high: 5.6 }, outOfRangeBy: 1.0, beyondCritical: false, criticalBounds: { high: 10 } },
  };
  const rules = { elevated_hba1c: { loinc: "4548-4", direction: "high", statement: "Elevated HbA1c reflects higher average glucose.", url: "https://example.org/a1c" } };
  const parsed = {
    assessment: "Elevated HbA1c above the reference range suggests suboptimal glucose control, as in type 2 diabetes.",
    plan: "Consider repeat testing over the next 3 months and lifestyle counseling.",
    citations: { facts: ["value", "direction"], rule: "elevated_hba1c" },
  };
  const v = verifyHypothesis(ticket, parsed, { rules });
  assert.equal(v.admissible, true, v.reasons.join("; "));
});

test("generate: no applicable rule → no hypothesis (honest silence)", async () => {
  const ticket = sodiumTicket();
  ticket.provenance.loinc = "99999-9"; // no rule for this
  const r = await generateHypothesis(ticket, { rules: RULES, runLLM: async () => { throw new Error("should not call"); } });
  assert.equal(r.noRule, true);
  assert.equal(r.hypothesis, null);
});

test("generate: stubbed LLM producing a valid note is admitted", async () => {
  const runLLM = async (config, prompt) => {
    assert.ok(prompt.includes("hypernatremia"), "applicable rule offered in prompt");
    assert.ok(!prompt.includes("hyponatremia"), "non-applicable rule filtered out");
    return { output: { text: JSON.stringify(goodParsed) } };
  };
  const parse = require("../../../llms/src/utilities/parseResponseJson");
  const r = await generateHypothesis(sodiumTicket(), { rules: RULES, runLLM, parse, config: {} });
  assert.equal(r.admissible, true, r.reasons.join("; "));
  assert.equal(r.hypothesis.cites.rule.statement.length > 0, true);
});

test("generate: stubbed LLM emitting a fabricated value is rejected by verify", async () => {
  const bad = { ...goodParsed, assessment: "Sodium 178.593 indicates severe hypernatremia." };
  const runLLM = async () => ({ output: { text: JSON.stringify(bad) } });
  const parse = require("../../../llms/src/utilities/parseResponseJson");
  const r = await generateHypothesis(sodiumTicket(), { rules: RULES, runLLM, parse, config: {} });
  assert.equal(r.admissible, false);
  assert.equal(r.hypothesis, null);
});

test("applicableRules: filters to matching LOINC + direction", () => {
  const rules = applicableRules(sodiumTicket(), RULES);
  assert.deepEqual(Object.keys(rules), ["hypernatremia"]);
});
