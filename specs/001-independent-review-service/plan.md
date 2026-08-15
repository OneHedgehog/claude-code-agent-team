# Implementation Plan: Independent Review Service

**Branch**: `001-independent-review-service` | **Date**: 2026-08-14 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-independent-review-service/spec.md`

## Summary

A GitHub App plus a GitHub Actions workflow that reviews every pull request in an explicitly named
target repository and gates its merge. Two reviewer roles — security and implementation — read the
diff, post line-anchored findings carrying severity and an explicit blocking status, and each conclude
with a stated verdict. A **check run**, which only a GitHub App can create, carries the combined
outcome; branch protection makes it required. Every push invalidates prior approvals and triggers a
fresh review; each round reconciles the service's own prior findings rather than reposting them.

The service runs on a self-hosted runner so model credentials stay in the local environment, keeps the
model call behind a substitutable interface so end-to-end tests drive the whole flow with a scripted
double, meters both model tokens and platform API requests against version-controlled budgets, and
fails the gate — never neutral, never skipped — whenever it cannot complete a review.

Because the repository has **no commits yet**, this feature's pull request also establishes the
Principle V baseline: toolchain, lint, format, type checks, test runner, an executable e2e harness, and
CI. That is the one deliberate scope expansion, justified in Complexity Tracking below.

## Technical Context

**Language/Version**: TypeScript 5.x, strict mode, on Node.js 24 LTS (pinned by `.nvmrc` and `engines`)

**Primary Dependencies**: `@octokit/app`, `@octokit/rest`, `@octokit/graphql` with the `throttling` and
`retry` plugins (platform); `xstate` v5 (declared control flow, Principle VII); `@anthropic-ai/sdk`
(model boundary, behind `ModelClient`); `ajv` (settings and record schema validation); `vitest`
(test runner). No logging framework — see [research.md](research.md) R-014.

**Storage**: Append-only JSONL budget ledger on the runner host, treated as a cache; the authoritative
total is reconstructible from check-run outputs on GitHub (Principle VII, FR-038). No database.

**Testing**: Vitest across three separated layers — unit and integration (no model, no network), and
end-to-end against a real private fixture repository with only the model boundary substituted
(Principle II, [research.md](research.md) R-015).

**Target Platform**: Self-hosted GitHub Actions runner on a developer machine (macOS/Linux)

**Project Type**: Single TypeScript project — a CLI invoked by a workflow

**Performance Goals**: A review of a diff up to 1,000 changed lines concludes within 10 minutes on the
developer machine (SC-013)

**Constraints**: $0 infrastructure; no cloud account; model spend metered against a cumulative
repository-wide budget with a reviewer reserve; platform API usage bounded by GitHub's secondary limit
of 80 content-creating requests per minute and 500 per hour, which is the binding ceiling
([research.md](research.md) R-007)

**Scale/Scope**: Exactly one target repository in version one, addressed by parameter rather than
assumed; two reviewer roles; 54 functional requirements; 24 success criteria

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| I — Spec-Driven, Feature-Sized Merges | Traces to a spec; one branch, one pull request, squash-merged | **Pass** |
| II — Test-First, E2E-Complete | Three layers separated; model boundary substitutable; e2e asserts on states/comments/verdicts/gate only | **Pass** — FR-029/FR-030, [contracts/model-client.md](contracts/model-client.md), R-015 |
| III — Language Boundaries | TypeScript only; no ML or data work in this feature; schema contracts at every boundary | **Pass** |
| IV — Local-First, Zero-Cost | Runs entirely on the developer machine; $0 infrastructure; both metered resources have budgets and reserves checked before spend; no degraded gate substituted for an unavailable one | **Pass** — FR-031/FR-040/FR-047, R-007, R-010 |
| V — Bounded Autonomy | No pushes to `main`; no secrets in the repository; **starting-line clause is why the baseline ships here**, human-approved. **Structural containment**: the reviewer holds no write capability on repository contents beyond `resolveReviewThread`, cannot merge, and cannot alter branch protection — those are structural, from the installation's permission set (see [contracts/github-surface.md](contracts/github-surface.md)), not from the reviewer's own compliance. Process-level confinement — filesystem scope, per-agent CPU and memory limits, restricted egress — is **deferred**, not satisfied, per the constitution's own requirement that the sandboxing runtime be settled by a file-I/O spike before adoption | **Pass with two notes** — see Complexity Tracking |
| VI — Independent Review Gates Every Merge | The feature *is* this gate; the one-time bootstrap exception is recorded in the spec | **Pass under the recorded exception** |
| VII — Traceable and Observable Runs | Control flow is a declared XState machine with a generated diagram; every record carries a run identifier; state reconstructible from GitHub; escalation always notifies | **Pass** — R-009, R-010, R-014, FR-033/FR-034/FR-035 |
| VIII — Isolated Parallel Execution | Reviewer jobs take an ordinary slot in the host-wide cap; no exemption; task footprints declared at `/speckit-tasks` | **Pass** — FR-041, R-013 |
| IX — Documentation Ships With The Feature | `docs/independent-review-service.md` ships in this pull request, including the generated statechart diagram | **Pass** — planned deliverable |
| X — Minimal Pull Requests | The feature enforces Principle X (FR-042/FR-043); its own pull request exceeds the cap | **Justified** — see Complexity Tracking |

**Post-Phase-1 re-check**: no new violations. The design introduces five runtime dependencies, each
justified in [research.md](research.md); the two that could have been avoided (a logging framework, a
database) were rejected in favour of ~40 lines of code and a JSONL file respectively.

Two least-privilege tensions are recorded rather than hidden
([contracts/github-surface.md](contracts/github-surface.md)):

- Resolving a review thread requires `contents: write` on the installation, wider than the rest of the
  feature needs. FR-039 is otherwise unimplementable — review threads are not exposed in the REST API
  at all.
- Verifying that the merge gate is a required check requires `administration: read`. FR-051 accepts
  this as the price of the check being possible at all; the corresponding **write** is precisely what
  the installation must never hold, since an identity that can change branch protection can remove
  the gate.

## Project Structure

### Documentation (this feature)

```text
specs/001-independent-review-service/
├── plan.md              # This file
├── research.md          # Phase 0 — 15 decisions with rationale and rejected alternatives
├── data-model.md        # Phase 1 — entities, fields, lifecycles, the statechart
├── quickstart.md        # Phase 1 — setup, commands, 29 validation scenarios
├── contracts/           # Phase 1
│   ├── settings.schema.json     # Operating settings (FR-028)
│   ├── model-client.md          # The substitutable boundary (FR-029)
│   ├── github-surface.md        # Every platform call, identity, permission
│   └── review-record.schema.json # Structured log records (FR-033)
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── cli.ts                    # Entry point; parses --target, --checkout, --pull-request
├── config/
│   ├── settings.ts           # Load + validate against the schema; no defaults in code
│   └── target.ts             # Resolve every path through the target parameter (FR-026)
├── model/
│   ├── client.ts             # ModelClient interface
│   ├── anthropic.ts          # Production adapter
│   └── scripted.ts           # Test double
├── github/
│   ├── auth.ts               # App JWT → installation token
│   ├── pull-request.ts       # Read PR, author, head SHA, diff
│   ├── check-run.ts          # Create/update the merge gate; per-run outputs
│   ├── branch-protection.ts  # Read protection; is the gate required? (FR-051)
│   ├── reviews.ts            # Post findings + verdicts
│   ├── threads.ts            # GraphQL: read threads, resolve own findings
│   └── rate-limit.ts         # Budget, reserve, wait-for-reset
├── review/
│   ├── machine.ts            # XState declaration — the single source of control flow
│   ├── roles/
│   │   ├── security.ts
│   │   └── implementation.ts # Composes the rules below (FR-016, FR-042, FR-043)
│   ├── rules/
│   │   ├── docs.ts           # Missing tests, missing or stale document (FR-016)
│   │   ├── minimality.ts     # Content no spec asked for (FR-042)
│   │   ├── size.ts           # maxPullRequestSize + justification escape (FR-043)
│   │   ├── reviewable-size.ts# maxReviewableDiffSize pre-spend gate (FR-037)
│   │   └── empty-diff.ts     # Empty or whitespace-only refusal (FR-052)
│   ├── prerequisites.ts      # Permissions + branch protection at startup (FR-051)
│   ├── excluded-paths.ts     # git-binary + declared patterns, never inferred (FR-053)
│   ├── findings.ts           # Fingerprints, severity → blocking
│   ├── locations.ts          # Diff-location resolution, PR-level fallback (FR-010, FR-014)
│   ├── reconcile.ts          # Resolve fixed, leave standing, add new (FR-039)
│   ├── replies.ts            # Judge justifications; raise waiver requests (FR-044)
│   ├── progress.ts           # Forward-progress and round-cap checks (FR-020, FR-046)
│   ├── round-history.ts      # Prior concluded rounds, read from check runs (FR-046)
│   ├── precedence.ts         # Role precedence and contradiction handling (FR-048, FR-049)
│   ├── self-review.ts        # Self-authored refusal (FR-004)
│   ├── queue.ts              # Queue-wait measurement and threshold (FR-041)
│   └── gate.ts               # Verdict aggregation → gate conclusion (FR-021)
├── ledger/
│   ├── tokens.ts             # Cumulative total, reviewer reserve, pre-spend check
│   └── reconstruct.ts        # Rebuild the total from check-run outputs
└── observability/
    ├── logger.ts             # JSON lines, run identifier, redaction
    └── escalate.ts           # Configured channel + statement on the pull request

tests/
├── unit/                     # No model, no network
├── integration/              # Real schemas, real statechart, stubbed platform edges
└── e2e/                      # Real GitHub fixture repo; only ModelClient substituted

scripts/
└── generate-diagram.ts       # Statechart → diagram, wired into `check` (Principle VII)

.github/workflows/
├── review.yml                # The reviewer itself (pull_request, self-hosted)
└── ci.yml                    # Lint, format, types, unit, integration

schemas/                      # Published copies of the contract schemas
docs/
└── independent-review-service.md   # Principle IX; includes the generated statechart
```

**Structure Decision**: A single TypeScript project. There is no frontend, no service to deploy, and
no Python — the deliverable is a CLI that a workflow invokes. Directories follow the seams the spec
already draws (configuration, platform, model, review logic, ledger, observability), so that the
places most likely to change independently — the model adapter, the escalation channel, a future
reviewer role — are each behind one boundary.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Pull request exceeds `maxPullRequestSize` (Principle X) | The repository has zero commits. Principle V requires a baseline — toolchain, lint, format, types, tests, e2e harness, green CI — on `main` before the loop may start, and forbids the loop from creating the gates that judge it. This pull request is the human-supervised moment that clause describes, and a reviewer cannot ship without a toolchain to build it. | Splitting scaffolding into its own earlier pull request produces a `main` that delivers no feature and that Principle I would judge as not independently shippable; splitting the reviewer into stacked halves would leave `main` with a gate that reports but does not review — worse than no gate, per Principle IV. The pull request description will state this irreducibility, which is exactly the escape FR-043 defines. |
| Installation holds `contents: write` | Resolving a review thread — FR-039's reconciliation — is available only through the GraphQL `resolveReviewThread` mutation, which requires repository contents read **and** write. | Leaving findings unresolved across rounds was rejected by the spec's clarification: an unreconciled thread grows without bound and makes the comment history unreadable. No REST equivalent exists — review threads are not exposed there at all. |
| Installation holds `administration: read` | FR-051 requires verifying that the merge gate is a required check before reviewing, and branch protection is readable only under this permission. A gate nothing enforces is the one failure that leaves the service looking healthy while doing nothing. | Trusting that a human configured branch protection correctly was rejected by the clarification that added FR-051 — it is the quietest failure in the system, and one read makes it loud. Configuring branch protection instead of verifying it was rejected outright: it needs the corresponding **write**, which would let the service remove its own gate. |
| Process-level containment deferred (Principle V) | Principle V requires filesystem scope, per-agent CPU and memory limits, and restricted egress to be enforced by the execution environment. This feature ships none of them. The constitution's own Technology section requires the sandboxing runtime — and the isolated-checkout mechanism it forces — to be settled by a file-I/O spike on the host platform *before* adoption, and that spike is not this feature. | Adopting a container runtime here was rejected: it prejudges the spike the constitution requires, and Principle IV's YAGNI-for-infrastructure clause applies hardest to exactly this kind of component. What is **not** deferred is the part achievable through permissions: the reviewing identity structurally cannot merge, cannot push, and cannot alter branch protection, so the highest-blast-radius actions are already out of reach rather than left to the agent's compliance. Recorded here so the gap is visible rather than assumed closed. |
| Five runtime dependencies | Octokit (App auth and rate-limit signals), XState (Principle VII's declared control flow), the Anthropic SDK (model boundary), Ajv (machine-checkable contracts per Principle III), Vitest (the baseline's test runner). | Hand-rolling App token exchange and rate-limit accounting puts a silent, security-sensitive bug in the two places that matter most; hand-rolled control flow is prohibited outright by Principle VII. Where a dependency was avoidable it was avoided — the logger is ~40 lines and the ledger is a file. |
