# Interview Exercise Brief — New Product Development Lead

> Reference copy of the take-home build exercise and interview format. Internal notes for preparation; not part of the product.

## Format

**Interview date:** Thursday, August 6, 2026 *(pushed one week from the original July 30 date)*

| Time (PDT) | Session | Duration |
|---|---|---|
| — | Case Study — presentation + live prototype walkthrough | 45 min |
| — | Coding Screen — **JavaScript** data transformation | 30 min |

*(Confirm the exact session times when the updated invite lands.)*

The loop has natural checkpoints after each session; the team may wrap up early if it becomes clear the role isn't the right fit. Join with the same email the confirmation was sent to.

### Case study session (45 min)
- Introductions
- Presentation of approach and thinking (~10 min)
- Q&A and live discussion of the prototype (~30 min)
- Questions at the end
- Slides shared via screen share; environment ready to run the prototype live.

---

## Take-Home Build Exercise

Take the provided (synthetic) EHR dataset, pick a high-value problem in **throughput, capacity, or clinical operations**, and build a **working, GenAI-enabled prototype** that addresses it. Then walk through it live. The build and the judgment matter, not the slides. **A narrow thing that works beats a broad thing that does not.**

**Tools:** Use whatever you would on the job, including AI coding assistants (Cursor, Claude, Copilot) — that is expected. The data is synthetic with no privacy constraints, so it may be sent to AI tools freely.

### The data
A synthetic dataset modeled on real Epic-style EHR exports: no real patient information, but intentionally imperfect the way production data is (missing values, inconsistent encodings, out-of-range and sentinel values). Roughly 100 patients and 150 encounters, mostly Annual Wellness Visits, across eight specialties. It includes structured data (demographics, encounters, problems and diagnoses, medications and orders, lab and procedure orders and results with reference ranges and flags, vitals, providers) and unstructured clinical progress notes. **Handling the messiness is part of the exercise, not a distraction from it.**

### The task
- **Pick a problem.** A high-value throughput, capacity, or clinical-operations opportunity addressable with this data. Be specific about who it helps and why. Examples (none required): pre-visit lab or care-gap prep, abnormal-result triage, medication reconciliation, pre-visit clinical summarization, referral or visit prep. Your own idea is welcome.
- **Build a working prototype** that runs and demonstrates the core of the idea on the data. GenAI should do real work (for example, reasoning over the unstructured notes), not sit on top as a cosmetic layer. *If the design barely needs an LLM, reconsider it.*
- **Show reasoning about the data:** how it was explored, what was trusted, what was cleaned or excluded, and how wrong or missing records were handled.
- **Address clinical appropriateness and safety:** where the system could be wrong in a way that matters clinically, and what guardrails or human-in-the-loop checks would be used.

### What to present
- **The working prototype** (demoed live).
- **2 to 4 slides** (polish not graded) covering the *reasoning*, not a walkthrough of the prototype: the problem chosen and why, how the data was used and validated including the messy parts, and how clinical appropriateness, safety, and the biggest risks were considered.
- **The live session:** ~45 minutes — roughly 10 minutes on the slides, then the rest going through the prototype and answering questions. Environment ready to run it live.

### What they are looking for
- Sound data judgment and real preprocessing, not just happy-path code.
- A prototype where the build and the use of GenAI are clearly your own.
- Clear problem framing and strong execution within a tight scope.

---

## Coding Assessment (30 min)
- Conducted in **JavaScript**.
- Focus on **data transformation**, not LeetCode.
- **No AI tools** during the assessment, but the interviewer can be interacted with and will provide hints/advice as needed.