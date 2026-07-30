<p align="center">
  <img src="assets/logo%2Btext.svg" width="300" alt="Syntaxin — from arbitrary schemas to evidence-backed decisions">
</p>

<p align="center"><strong>From arbitrary schemas to evidence-backed decisions.</strong></p>

Syntaxin turns messy, arbitrarily-shaped EHR exports into typed, routed, cited **tickets** for human review — combining deterministic checks, an advisory LLM layer, and human-in-the-loop actions under one safety contract. Whatever syntax the source data arrives in, Syntaxin transforms it into standardized, correctly-routed evidence.

> Source-available for evaluation. Not licensed for commercial or production use. See [License](#license).

---

## Why "Syntaxin"

**Syntaxin** is a real protein — one of the SNARE proteins that carry out *vesicle docking and membrane fusion*. Its job in the cell is to make sure the right cargo reaches the right destination: a vesicle carrying its payload docks only with the correct target membrane, binds, and releases its contents on the other side.

That is almost exactly what this system does. Arbitrary, differently-shaped EHR data arrives; it is normalized, analyzed, packaged as evidence, and **routed to the right queue and the right person** — cargo delivered to the correct target, reliably, every time.

The name also hides a happy accident: **syntax**. The hard problem in health-system integration isn't that data is dirty — it's that every EHR speaks a different *syntax*. Syntaxin's core move is transforming arbitrary syntax (heterogeneous schemas) into standardized, correctly-routed semantics. The biology and the engineering point at the same idea.

And the mark is the **x** in synta**x**in: two converging strokes that read as the letter *and* as two things docking at a center point — the letterform and the metaphor in one shape.

---

## What it does

Health-system data is rarely the problem because it's *dirty* — it's a problem because every EHR is shaped *differently*, and that integration cost is what stops tools from scaling. Syntaxin treats the **anomaly**, not the data, as the universal object: whatever shape the source export takes, each finding becomes a normalized ticket that carries its own facts, provenance, severity, and citations.

Two checkers ship in this prototype, both over the same pipeline:

- **Care-gap / preventive-lab verification** — for a patient's active conditions, was the expected test done? Surfaces gaps that were never ordered and gaps that were ordered but never resulted (loop closure).
- **Abnormal-result triage** — of the results we have, which need a human first? Ranked by severity, with a physiologic-plausibility gate that keeps impossible values out of the clinical queue.

## The safety contract

Every ticket separates **fact** from **hypothesis**:

- **Facts are deterministic and authoritative.** The LLM never emits a value, a dose, a severity, a clinical rule, or a URL.
- **The LLM is advisory and cited.** A hypothesis is admissible only if it cites (a) the facts it explains, (b) the sourced clinical rule it invokes, and (c) a human-curated link to verify that rule — with the correlation explained in plain language.
- **The model selects and composes from governed pieces; it never authors the executable artifact that touches the human.** No runtime UI code generation.
- **Human approval gates the action, not the reading.** Nothing writes to a chart; every actionable ticket requires a click.

## Architecture

```
raw EHR CSVs
  → ingest (mapping spec: source → canonical)        deterministic
  → round-trip verify (lossless proof)               deterministic
  → normalize (unify labs, split BP, encodings)      deterministic
  → plausibility gate → data-quality tickets         deterministic
  → checks (care-gap, abnormal-triage) → findings     deterministic
  → severity (sourced vector → queue, SLA)           deterministic
  → hypothesis (why / fix / next move, cited)        advisory (LLM)
  → verify (reject unsourced content)                deterministic
  → tickets (assemble, dedup, route)                 deterministic
  → frontend (governed primitives, two queues)       deterministic + human action
```

The LLM's durable job is at the edges — compiling heterogeneous schemas and plain-English clinical rules into governed, reviewed specs — not reasoning over data at runtime. Clinical rules, severities, plausibility bounds, and citation links all live in human-curated config, never in model output.

## Quick start

```bash
./run.sh
# → builds tickets (offline-safe) and serves the UI at http://localhost:8000
```

Requires Python 3.11+. The LLM hypothesis layer uses the Anthropic API when `ANTHROPIC_API_KEY` is set; without it, tickets render with deterministic fallback text. Tickets are cached to `tickets.json`, so the running app makes **zero network calls** — the demo cannot fail on the network.

```bash
pytest        # run the test suite
```

## Data

**No patient data is included in this repository.** The prototype was developed against a synthetic, de-identified dataset that is intentionally excluded. Point `config/settings.yaml` `data.root` at your own EHR export and provide a mapping spec (`config/mapping_*.yaml`) describing how its columns map to the canonical model. A renamed-schema fixture is included to demonstrate that the checkers run unchanged across different data shapes.

## Non-goals

Deliberately out of scope in this prototype: an LLM schema-induction engine (data-agnosticism is proven by the renamed-schema fixture instead), medication reconciliation (stubbed), free-text summarization, and scheduling-throughput analysis.

## License

Licensed under the **PolyForm Strict License 1.0.0** — source-available for review, research, and evaluation only. Commercial use, production use, distribution, and derivative works are not permitted. See [`LICENSE`](./LICENSE).

© 2026 William Brendel. All rights reserved except as granted by the license above.