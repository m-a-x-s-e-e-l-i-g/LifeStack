---
target: homepage assistant surface
total_score: 29
p0_count: 1
p1_count: 2
timestamp: 2026-06-20T08-45-26Z
slug: frontend-src-routes-page-svelte
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 3.0 | No progress signal for image optimization or retry state after failures. |
| 2 | Match System / Real World | 3.5 | Language is mostly concrete, but rail glyphs are abstract for first exposure. |
| 3 | User Control and Freedom | 3.0 | No undo/edit for sent turns and no confirmation before destructive reset. |
| 4 | Consistency and Standards | 3.5 | Strong visual consistency, but high-risk approvals share button weight with routine actions. |
| 5 | Error Prevention | 2.5 | Destructive approvals and reset flow lack stronger guardrails. |
| 6 | Recognition Rather Than Recall | 3.0 | Core actions are visible, but module capability model is mostly implicit. |
| 7 | Flexibility and Efficiency | 2.5 | Basic keyboard flow exists, but no power-path accelerators for advanced users. |
| 8 | Aesthetic and Minimalist Design | 3.5 | Clean and restrained composition, with occasional low-emphasis hint text reducing clarity. |
| 9 | Error Recovery | 2.0 | Errors are generic and recovery actions are not explicit. |
| 10 | Help and Documentation | 2.5 | Inline hint exists, but no contextual help for approvals and module states. |
| **Total** |  | **29/40** | **Good** |

## Anti-Patterns Verdict

**LLM assessment**
- The UI does not read as generic AI output. It avoids gradient-text gimmicks, side-stripe card accents, and card-grid templating.
- Visual direction is coherent with PRODUCT and DESIGN context: warm, restrained, data-forward.
- Main risk is not "AI slop" style, it is operational trust in high-stakes approval actions.

**Deterministic scan**
- File scan on [frontend/src/routes/+page.svelte](frontend/src/routes/+page.svelte) returned no findings.
- URL scan on http://127.0.0.1:4173/ returned 3 warnings:
  - `line-length`: approx 132 chars in long hint copy.
  - `tiny-text`: 11.5px text present.
  - `low-contrast`: low contrast around backdrop-filter region in composer hint area.
- Detector surfaced readability and contrast details the LLM review only partially emphasized.

**Visual overlays**
- A dedicated [Human] tab was opened for visual verification.
- This installed impeccable CLI (v3.0.3) does not expose the `live` overlay server command documented in older flows, so overlay injection could not be run. URL-based rendered detection was used as the viable alternative.

## Overall Impression

This is a thoughtful and mature assistant-first surface with clear product intent. The biggest opportunity is to harden trust and recoverability around approval and error flows so users feel safe making data mutations.

## What's Working

1. Strong voice and intent in the hero and seed prompts, specific to real module tasks.
2. Cohesive system tokens and typography create calm, non-template product identity.
3. Structured disclosure of SQL/query steps supports transparency without default clutter in normal turns.

## Priority Issues

- **[P0] High-risk approval safety needs stronger guardrails**
  - **Why it matters**: write/delete actions can change user data; accidental approval is costly.
  - **Fix**: add a risk-tiered confirmation step for destructive actions, show affected row counts before final action, visually differentiate delete from import.
  - **Suggested command**: `harden homepage approvals`

- **[P1] Error recovery is too generic**
  - **Why it matters**: users cannot quickly recover when assistant calls fail; confidence drops.
  - **Fix**: classify error states (backend unavailable, model timeout, malformed request), add inline retry action, preserve user context near failure.
  - **Suggested command**: `clarify error and recovery states`

- **[P1] Readability debt in composer hint text**
  - **Why it matters**: detector flagged long line length, tiny text, and low-contrast text where users need operational instructions.
  - **Fix**: increase hint text size to at least 13-14px, tighten line width to 65-75ch, raise contrast token on blurred/backdrop area.
  - **Suggested command**: `typeset composer hint region`

- **[P2] Module discoverability remains implicit**
  - **Why it matters**: first-time users infer capabilities from prompts instead of understanding module affordances directly.
  - **Fix**: add lightweight per-module descriptors or hover help in rail; expose enabled/disabled rationale with action path.
  - **Suggested command**: `onboard module navigation`

- **[P2] Cognitive load spikes during approval details**
  - **Why it matters**: multiple dense decisions appear at once (summary, preview table, two primary actions).
  - **Fix**: progressive disclosure for preview rows, simplify first decision to approve/review, then reveal details on demand.
  - **Suggested command**: `layout approval decision flow`

## Persona Red Flags

**Alex (Power User, data-heavy interface)**
- No keyboard accelerators for high-frequency actions (new chat, approve/decline navigation).
- Approval queue is embedded in conversation stream, reducing fast triage for pending actions.
- Generic failure copy slows diagnosis during rapid query iteration.

**Sam (Accessibility-dependent, data-heavy interface)**
- Detector-reported low-contrast/tiny text in hint zone can become unreadable at lower vision thresholds.
- Dense approval preview tables need careful focus order and announced context to avoid screen-reader ambiguity.
- Symbol-only glyphs in rail rely on adjacent labels; if layout compresses, semantic resilience drops.

**Jordan (First-Timer, assistant-first landing)**
- Module boundaries and expected outcomes are inferred, not explicitly taught.
- Error messages do not consistently state what to do next.
- High-stakes approvals appear without enough confidence-building explanation.

## Minor Observations

- 11.5px helper text appears multiple times and should be standardized upward.
- Reset/New chat action is visible and useful, but should communicate consequence more explicitly.
- Seed prompts are effective, but could include one "safe starter" prompt optimized for first-run confidence.
