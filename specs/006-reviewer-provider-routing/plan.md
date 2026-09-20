# Implementation Plan: Routing Each Reviewer Role To Its Own Provider

**Spec**: [spec.md](./spec.md) · **Branch**: `reviewer-provider-routing` · **Created**: 2026-09-20

**Research**: [research.md](./research.md) · **Data model**: [data-model.md](./data-model.md) ·
**Contract**: [contracts/model-client.md](./contracts/model-client.md) ·
**Validation**: [quickstart.md](./quickstart.md)

## Summary

Each required reviewer role gets an ordered list of providers — its *route* — and fails over along
it on capacity failures only. A composite `RoutingModelClient` sits where the single
`ModelClient` sits today; the roles, gate, daemon and queue are untouched. Antigravity, driven
headless through `agy`, becomes the first non-authoring provider (R-020), and Claude Code is
named in settings as the authoring provider so FR-082's independence rule can be checked at
preflight rather than discovered after the spend.

Budgets and reserves become per **funding account** — the thing that actually runs out — while
spend stays attributed per provider. That supersedes the single project-wide ceiling, and it is the
one place this feature trades a guarantee away; it is tracked below rather than buried.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js ≥ 22 — unchanged (Principle III)

**Primary Dependencies**: no new package dependency. Antigravity is reached by spawning its already
installed CLI, not by adding a vendor SDK. This is deliberate: [003](../003-subscription-backed-transport/plan.md)
records what `@anthropic-ai/claude-agent-sdk` cost the production tree (~148 packages, an HTTP
server stack, a process-spawning group promoted to runtime), and a second vendor SDK would repeat
that. A subprocess boundary is also the containment boundary FR-083 already requires.

**Storage**: the existing append-only JSONL ledger under the runner host's state directory, plus
check-run output as its authority (R-010). Entries gain `provider` and `account` fields (R-024).

**Testing**: vitest, three layers — unit, integration, and the e2e suite that drives
`OneHedgehog/fixture-repo-ad`. Routing and failover are exercised with scripted providers at the
leaves (R-023, FR-085), so no test path requires exhausting a real vendor's quota.

**Target Platform**: a single developer machine, macOS or Linux, no cloud account (Principle IV)

**Project Type**: local CLI plus a reconciling daemon — unchanged

**Performance Goals**: not a throughput feature. The one timing obligation is FR-086's 300 s
per-attempt bound, and the preflight invariant that keeps a route from outlasting
`maxQueueWaitSeconds` (R-026).

**Constraints**: attempt bound 300 s (down from 900 s); longest route 6 providers at the shipped
`maxQueueWaitSeconds: 1800`; exactly one verdict per role per revision from exactly one provider;
no new metered spend.

**Scale/Scope**: two required roles, routes of 1–6 providers, one target repository.

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1 design. Result: **passes**, with one
tracked weakening.*

| Principle | Assessment |
|---|---|
| **I. Spec-Driven** | Every element traces to FR-076…FR-086. The spec's "Why this is its own spec" section already establishes that these are new obligations rather than restatements of FR-055/FR-057. |
| **II. Testing / substitutable model** | Preserved, and the reason R-023 keeps the routing composite *above* the substituted leaves. One substitution, at the model boundary; the router under test is real. The R-027 quality replay stays out of CI, because an eval in the merge path is a flaky gate. |
| **III. Language boundaries** | TypeScript throughout. No ML/data work. |
| **IV. Local-first, zero-cost** | No new metered spend: Antigravity is reached through an existing OAuth token at `~/.gemini/antigravity-cli/antigravity-oauth-token`, with `GEMINI_API_KEY` and `GOOGLE_API_KEY` both unset (R-020). Every metered resource keeps a budget *and* a reserve, now per **account** — the account being the thing that can run out, which is what the principle means by a metered resource (R-029). The aggregate ceiling is lost — see Complexity Tracking. |
| **V. Bounded autonomy / containment** | FR-083 is discharged per provider: `--mode plan`, `--sandbox`, an empty working directory, a **per-attempt state directory** so the child never inherits the operator's own (R-028), an allowlisted environment, and neutralisation of every other provider's credential. **Two host surfaces are declared rather than discovered** (R-028): the child binds a **loopback port** for the attempt's duration, and writes logs, crashes and conversation state — both confined to the per-attempt directory. **Egress**: the subprocess reaches a second model endpoint. Principle V permits "the model API"; this makes that plural, and nothing else is added — no new host beyond a vendor's inference endpoint. |
| **VI. Independence / bounded loop** | Strengthened. Independence was structural at the GitHub identity level and absent at the model level; FR-082 closes that, and R-021 makes the check meaningful by comparing model families rather than vendor labels. Round bounds and forward progress are untouched. |
| **VII. Verdicts weighable later** | FR-079's attribution is what makes a provider's track record accumulable at all. R-025 puts it in the durable record rather than the host log. |
| **VIII. Isolated parallel execution** | Declared footprint below. It overlaps `src/config/settings.ts` and `schemas/settings.schema.json` with any other in-flight feature touching settings — notably the escalation-channel work under discussion — so those two must be serialized against this one. |
| **IX. Documentation ships with the feature** | [docs/independent-review-service.md](../../docs/independent-review-service.md) is updated in the same pull request as the code, in each of the three parts. |
| **X. Minimal pull requests** | Does not fit the 400-line cap in one, or in two. Split into **three** below — the spec's "On packaging" section fixed two, and the task breakdown showed the first of those carrying 43 tasks across 12 files. |

### Declared footprint (Principle VIII)

```text
src/model/client.ts            src/model/routing.ts (new)      src/model/antigravity.ts (new)
src/model/scripted.ts          src/config/settings.ts          schemas/settings.schema.json
src/ledger/tokens.ts           src/ledger/reconstruct.ts       src/review/prerequisites.ts
src/composition.ts             src/observability/logger.ts     schemas/review-record.schema.json
docs/independent-review-service.md
```

Anything writing these files runs serialized against this feature.

## Project Structure

### Documentation (this feature)

```text
specs/006-reviewer-provider-routing/
├── spec.md
├── plan.md               # this file
├── research.md           # Phase 0
├── data-model.md         # Phase 1
├── quickstart.md         # Phase 1
├── contracts/
│   └── model-client.md   # Phase 1 — the delta to 001's contract
├── checklists/
│   └── requirements.md
└── tasks.md              # /speckit-tasks output
```

### Source code

```text
src/
├── model/
│   ├── client.ts          # + FailureClass, ProviderName on usage and errors
│   ├── routing.ts         # NEW — RoutingModelClient, per-role failover
│   ├── antigravity.ts     # NEW — second-half PR; spawns `agy` headless
│   ├── anthropic.ts       # classifies its failures; otherwise unchanged
│   ├── agent-sdk.ts       # ditto, and the 900 s constant becomes 300 s
│   └── scripted.ts        # extended to stand in for several providers
├── config/
│   └── settings.ts        # routes, providers, accounts, per-account budgets, migration
├── ledger/
│   ├── tokens.ts          # per-account limits; LedgerEntry provider + account
│   └── reconstruct.ts     # parses per-provider spend from check-run output
├── review/
│   └── prerequisites.ts   # per-provider credentials; FR-082 and FR-086 invariants
├── observability/
│   └── logger.ts          # provider + failureClass on role events
└── composition.ts         # assembles the routes

tests/
├── unit/          # classification, route advance/exhaust, migration, invariants
├── integration/   # composition wiring, ledger attribution, preflight failures
└── e2e/           # scripted providers at the leaves — FR-085
```

**Structure Decision**: unchanged from 001. This feature adds two files under `src/model/` and
modifies existing ones; it introduces no new layer, no new seam, and no new top-level directory.

## The packaging split (Principle X)

The spec fixes the split at two and gives the reason. **This plan splits into three**, and the
extra cut is not a departure from the spec so much as arithmetic the spec could not do: the task
breakdown put 43 tasks across 12 files into the spec's first half, which will not sit under a
400-line cap. Discovering that at review time — after the work — is the failure Principle X exists
to prevent, so the cut is made here instead.

**PR 1a — routing and failover.** Types, settings shape, migration, the routing composite, failure
classification, scripted-provider e2e. Ships a working system: an operator who declares nothing new
gets identical behaviour (FR-076, SC-005), and a single-entry route behaves exactly as today.

**PR 1b — preflight and accounting.** Route declaration invariants, per-provider credential
verification, the FR-082 family check and model pinning, per-account budgets and reserves,
per-provider attribution into the check-run output. Ships on top of 1a and is independently
testable: every scenario it adds asserts zero tokens spent or a reconstructable ledger.

**PR 2 — the first provider.** `antigravity.ts`, its containment declaration, its credential
preflight, and the R-027 quality replay.

Each ships a system that works on its own. Stacked parts that only work together would violate
Principle I rather than comply with Principle X — which is the trap this split is shaped to avoid,
not merely a risk it accepts.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **The project-wide token ceiling is removed** (FR-081 supersedes FR-031/FR-047 in this respect) | Tokens from different accounts are different resources. A single total silently adds a token drawn against an exhausted balance to one drawn against a fresh subscription, so a healthy-looking total can conceal the exact exhaustion the reserve exists to prevent. | Keeping the global ceiling *above* the per-account ones was considered and rejected in the spec's 2026-09-19 clarification session. It would have preserved a backstop, but it restores the meaningless sum as the number an operator reads first. **What is lost is real**: no declared number caps total spend any more. The total stays bounded by the sum of per-account budgets and stays computable, but an operator can no longer set a ceiling below that sum. Principle IV's protection now rests on the individual budgets being set deliberately — a weaker guarantee, recorded as such. |
| **Budgets sit on the account, attribution on the provider** — two levels where the spec first had one | One vendor can serve several model families through one credential (R-021, confirmed on Antigravity). Those providers draw on one metered resource, so one budget must bound them. Attribution must stay finer, because SC-003 and Principle VII need each provider's draw readable on its own. | Budgeting per provider — the spec's original wording — was rejected in the 2026-09-20 clarification: two providers on one account would carry two budgets whose sum exceeds what the account holds, each passing its own reserve check while the shared quota was exhausted. That is a Principle IV conflict, not a wording preference. The cost is a second concept in the settings file; the alternative was a reserve that does not bound anything. |
| **A second network egress destination** | A provider that cannot be reached cannot review. | There is no local-only second model family that meets the review quality bar. The egress added is a vendor inference endpoint and nothing else; no new class of destination enters the allowlist. |

## Open question for the operator

**Is a second *account* worth buying, or is independence alone enough for now?**

The catalogue read in R-021 makes this a real fork rather than a rhetorical one. Antigravity serves
Gemini, Claude and GPT-OSS families through one OAuth token, so two providers can be declared —
different families, neither of them the author's — without adding an account. That satisfies FR-082
twice and gives the two required roles genuinely different blind spots.

It does nothing for availability. Both draw on one token, so one session limit fails both, the
route exhausts, and the gate closes exactly as it does today (R-029). SC-001's measurement — two of
#9's nine rounds recovered — would not move.

So the two properties the spec separates come apart cleanly here:

| Configuration | Independence (FR-082) | Availability (SC-001) |
|---|---|---|
| Antigravity alone, one family | ✅ | ❌ |
| Antigravity, two families, one account | ✅✅ | ❌ |
| Antigravity + Cursor, two accounts | ✅✅ | ✅ |

Only the third row reaches SC-001, and it is the only one that costs something. The plan ships the
first row and declares Cursor as the intended second provider; which row to stop at is the
operator's call, and R-029 exists so the middle row is not mistaken for the bottom one.

**A second open item, smaller**: if the R-027 replay disappoints, the fallback is Cursor rather
than a different Antigravity model — a weaker replay is a judgement problem, and another model
behind the same vendor is the axis that does not address it.
