# Syntaxin — Build Strategy

Working strategy for the take-home build (New Product Development Lead). Target: a working, live-demoable prototype + 2–4 slides for **2026-08-06**. Companion to the [README](../README.md); the README is the product narrative, this is the plan.

## Thesis

Every source system speaks a different *syntax*. The durable move is to put **AI at the two edges** (compile connectors) and keep a **deterministic engine in the core** (do the work). Data flows in from any shape, becomes canonical, gets analyzed, becomes cited tickets, and — as a bonus — flows back out to whatever system acts on it.

```
INPUT (AI connector) → CANONICAL → ANALYSIS → TICKETS → OUTPUT (AI connector)
   1–3                                4–5        6          7
```

## Two hard rules (non-negotiable, and they are the interview's safety story)

1. **The LLM emits *specs*, never code.** Both connectors are declarative data (JSON) the model *proposes* and a human reviews; fixed engines execute them. The model never authors a parser, a request, or UI. This is the safe form of "LLM builds a connector."
2. **Clinical findings run on *governed rules*, not generic statistics.** Generic stats are for data-quality anomalies only. A z-score detector flags high-variance MRNs and misses an in-range-but-critical potassium — so clinical validity comes from sourced reference ranges and condition→test maps, never from statistics.

## 1–3 · AI-driven input connectors

**Input:** drag-and-drop any ASCII-parsable file — `.csv`, `.json`, `.txt`, `.md`, … .

**Structural messiness is expected and repaired deterministically:**
- ragged rows (varying column counts),
- quoted multi-line cells (a field containing newlines),
- values that visually **span into the rows below** (a merged-cell artifact CSV can't natively represent),
- inconsistent delimiters / encodings / sentinels.

**How the connector works (spec-not-code):**
1. Deterministic **structural sniff** — detect delimiter, quoting, header row, ragged/spanning regions. Produce a clean grid.
2. LLM reads a **sample** and induces a **mapping manifest** (below) — `source field → canonical path + transform`. Declarative data.
3. Human reviews/approves the manifest (shown on screen).
4. Deterministic engine applies the manifest → canonical **`path → value`** records with hierarchical dotted keys (e.g. `patient.vitals.bp.systolic`). The canonical model is the fixed "protobuf"; the manifest is the only thing that varies per source.
5. **Verify, don't trust** — a deterministic verifier proves three properties and attaches a report: **coverage** (every source column mapped or explicitly dropped — no silent omission), **round-trip** (reconstruct each value from canonical via the transform's declared `inverse`/`check` and compare, over a sample — a lossless proof up to declared transform semantics), and **type-plausibility** (each value fits its canonical slot). This is the automated confidence gate that lets a re-induction on a renamed schema be trusted without hand-checking every field. It does **not** claim semantic correctness of same-type mappings (first- vs last-name) — low-risk with descriptive headers, and backstopped by human review.

Each named transform declares its reversibility contract (`inverse` + `check`) once — the **single source of truth** consumed by both the runtime verifier and the transform property tests (`check(x, fn(x))` must hold; reversible transforms must round-trip through `inverse`).

### Mapping manifest (sketch)

```json
{
  "source": { "format": "csv", "delimiter": ",", "header_row": 0, "quote": "\"" },
  "record_key": ["PAT_ID"],
  "fields": [
    { "from": "PAT_MRN_ID",  "to": "patient.mrn",              "type": "string" },
    { "from": "BIRTH_DATE",  "to": "patient.birth_date",       "type": "date" },
    { "from": "MEAS_VALUE",  "to": "patient.vitals.bp",        "transform": "split_bp",
      "emits": ["patient.vitals.bp.systolic", "patient.vitals.bp.diastolic"] }
  ],
  "structural": { "reflow_spanning_cells": true, "join_multiline": true }
}
```
Transforms (`split_bp`, `parse_range`, date coercion, sentinel→null) are a **fixed, reviewed library** the manifest *references by name* — the LLM picks from them, it does not write them.

**Proof of generalization:** the renamed-schema fixture. Same data, renamed columns → the connector re-induces a different manifest → the *same* checkers run unchanged. This is the whole thesis in one 60-second demo.

## 4–5 · Analysis (two tiers)

- **Tier A — generic statistics (format-agnostic).** Per-canonical-field profiling: type, null rate, cardinality, range, sentinel/out-of-range detection → **data-quality tickets**. Runs on any schema.
- **Tier B — governed clinical checks.** The three checkers, each a thin module on the shared spine:
  - **Abnormal-result triage** — rank flagged results needing a human first; physiologic-plausibility gate rejects impossible values.
  - **Care-gap / preventive-lab** — for active conditions, was the expected test ordered *and* resulted? (never-ordered vs. ordered-but-unresulted).
  - **Pre-visit summarization + med reconciliation** — LLM reasons over the notes; note-vs-active-orders gaps.

  **The mechanism is data-agnostic; only the knowledge is curated.** Every checker runs on the *canonical* model, never on source columns. Abnormal detection uses each result's **own reference range**, and plausibility falls back to a **reference-range-derived bound** when no curated per-analyte limit exists — so the checker triages and gates *any* analyte, in *any* schema, with zero config. Curated clinical config (analyte bounds, condition→test maps, correlation rules) is keyed to **LOINC / ICD-10** interoperability standards — portable across EHRs, not tailored to one file — and is strictly *precision enrichment*: absent an entry, the checker degrades gracefully (generic bound / distance-based severity / skip) rather than silently doing nothing.

**Explanation = generic-SOAP**, mapped onto the fact/hypothesis contract:

| SOAP | Ticket field | Authority |
|---|---|---|
| **O**bjective | the facts / the anomaly | deterministic, authoritative |
| **A**ssessment | hypothesis of cause | LLM, advisory, **cited** |
| **P**lan | recommended fix / next move | LLM, advisory, **cited** — human gates the action |

## 6 · Frontend delivery (internal tool)

Review queue of ranked tickets. Each shows Objective facts + provenance + citations, with the **human-approval gate** on any action. Governed primitives only — no model-authored UI.

## 7 · AI-driven output connector (bonus)

Same pattern as input, mirrored: LLM reads a **target API doc** (EHR / CRM / ticketing) → induces a **field map** (`canonical ticket → target endpoint fields`) → deterministic HTTP client executes. In this prototype it is **dry-run only** against a mock endpoint — a real write is a human-gated action, never automatic.

## Build sequence (always keep a working demo)

| Day | Work | Milestone |
|---|---|---|
| 1 | Node bootstrap (`package.json`, `npm start`/`npm test`), structural sniff + `path→value` flatten, data-truth pass on the real dataset | canonical records exist |
| 2 | Mapping-manifest apply + transform library + Tier-A stats → data-quality tickets | messy data handled |
| 3 | **Checker #1: abnormal-result triage** end-to-end → minimal ticket UI | **first live demo** |
| 4 | LLM hypothesis layer (generic-SOAP, cited) + `verify` step | GenAI does real work |
| 5 | **Checker #2: care-gap** + renamed-schema fixture demo | thesis proven live |
| 6 | **Checker #3: summarization + med-recon**; cache tickets → zero-network demo; output-connector dry-run | full loop |
| 7 | 2–4 slides (problem, data judgment, safety/risks) + rehearse | ready |

**Cut line if time slips:** drop the output connector (7), then checker #3, then #2. Never cut the spine, the two hard rules, or the human gate — those are what the role is judged on.

## Open decisions / risks

- **Generic anomaly detection can produce clinically meaningless findings** — mitigated by the Tier-A/Tier-B split; say so explicitly in the interview.
- **Manifest induction on truly adversarial inputs** — bound the demo to the formats above; show the human-review step as the safety net.
- **Output connector** stays a dry-run; do not wire a real external write for the demo.
