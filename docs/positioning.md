# Syntaxin — Positioning Brief

## The wedge (one sentence)
**Continuous, independent, field-level-reversible proof — exposed as an API — that your data platform lost nothing, from a lossless master that treats FHIR as a regenerable view instead of the source of truth.**

Not "AI that maps your data" (a weekend clone). Not "we validate migrations" (a migration SI says they already do). The narrow, defensible claim is the four properties below at once — properties the incumbents structurally won't or can't offer.

## The problem it exploits
Every health-data platform — 1upHealth, Medplum, Metriport, Redox, the AWS/Azure/Google FHIR stores — normalizes to FHIR and *hopes*. FHIR normalization is admittedly lossy ("data emerges duplicated, incomplete, or mistranslated"); the industry's own best-practice "fidelity" story is only *keep the raw copy so a human can replay it*. **Nobody proves the normalized record lost nothing.** They make FHIR the master, and whatever FHIR can't express is gone.

## The four gaps = the moat
What exists is one-time, self-audited, shallow, and offline. The wedge is the opposite on all four, and each is a distinct reason a fast follower can't just "adapt quickly":

1. **Continuous, not one-time.** Migration validators fire once at cutover. Nobody re-proves losslessness on *every ongoing ingestion*. → API-hookable, always-on.
2. **Independent, not self-audit.** The migrator/platform won't rigorously flag its *own* lossy work — counter-positioning. An independent proof is the thing they structurally won't ship.
3. **Semantic + reversible, not hash-totals.** Incumbent checks are counts/hashes/KPI spot-comparison — they miss `13.063 → 63.063`. This is field-level reversible proof with provenance.
4. **A live API on a store, not a PDF at project-end.** A queryable guarantee app-builders can gate on, not a reconciliation dashboard for a cutover meeting.

## The structural moat under the four gaps
The **inversion**: the lossless canonical is the master; **FHIR is a regenerable, lossy projection of it.** Incumbents can't adopt this without abandoning FHIR-as-master — a foundational rebuild. Their *speed* came from that choice; that choice is *why they're lossy*; fixing it means becoming us. And the accumulating asset — the per-integration **resolution ledger** (every human-resolved ambiguity, versioned, re-provable) plus the retained "unmappable remainder" — is the customer's, not ours: a shark clones the engine in a sprint but not the customer's thousands of resolved decisions.

## Proof it's real (built, tested, running)
On the real labs export (`order_results.csv`, 1,288 records × 20 columns):

| Round trip | Result |
|---|---|
| **source ↔ master** (`npm run lossless`) | **100% lossless** (24,472/24,472 cells); a FHIR-first store loses **27.2%** (5 dropped columns + 224 formatting cells) |
| **master → FHIR → master** (`npm run project`) | **100% fidelity** for carried fields; honestly reports the **9/20** fields FHIR can't hold (5 remainder + 4 unprojectable) |

Deterministic verdict, provenance per cell, 110/110 tests. The interpreted canonical is a lossy view; the master isn't; the gap is measurable.

## Where it plugs in
**On top of** 1up / Medplum / cloud-FHIR — ride their distribution instead of fighting it. You are the layer that certifies *their* ingestion didn't lose anything, and hands the app-builder a FHIR view plus the exact list of what that view drops. Build the store, but sell only the proof: pillars "easy integrate / API-for-apps / compliant" are table stakes you match, not the pitch.

## Honest caveats
1. **False sense of safety.** Migration SIs do a *shallow* version bundled in, so buyers may believe it's "already handled." You sell against complacency, harder than empty whitespace — lead with a live demo that catches what their checklist misses.
2. **Patent diligence.** IBM US7996679B2 ("trust-preserving migration") is **expired/lapsed and different** (hashes *identical* objects; breaks on any transform; no canonical, no reversibility) — low risk, and now prior art in your favor. But clear the broader landscape with real IP counsel before relying on it. This is your execution; consider a provisional to deny it to a shark, not to build the moat on.
3. **Time, not immunity.** A shark *can* build a proof layer — they just won't fast, because it fights their demos and incentives. Use the runway to deepen the ledger until "catching up" means re-living years on real datasets.

## Not yet built (the real product beyond the proof)
- Durable, queryable **storage** of raw + remainder + lineage (the actual "store").
- **Induced** projection manifests across more FHIR resource types (mirror of `induce`), vs today's hand-written Observation projection.
- A general FHIR **importer** (`unproject` currently assumes a bidirectional manifest).
