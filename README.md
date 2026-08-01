<p align="center">
  <img src="assets/logo%2Btext.svg" width="300" alt="Syntaxin — from arbitrary schemas to evidence-backed decisions">
</p>

<p align="center"><strong>From arbitrary schemas to evidence-backed decisions.</strong></p>

Syntaxin turns messy, arbitrarily-shaped source data — any ASCII-parsable export: CSV, JSON, TXT, Markdown, and the like — into typed, routed, cited **tickets** for human review, and can push those tickets back out to the systems that act on them. **AI compiles the connectors at both edges; a deterministic engine does the work in between.** Whatever syntax the data arrives in, Syntaxin transforms it into standardized, correctly-routed evidence.

> Source-available for evaluation. Not licensed for commercial or production use. See [License](#license).

---

## Why "Syntaxin"

**Syntaxin** is a real protein — one of the SNARE proteins that carry out *vesicle docking and membrane fusion*. Its job in the cell is to make sure the right cargo reaches the right destination: a vesicle carrying its payload docks only with the correct target membrane, binds, and releases its contents on the other side.

That is almost exactly what this system does. Arbitrary, differently-shaped EHR data arrives; it is normalized, analyzed, packaged as evidence, and **routed to the right queue and the right person** — cargo delivered to the correct target, reliably, every time.

The name also hides a happy accident: **syntax**. The hard problem in health-system integration isn't that data is dirty — it's that every EHR speaks a different *syntax*. Syntaxin's core move is transforming arbitrary syntax (heterogeneous schemas) into standardized, correctly-routed semantics. The biology and the engineering point at the same idea.

And the mark is the **x** in synta**x**in: two converging strokes that read as the letter *and* as two things docking at a center point — the letterform and the metaphor in one shape.

---

## What it does

Health-system data is rarely the problem because it's *dirty* — it's a problem because every system is shaped *differently*, and that integration cost is what stops tools from scaling. Syntaxin treats the **anomaly**, not the data, as the universal object: whatever shape or format the source takes, each finding becomes a normalized ticket that carries its own facts, provenance, severity, and citations.

**Input is format-agnostic.** Drop in any ASCII-parsable export — CSV, JSON, TXT, Markdown — including the structurally messy ones: ragged rows, quoted multi-line fields, and values that visually span into the rows below (a merged-cell artifact CSV can't natively represent). An AI **input connector** reads samples and induces a *mapping manifest* — declarative data, never code — that a fixed engine reviews with a human, then applies to flatten the source into a canonical `path → value` model (hierarchical dotted keys, e.g. `patient.vitals.bp.systolic`). The mapping is then **verified, not trusted**: coverage proves no source column was silently dropped, a per-field **round-trip** reconstructs each value through the transform's declared inverse to prove the conversion is lossless, and a type gate confirms every value fits its canonical slot — so a re-induction on a renamed schema can be trusted without hand-checking each field.

Three checkers ship in this prototype, all over the same pipeline:

- **Care-gap / preventive-lab verification** — for a patient's active conditions, was the expected test done? Surfaces gaps that were never ordered and gaps that were ordered but never resulted (loop closure).
- **Abnormal-result triage** — of the results we have, which need a human first? Ranked by severity, with a physiologic-plausibility gate that keeps impossible values out of the clinical queue.
- **Pre-visit summarization & medication reconciliation** — the LLM reasons over the unstructured progress notes to produce a cited pre-visit summary and to surface medication-reconciliation gaps (note vs. active orders), under the same fact/hypothesis contract.

## The safety contract

Every ticket separates **fact** from **hypothesis**:

- **Facts are deterministic and authoritative.** The LLM never emits a value, a dose, a severity, a clinical rule, or a URL.
- **The LLM is advisory and cited.** A hypothesis is admissible only if it cites (a) the facts it explains, (b) the sourced clinical rule it invokes, and (c) a human-curated link to verify that rule — with the correlation explained in plain language.
- **The model emits specs, never code.** Both connectors — the input mapping manifest and the output field map — are declarative data the model *proposes* and a human can inspect; fixed, reviewed engines execute them. The model never authors a parser, a request, or the UI. No runtime code generation.
- **Human approval gates the action, not the reading.** Nothing writes to a chart; every actionable ticket requires a click.

## Architecture

```
any ASCII-parsable source (CSV / JSON / TXT / MD …)
  → AI input connector: induce mapping manifest (source → canonical)   advisory (LLM) → human-approved spec
  → parse + flatten to canonical path→value                            deterministic
  → structural repair (ragged rows, spanning / multi-line cells)       deterministic
  → verify mapping: coverage + round-trip (lossless proof) + types     deterministic
  → normalize (unify labs, split BP, encodings)                        deterministic
  → plausibility gate → data-quality tickets                           deterministic
  → analysis
       · Tier A — generic statistics (data-quality anomalies)          deterministic
       · Tier B — governed clinical checks (care-gap, triage, recon)   deterministic
  → severity (sourced vector → queue, SLA)                             deterministic
  → hypothesis: generic-SOAP (Objective=fact / Assessment / Plan)      advisory (LLM), cited
  → verify (reject unsourced content)                                  deterministic
  → tickets (assemble, dedup, route)                                   deterministic
  → frontend (governed primitives, review queue, human gate)           deterministic + human action
  → AI output connector: induce field map from target API doc          advisory (LLM) → human-gated push
       deterministic client executes (dry-run in this prototype)       deterministic
```

The LLM's durable job is at the **edges** — compiling heterogeneous schemas, plain-English clinical rules, and target-system API docs into governed, reviewed specs — plus advisory, cited reasoning over the unstructured notes. It never authors executable artifacts. Clinical rules, severities, plausibility bounds, and citation links all live in human-curated config, never in model output.

## Quick start

```bash
npm install
npm run build-tickets   # induces mappings + generates cited hypotheses (uses the LLM), writes tickets.json
npm start               # http://localhost:8080 — zero network calls
```

The server serves two things: **`/`** — a drag-and-drop demo (drop any CSV from `data/`; the connector sniffs it, maps it, verifies the mapping is lossless, and runs the checkers into tickets live), and **`/tickets`** — the full pre-built review queue with cited hypotheses.

Requires Node.js 20+. `build-tickets` is the only networked step: it uses the Anthropic API when `ANTHROPIC_API_KEY` (or `NEREUS_ANTHROPIC_API_KEY`) is set, and caches everything to `tickets.json` and `config/mapping.*.json`. `npm start` then serves entirely from those caches, so **the running demo makes zero network calls** and cannot fail on the network. Without an API key, `build-tickets` still produces deterministic facts-only tickets (no advisory hypotheses).

```bash
npm test      # run the test suite
npm run sweep # run the AI connector + verifier over every file in data/ (matrix + gate)
```

## Data

The interview dataset lives in [`data/interview/`](data/interview/) — roughly 100 patients, 153 encounters, and 153 clinical progress notes across eight specialties, in an Epic-style export shape (14 CSVs). It is **synthetic and de-identified — no real patient information** — and intentionally imperfect the way production data is: missing values, inconsistent encodings, out-of-range and sentinel values, and structural mess (e.g. BP stored as `150/99` text). Handling that mess is part of the work, not a distraction from it.

`data/` also holds small **multi-format sample datasets** — `labs_nested.json` (nested JSON), `labs_pipe.txt` (pipe-delimited), `labs_tabbed.tsv` (tab-delimited) — each a *different schema in a different format*. They demonstrate that the connector adapts across formats, not just renamed columns: drop any of them into the demo and the same checkers produce tickets.

Point the connector at any other ASCII-parsable export and it proposes a mapping manifest (`config/mapping.*.json`) for review before it runs. Sources may be structurally messy — ragged rows, quoted multi-line cells, values that span into the rows below — and are repaired deterministically. A **renamed-schema fixture** (`data/interview/fixtures/order_results.renamed.csv` — the labs with every column renamed and the delimiter changed to `;`) demonstrates that induction generalizes: `npm run agnostic-demo` re-induces a different manifest for it and shows the canonical output and the resulting tickets come out **identical** to the original.

## Non-goals

Deliberately out of scope in this prototype: an *unbounded, fully-autonomous* schema-induction engine — induction here is **bounded** (the model proposes a mapping manifest for human review; nothing runs unreviewed), demonstrated by the renamed-schema fixture (`npm run agnostic-demo`) — and scheduling-throughput analysis. Live write-back through the output connector is **dry-run only** in this prototype (a real push is a human-gated action). Medication reconciliation and pre-visit summarization are **in scope** — they are the third checker above.

## License

Licensed under the **PolyForm Strict License 1.0.0** — source-available for review, research, and evaluation only. Commercial use, production use, distribution, and derivative works are not permitted. See [`LICENSE`](./LICENSE).

© 2026 William Brendel. All rights reserved except as granted by the license above.