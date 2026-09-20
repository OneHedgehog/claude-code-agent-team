# Tasks: Routing Each Reviewer Role To Its Own Provider

**Input**: Design documents from `/specs/006-reviewer-provider-routing/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/model-client.md](./contracts/model-client.md),
[quickstart.md](./quickstart.md)

**Tests**: Included, and not optional here. Principle II makes the deterministic layers the system
under test, and FR-085 requires routing and failover to be exercisable end-to-end with scripted
providers alone.

**Organization**: Grouped into four stories. The spec states acceptance scenarios rather than
numbered user stories, so each story below is a coherent slice of those scenarios that can be
implemented and validated on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel — different files, no dependency on incomplete work
- **[Story]**: US1–US4
- Exact file paths in every description

## Path Conventions

Single project at the repository root: `src/`, `tests/unit/`, `tests/integration/`, `tests/e2e/`.
Existing test files are extended rather than replaced where one already covers the area.

## Scope change, 2026-09-20: Claude-only

**Antigravity is dropped. Phase 6 is not being built.** The operator's decision is to stay on one
model family for now.

**This means FR-077 is not satisfied, and will not be by this implementation.** The spec says "at
least one provider outside the model family used today MUST be supported"; no such provider is
shipping. SC-007 and model-level independence go with it, and FR-082's check — built and tested —
stays dormant, because declaring an `authoringProvider` when every reachable provider is the
authoring family would refuse every configuration there is.

**What survives is the half the record actually complained about.** `api` and `agent-sdk` are two
providers of one family on two *funding accounts* — the subscription the harness bills, and
metered API credits. Per R-029 that buys availability and not independence, and availability is
precisely what cost [#9](https://github.com/OneHedgehog/claude-code-agent-team/pull/9) two of its
nine rounds to a subscription session limit. A route of `[claude-subscription, claude-api]` fails
over on exactly that.

`spec.md`, `research.md`, `plan.md` and `data-model.md` are **not** rewritten (Principle IX): they
record what was intended and investigated at the time, and R-020's Antigravity findings remain
accurate and reusable if a second family is ever wanted. This file is the execution list, so this
is where the change is recorded.

## Mapping to the pull requests (Principle X)

| PR | Phases | Content |
|---|---|---|
| **PR 1a — routing, failover and declaration validation** | 1, 2, 3 | Types, settings shape, migration, **every invariant that validates a declaration**, routing composite, failure classification, scripted e2e. |
| **PR 1b — credential preflight and accounting** | 4, 5 | Per-provider credential verification, shared-account reporting, per-account budgets, per-provider attribution in the durable record. |

*PR 2 — the first non-Claude provider — is dropped with Phase 6 (see the scope change above).*

Three parts rather than the spec's two: the task breakdown put too many tasks across too many files
into the spec's first half to sit under Principle X's 400-line cap. Phase 7 items belong to
whichever PR they close, and Principle IX means each docs task ships **in its own PR**.

**Why every invariant ships in PR 1a, with the shape it validates.** An earlier arrangement put the
settings shape in PR 1a and its validation rules in PR 1b. That is a faked split in Principle X's
sense: PR 1a would have accepted an over-long route, a duplicate provider, a role with no route and
an unpinned model — all of which the spec's Edge Cases require to fail at preflight — and left them
unvalidated until the next pull request landed. A configuration surface and the rules that make it
safe are one coherent change.

**The residual gap, stated rather than hidden.** Per-provider *credential* verification (FR-084) is
still PR 1b. In PR 1a a route naming a provider whose credential is absent is a well-formed
declaration, so it passes preflight and surfaces as a `capacity` failure on first call: the route
advances, and an exhausted route fails the gate closed. That is degraded — it costs one attempt and
reports later than FR-084 wants — but it is safe, and it is the one thing PR 1a cannot do without
pulling the whole of Phase 4 forward.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: an isolated place to work, and the fixtures every later test reads

- [X] T001 Create the isolated checkout for this feature per Principle VIII, and confirm nothing else in flight writes the footprint declared in [plan.md](./plan.md#declared-footprint-principle-viii) — particularly `src/config/settings.ts` and `schemas/settings.schema.json`
- [X] T002 [P] Add settings fixtures in `tests/fixtures/settings/`: a legacy single-transport file, a valid two-provider route file, and the invalid files scenarios 39–41 and 46/46b need (over-long route, duplicate provider, role with no route, unpinned model, effort with no pinned model)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the types, the settings shape, **and every rule that validates that shape** — all of
which every story depends on, and none of which may ship apart from each other

**⚠️ CRITICAL**: no story work begins until this phase is complete

### Types

- [X] T003 Add `FailureClass`, `provider` on `ReviewResponse`, and `failureClass` + `provider` on `ModelError` in `src/model/client.ts` per [contracts/model-client.md](./contracts/model-client.md)
- [X] T004 Add `RouteExhaustedError` carrying per-attempt provider, failure class and usage in `src/model/client.ts` (depends on T003, same file)

### Settings shape and migration

- [X] T005 [P] Add `Provider`, `Account`, `Route`, `ContainmentDeclaration` and **per-account** limits to `src/config/settings.ts` per [data-model.md](./data-model.md)
- [X] T006 [P] Extend `schemas/settings.schema.json` with `providers`, `accounts`, `routes`, `authoringProvider`, per-**account** `budget`/`reserve`, and the `cli` transport value; record the new cross-field invariants in the existing `$comment`
- [X] T007 Implement the FR-081 migration in `src/config/settings.ts` — a legacy file's single transport and single budget become one synthesised account plus one provider drawing on it, with single-entry routes for every required role (depends on T005, T006)

### Tests for the invariants

> Write these first and confirm they fail before implementing.

- [X] T008 [P] Unit tests for route declaration rules — non-empty, no duplicate provider, every required role routed, every named provider declared — and for the FR-086 arithmetic invariant `route length × 300s ≤ maxQueueWaitSeconds`, in `tests/unit/config/invariants.test.ts`
- [X] T009 Unit tests for model pinning — an empty `models` map, a `family` that disagrees with a pinned model, and a configured `modelEffort` with no entry in `models` — all fail preflight, in `tests/unit/config/invariants.test.ts` (depends on T008, same file)
- [X] T010 [P] Unit tests for the FR-082 check comparing **model families** not vendor labels, including the R-021 aggregator case and the recorded-reason override, in `tests/unit/review/prerequisites.test.ts`

### The invariants themselves

- [X] T011 Implement the route declaration invariants in `src/config/settings.ts`, enforced in code immediately after schema validation alongside the existing cross-field checks (depends on T007, same file)
- [X] T012 Implement the FR-086 arithmetic invariant in `src/config/settings.ts` (depends on T011, same file)
- [X] T013 Reject a settings file declaring both `modelTransport` and `providers` in `src/config/settings.ts` — the alias is retained for migration only, and two descriptions of how a model is reached is one more than can be true (depends on T011, same file)
- [X] T014 Reject an empty `models` map, and a `family` that disagrees with any pinned model, in `src/config/settings.ts` — a vendor default is a family the FR-082 check never saw (R-021) (depends on T011, same file)
- [X] T015 Reject a configured `modelEffort` with no entry in a routed provider's `models` map, in `src/config/settings.ts` — effort is expressed by the pinned identifier (R-020), so an effort the declaration cannot serve must stop preflight rather than downgrade silently; FR-060 makes reporting an effort you do not apply worse than not reporting one (depends on T014, same file)
- [X] T016 Implement the FR-082 independence check on `family` in `src/review/prerequisites.ts`, with an override that requires a reason recorded in settings

### Doubles and observability

- [X] T017 [P] Extend `ScriptedModelClient` in `src/model/scripted.ts` to script a `FailureClass` per call, so failover scenarios need no real quota (FR-085)
- [X] T018 [P] Add `provider` and `failureClass` fields to the role events in `src/observability/logger.ts` and `schemas/review-record.schema.json`

**Checkpoint**: types, settings, every declaration rule and the scripted double are ready. No
configuration the schema accepts can now be invalid at runtime — stories can begin.

---

## Phase 3: User Story 1 — Failover on capacity, never on contract (Priority: P1) 🎯 MVP

**Goal**: a role's route advances on capacity failures and stops dead on contract failures,
producing exactly one verdict from exactly one named provider.

**Independent Test**: quickstart scenarios 30, 31, 32, 38, 42 and 43 pass with scripted providers
at the leaves and the routing composite real. No real vendor quota is touched.

### Tests for User Story 1

> Write these first and confirm they fail before implementing.

- [X] T019 [P] [US1] Unit tests for route advance, stop-on-contract, and exhaustion in `tests/unit/model/routing.test.ts`
- [X] T020 [P] [US1] Unit tests for the R-022 classification line — spawn failure, empty output, unreachable endpoint, deadline **and a credential that expires between preflight and the call** are `capacity`; schema miss, refused tool and absent verdict are `contract` — in `tests/unit/model/classification.test.ts`
- [ ] T021 [P] [US1] E2E scenarios 30–32 in `tests/e2e/routing.e2e.ts`
- [ ] T022 [US1] E2E scenarios 38 (bound expiry cancels and advances), 42 (credential expiring mid-call advances the route) and 43 (one route exhausted while the other role succeeded still fails closed) in `tests/e2e/routing.e2e.ts` (depends on T021, same file)

### Implementation for User Story 1

- [X] T023 [US1] Implement `RoutingModelClient` in `src/model/routing.ts` — select route by `request.role`, advance only on `capacity`, rethrow `contract` immediately, return the first response with `provider` set
- [X] T024 [US1] Add the per-attempt 300 s bound to `src/model/routing.ts`: cancel rather than abandon, charge the FR-067 spend floor, treat expiry as `capacity` (depends on T023, same file)
- [X] T025 [US1] Throw `RouteExhaustedError` naming every provider tried and its class, summing usage across attempts, in `src/model/routing.ts` (depends on T023, same file)
- [X] T026 [P] [US1] Classify failures in `src/model/anthropic.ts` per R-022
- [X] T027 [P] [US1] Classify failures in `src/model/agent-sdk.ts` per R-022, and change `DEADLINE_MS` from `15 * 60 * 1000` to `5 * 60 * 1000` (FR-086 supersedes FR-066's value)
- [X] T028 [US1] Assemble per-role routes in `src/composition.ts` and build the `RoutingModelClient` where the single client is built today
- [X] T029 [US1] Emit `provider` and `failureClass` on `role.started`, `role.verdict` and `role.verdict_missing` in `src/review/roles/role.ts`
- [X] T030 [US1] Report each role's resolved route in the effective-settings record via `settings.resolved` in `src/observability/logger.ts` and `schemas/review-record.schema.json` — FR-076 requires routes "reported as effective with each run (FR-054)", and a route nobody can read back is not reportable

**Checkpoint**: failover works end to end against scripted providers.

**What a legacy single-entry route does and does not keep.** Its settings file still loads, still
resolves to the same one provider, and still reports the same effective configuration (SC-005).
Its **timing changes**: T027 drops the bound from 15 minutes to 5, so a review that used to finish
at eight minutes now expires. FR-086 records that cost and states that it bites hardest on exactly
this single-provider path, where an expiry is a failed gate rather than a failover. "Behaves
exactly as before" would be the wrong claim and is not made here.

---

## Phase 4: User Story 2 — Credentials verified per provider before any spend (Priority: P2)

**Goal**: every provider a route names has its credential verified at startup, and a route whose
providers share a funding account is reported as the independent-but-not-resilient thing it is.

**Independent Test**: quickstart scenarios 34, 36, 37, 39, 40, 41, 44, 46, 46b, 47 and 48 pass, and
each asserts zero tokens spent.

### Tests for User Story 2

- [X] T031 [P] [US2] Unit tests for per-provider credential verification, covering a last-resort route entry as strictly as a first one, in `tests/unit/review/prerequisites.test.ts`
- [ ] T032 [US2] Integration tests for scenarios 34, 36, 37, 39, 40, 41, 44, 46, 46b, 47 and 48 in `tests/integration/composition.test.ts` (shared file — see "Files two stories write")

### Implementation for User Story 2

- [X] T033 [US2] Replace the single `modelCredential` with per-provider credential verification in `src/review/prerequisites.ts`, covering last-resort route entries as strictly as first ones (FR-084)
- [X] T034 [US2] Record when two providers in one route share an `account` in `src/review/prerequisites.ts`, so an independent-but-not-resilient route is reported rather than mistaken for SC-001 (R-029) (depends on T033, same file)
- [X] T035 [US2] Report per-provider prerequisite state in the run record via `prerequisites.verified` / `prerequisites.missing` in `src/observability/logger.ts`

**Checkpoint**: no unreachable configuration can reach a model call

---

## Phase 5: User Story 3 — Spend attributed per provider, budgeted per account (Priority: P3)

**Goal**: every ledger entry carries its provider **and its account**, budgets and reserves sit on
the account, and the attribution reaches the durable record rather than only the host log.

**Independent Test**: quickstart scenarios 33, 35, 45 and **49** pass. Scenario 49 — two providers
on one account whose combined draw crosses that account's reserve — is the case account-level
budgeting exists for, so it is a checkpoint criterion rather than a unit test alone.

### Tests for User Story 3

- [X] T036 [P] [US3] Unit tests for per-account budget and reserve checks, with `review` the only actor permitted into an account's reserve, including two providers sharing one account drawing on one limit, in `tests/unit/ledger/tokens.test.ts`
- [X] T037 [US3] Unit test for R-024 — pre-feature entries carrying no provider are attributed to the migrated single provider — in `tests/unit/ledger/tokens.test.ts` (depends on T036, same file)
- [ ] T038 [P] [US3] Unit tests for parsing per-provider spend back out of check-run output in `tests/unit/ledger/reconstruct.test.ts`
- [ ] T039 [US3] Integration tests for scenarios 33, 35, 45 and 49 in `tests/integration/composition.test.ts` (shared file — see "Files two stories write")

### Implementation for User Story 3

- [X] T040 [US3] Add required `provider` **and `account`** to `LedgerEntry` and replace flat `tokenBudget`/`reviewerTokenReserve` with **per-account** limits in `src/ledger/tokens.ts`; the reserve is checked against the account, attribution stays at the provider (FR-081); leave `platformApiBudget`/`platformApiReserve` unchanged — GitHub requests remain one resource
- [X] T041 [US3] Attribute legacy entries lacking `provider`/`account` to the migrated provider and account in `src/ledger/tokens.ts` (depends on T040, same file)
- [ ] T042 [US3] Write one spend line per provider, with its failure class where it failed, into the check-run output in `src/github/check-run.ts` (FR-079, R-025)
- [ ] T043 [US3] Parse the per-provider spend lines in `src/ledger/reconstruct.ts` so the rebuilt totals match the cache (depends on T042)
- [ ] T044 [US3] Emit remaining budget **per account** and spend **per provider** on `budget.checked` and `budget.reported` in `src/observability/logger.ts`, so an account approaching exhaustion is visible before it stops a review (SC-003)

**Checkpoint**: PR 1b is functionally complete

---

## Phase 6: User Story 4 — dropped

**Not being built.** T045–T056 added Antigravity as a second model family. The scope change at the
top of this file removes it, and with it FR-077, SC-007 and any model-level independence.

Nothing in Phases 1–5 depended on it: the routing seam, the failure classification, the
declaration invariants and the per-account accounting are all provider-agnostic, which is what
makes dropping a provider a deletion rather than a rewrite. R-020's verified findings about
driving `agy` headless stay in `research.md` for whenever a second family is wanted.

## Phase 7: Docs, Validation & Cross-Cutting Concerns

Principle IX: each docs task ships **in its own PR**, not after it.

- [X] T057 Update `docs/independent-review-service.md` for routes, failure classification and the declaration invariants — ships in **PR 1a**
- [X] T058 Update `docs/independent-review-service.md` for per-provider credential preflight, per-account budgets and per-provider attribution — ships in **PR 1b**
- [X] T059 ~~Update the doc for the Antigravity provider~~ — dropped with Phase 6
- [ ] T060 Verify SC-006 by inspection rather than against a second provider's diff: the routing seam touches no reviewer role, no gate, and neither `buildReviewPrompt` nor `parseReviewResponse`. The claim SC-006 makes — that adding a provider later needs only a declaration — is now *unproven* rather than demonstrated, since no provider was added; record it that way in `docs/independent-review-service.md`
- [ ] T061 [P] Regenerate the statechart with `npm run diagram` and confirm `npm run diagram:check` passes if any state changed
- [ ] T062 Run `npm run check`, then `npm run test:e2e` against the live fixture
- [ ] T063 Walk quickstart scenarios 30–49, including 46b, and tick each one off in [quickstart.md](./quickstart.md), marking the Antigravity-specific ones not applicable
- [ ] T064 Confirm each of the two remaining pull requests is under the `maxPullRequestSize` declared in `.agents/settings.json` (the schema carries only the default). If PR 1a alone exceeds it, split at the Phase 2 / Phase 3 line — the settings shape and its invariants travel together, so that is the only cut that does not fake the split

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup — **blocks every story**
- **US1 (Phase 3)**: depends on Foundational
- **US2 (Phase 4)**: depends on Foundational. Independent of US1 — it verifies credentials and never calls a model
- **US3 (Phase 5)**: depends on Foundational. Independent of US1 and US2
- **US4 (Phase 6)**: dropped
- **Phase 7**: per PR, as marked

### Within Each Story

- Tests written and failing before implementation
- Types before services; services before composition wiring
- Same-file tasks are sequential even where their stories are parallel

### Files two stories write

Principle VIII requires footprints to be declared before scheduling, and two of these files are
written by more than one story. They are named here rather than left for the merge to discover:

| File | Written by | Consequence |
|---|---|---|
| `src/observability/logger.ts` | T030 (US1), T035 (US2), T044 (US3) | the three tasks serialize against each other, whichever order the stories run in |
| `tests/integration/composition.test.ts` | T032 (US2), T039 (US3) | same — and neither carries `[P]` for that reason |

Everything else is disjoint. `src/config/settings.ts` is written only in Phase 2, and
`src/ledger/tokens.ts` only by US3.

### Parallel Opportunities

- T005, T006 in Foundational — two different files; T017 and T018 likewise, once the types land
- **US1, US2 and US3 can run in parallel once Phase 2 completes**, with the two shared files above
  serialized between them
- Test tasks marked `[P]` within a story
- T026 and T027 — two different transport files

### The serialization that is not optional

Principle VIII: anything else writing `src/config/settings.ts` or `schemas/settings.schema.json` —
notably the escalation-channel work — runs serialized against this feature, not beside it.

---

## Parallel Example: after Phase 2

```bash
# Three stories, three checkouts, disjoint footprints apart from the two shared files:
Story US1: "Implement RoutingModelClient in src/model/routing.ts"
Story US2: "Per-provider credential verification in src/review/prerequisites.ts"
Story US3: "Provider + account on LedgerEntry and per-account limits in src/ledger/tokens.ts"
```

Bounded by `host.maxConcurrentAgents`, which defaults to **2** and counts every CI and reviewer job
on the same host. Maximum parallelism is not the goal.

---

## Implementation Strategy

### MVP (US1 only)

1. Phase 1 → Phase 2 → Phase 3
2. **Stop and validate**: scenarios 30, 31, 32, 38, 42, 43 pass with scripted providers
3. A legacy single-entry route still loads, resolves and reports identically — with the timing
   change T027 makes, which is deliberate and recorded in FR-086

At this point failover is real but no second provider exists, so nothing observable changes on the
target beyond the shorter bound. That is intended — the seam ships first precisely so PR 2 is small.

### Incremental delivery

1. Setup + Foundational → shape and rules ready together
2. US1 → failover demonstrable → **PR 1a ships**
3. US2 → no unreachable configuration can reach a model call
4. US3 → spend legible per account → **PR 1b ships**, and the feature is complete under this scope

### What is still not true after US3

**There is no model-level independence, and there will not be under this scope.** Every provider
is the family that authored the diff. FR-077 is unmet, SC-007 is unmet, and FR-082 is dormant for
want of a subject. A reviewer drawing on the model that wrote the code is independent in identity
— the GitHub App is still a separate actor — and not in judgement.

**Availability is real but bounded by what the accounts hold.** A subscription session limit now
fails over to metered credits, which is the #9 failure fixed. It fails over *to a balance that
[spec 003](../003-subscription-backed-transport/spec.md) records as having run out once already*,
so the second entry in that route is worth exactly what is in the account behind it.

---

## Notes

- `[P]` means a different file and no dependency on incomplete work
- Verify tests fail before implementing
- Commit after each task or logical group
- Every task traces to a requirement in [spec.md](./spec.md) or a decision in [research.md](./research.md); a line that traces to neither does not belong in the diff (Principle X)
