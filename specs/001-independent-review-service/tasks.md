# Tasks: Independent Review Service

**Input**: Design documents from `/specs/001-independent-review-service/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

## Implementation status (as of 2026-08-28)

**136 of 136 tasks complete.** Every phase, every e2e scenario, and the two closing tasks.
`npm run check` is green — build, lint, format, types, the diagram check, 648 unit tests, 88
integration tests — and `npm run test:e2e` is green against the live fixture: 21 files, 48 tests,
covering all 29 quickstart validation scenarios plus SC-013.

**Phases 11 and 12 are complete.** The service can now be started: `src/composition.ts` is the one
place concrete adapters are constructed, `src/daemon.ts` is the reconciling trigger, `src/cli.ts`
reviews one named pull request by hand, `src/worktree.ts` provisions a checkout without executing
anything it contains, and `src/host-lease.ts` enforces the host-wide agent cap on the filesystem
where every agent can see it. `.github/workflows/review.yml` is deleted (T130).

Verified 2026-08-24: `node dist/daemon.js --target OneHedgehog/claude-code-agent-team --checkout
$PWD` authenticates the App, discovers its installation, lists the open pull requests, and selects
nothing — which is correct, because there are none.

**T032 is done, and the fixture is fully configured (2026-08-28).** The harness under
`tests/e2e/harness/` composes the real service against the fixture with `ScriptedModelClient` as the
only substitution. `npm run test:e2e` passes 7/7: a pull request opened as the authoring identity, a
real review run against it, the gate reported by the App and read back, a gate report from the
authoring identity refused `403`, review threads and escalation issues read, a revision pushed, and
teardown verified.

**The e2e suite is complete (2026-08-28).** `independent-review` is a required check on the
fixture's `main`, and `unprotected-base` remains deliberately unprotected for scenario 26. All 29
validation scenarios were run against the fixture and pass; the per-scenario record is in
[docs/independent-review-service.md](../../docs/independent-review-service.md#validation-scenarios),
because the document records what is true now and this file records what was intended
(Principle IX).

**Running them changed the code three times, which is the argument for the layer.** Scenario 18
(T103) found a real defect: the self-review refusal compared a pull request's author against the
*repository's* name rather than the App's own login, so FR-004's check silently never fired and the
service reviewed a pull request it had authored itself. Scenario 17 (T090) found FR-040's
pause-and-resume had a module and a settings pair that nothing ever called. Scenario 25 (T091) found
FR-041's queue wait was re-stamped every tick, so its configured maximum was unreachable however
saturated the host. Each is fixed and pinned at a cheaper layer as well as end to end.

**Amended 2026-08-20 — deployment topology.** [research.md](research.md) R-017 supersedes R-013: the
service is a local reconciling process, not a workflow on a self-hosted runner. See
[Phase 11](#phase-11-deployment-topology-r-017) for the nine tasks this adds, T122–T130 — two of
which close a gap that predates the amendment: nothing in Phases 1–10 ever built a composition root.

**Amended again 2026-08-20 — cross-artifact analysis.** Analysing that amendment against the spec
found that R-017's trigger could not reach FR-044, FR-045 or FR-046, and that its concurrency cap did
not satisfy FR-041 or Principle VIII. [research.md](research.md) R-018 and R-019 correct both. T124
and T128 are amended in place; [Phase 12](#phase-12-cross-artifact-analysis-remediation) carries the
six tasks that remain, T131–T136. **T132 is a new prerequisite of T128** — the daemon cannot take a
host lease that does not exist.

Task IDs are never reused, renumbered, or deleted — they are cited from commit messages and code
comments, and Principle VII's traceability depends on them resolving. A task whose artifact a later
task removes stays `[X]` and is annotated, because it *was* done; see T101.

**Nothing is blocked.** The table below is kept as the record of what was blocked and when it
cleared, not as a list of outstanding work.

| Blocked | Tasks | Why |
|---|---|---|
| ~~**Every `tests/e2e/**` scenario**~~ | ~~T035–T037, T049–T050, T059–T062, T070–T072, T084–T091, T103, T108–T110, T116, T119, T121~~ (27) | **Unblocked 2026-08-28.** The fixture's `main` now requires `independent-review`; the harness (T032) passes 7/7 against it. These are ordinary work now, held only by the exclusive-resource rule below. |
| ~~**T120**~~ | ~~T120~~ | **Written 2026-08-28.** The description states the irreducibility justification Principle X requires, the spec and traceability links, and why `.mcp.json` rides along despite tracing to no spec. |
| ~~**The merge gate**~~ | ~~T092, T093~~ | **Resolved 2026-08-18.** The target repository is public, `/branches/main/protection` reaches the feature, and both tasks are complete. Configuring the gate remains a human step. |

~~The 9 tasks of Phase 11 and the 4 open tasks of Phase 12 are unblocked and are the critical
path~~ — **all complete 2026-08-24.** The critical path is now entirely outside the code: the
fixture repository, and branch protection on the target's default branch.

---

**Tests**: **Required, not optional.** Principle II is NON-NEGOTIABLE: tests are written before
implementation and MUST be observed failing before the code that satisfies them is written. Every
implementation task below is preceded, by a lower task ID within the same phase, by at least one test
task covering it. A test task is not complete until its failure has been observed.

**Organization**: Tasks are grouped by user story so each story is independently implementable and
testable. Every task declares its file footprint in the description; exclusive resources and
serialization points are declared per phase (Principle VIII).

## Format: `[ID] [P?] [Story] Description (FR refs)`

- **[P]**: Parallel-safe — disjoint file footprint, no dependency on an incomplete task
- **[Story]**: US1–US7, mapping to the user stories in [spec.md](spec.md)
- Every description carries its exact file path and the requirements it satisfies

## Execution model (Principle VIII)

Each task runs on its own task branch in its own isolated checkout cut from the feature branch head,
passes lint, format, type checks, and its own tests inside that checkout, then rebases and merges into
the feature branch; the checkout is removed afterwards. **An undeclared footprint is treated as
conflicting with everything and runs alone.**

**Exclusive resources** — held by at most one task at a time:

| Resource | Needed by | Why |
|---|---|---|
| `fixture-repo` ([`OneHedgehog/fixture-repo-ad`](https://github.com/OneHedgehog/fixture-repo-ad), public) | Every `tests/e2e/**` task | Concurrent runs would collide on pull request state |
| `github-quota` (installation API allowance) | Every `tests/e2e/**` task | Shared secondary rate limit, 500 content-creating requests/hour |
| `review-slot` | Every `tests/e2e/**` task | Takes a lease from the host-wide cap like any agent job (R-019). Named `runner-slot` before R-017; there is no runner |

E2E tasks are therefore **never** marked `[P]` with each other, regardless of file footprint.

## Human prerequisites (out-of-band, not agent tasks)

The spec places these outside its own scope — an identity that can provision itself or write its own
branch protection can remove its own gate. They are listed here because they gate real tasks.

**Status as of 2026-08-20**: the target repository exists and is public, `origin` is wired, the App
is created and installed, and the model credential resolves from an `ant auth login` profile. What
remains outstanding is the **fixture repository** and **branch protection on the target's default
branch** — which is why every `tests/e2e/**` task is still blocked while nothing else is.

**Amended 2026-08-27.** The fixture repository exists, is public, is seeded, has the App installed,
and carries both base branches. Visibility is settled — public, because branch protection is
unavailable on a private repository on GitHub Free, and most scenarios need the gate to *be*
required; every "private fixture" in the artefacts was corrected to match. **Complete as of 2026-08-28.** `independent-review` is a required status check on the fixture's
`main`, and T032's smoke check was observed passing against it. No human prerequisite now blocks
any task.

| Prerequisite | Blocks | Notes |
|---|---|---|
| ~~Target repository created on GitHub~~ | ~~T010 and every push~~ | **Done.** Public, `origin` wired over SSH |
| ~~**Fixture repository** created, seeded, App installed, branches in place, **gate required**~~ | ~~T032 and every `tests/e2e/**` task~~ | **Done in full 2026-08-28**: [`OneHedgehog/fixture-repo-ad`](https://github.com/OneHedgehog/fixture-repo-ad), public, seeded, installation `155031737`, branches `main` and `unprotected-base`, and `main`'s `required_status_checks.contexts` now carries `independent-review` (prerequisite 6d). Cannot be the target repo: scenario 26 needs a branch where the gate is deliberately not required ([quickstart.md](quickstart.md) line 23, R-015) |
| ~~**GitHub App created and installed**~~ on the target, permission set per [contracts/github-surface.md](contracts/github-surface.md), private key on the developer machine | Every `tests/e2e/**` task | **Done for the target 2026-08-18**; the *fixture* installation waits on the fixture repository existing. Only a GitHub App can create a check run; no PAT can substitute at any scope |
| Branch protection on the target's default branch requiring the gate | Real operation, and T084's negative case | The service verifies this (FR-051) and never writes it. **Partially done 2026-08-24**: `main` is protected, but `required_status_checks` is empty, so `independent-review` is still not required |
| ~~Self-hosted runner registered~~ | ~~T101~~ | **Removed 2026-08-20 (R-017).** No Actions runner is registered. The host-wide cap is `host.maxConcurrentAgents`, enforced by the lease T132 builds and configured in settings by T128 (R-019) — configuration, not a human prerequisite |
| Model credential on the developer machine, never in Actions secrets — an `ant auth login` profile under `~/.config/anthropic/` (preferred) or `ANTHROPIC_API_KEY` in the environment or keychain | Production runs only — e2e uses the scripted double | FR-032, and the 2026-08-17 spec addendum |
| Authoring PAT, fine-grained, scoped to the two repositories, **no Checks and no Administration on the target** | Agent-driven pushes | Administration write on the *fixture* is legitimate — its protection state is the test fixture |

**Everything through T031 needs none of these.** Phases 1 and 2 are local TypeScript plus one push,
so the Principle V baseline can be built and landed before the App or the fixture repository exists.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the Principle V baseline this feature is required to carry — see
[plan.md](plan.md) Complexity Tracking and [research.md](research.md) R-001 — plus the
version-controlled settings the service reads and the remote it is addressed against.

- [X] T001 Create `package.json` with `engines.node` pinned to Node 24 LTS, and `.nvmrc` at repository root
- [X] T002 [P] Configure TypeScript strict mode in `tsconfig.json` (no implicit any, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- [X] T003 [P] Configure ESLint and Prettier in `eslint.config.js` and `.prettierrc`, with a rule requiring an inline justification comment on any `any` (Principle III)
- [X] T004 [P] Configure Vitest with three separate projects (unit, integration, e2e) in `vitest.config.ts` (Principle II)
- [X] T005 Add npm scripts to `package.json`: `build`, `lint`, `format:check`, `typecheck`, `test:unit`, `test:integration`, `test:e2e`, and `check` composing the first six — depends on T001
- [X] T006 [P] Add `.gitignore` and `.editorconfig` at repository root — `.gitignore` is what keeps build output out of every diff, which is why FR-053 needs no generated-file detector; decide there whether `.mcp.json` is tracked or ignored (see Notes)
- [X] T007 Create CI workflow in `.github/workflows/ci.yml` running exactly the `check` script — no CI-only steps
- [X] T008 [P] Publish contract schema copies to `schemas/settings.schema.json` and `schemas/review-record.schema.json`
- [X] T009 [P] Create this repository's own operating settings at `.agents/settings.json` — a `reviewService` section carrying every required key in [contracts/settings.schema.json](contracts/settings.schema.json), so the target repository the service ships against actually has the settings FR-028 requires (FR-028, FR-050)
- [X] T010 Add the GitHub remote as `origin` in `.git/config` and confirm the `--target owner/name` the workflow passes matches it — the service resolves everything through that parameter and never through the working directory (FR-026, FR-027)

**Footprints**: T001 and T005 both write `package.json` and MUST be serialized. T002, T003, T004,
T006, T008, T009 have disjoint footprints. T007 and T010 touch `.github/` and `.git/config`
respectively. No exclusive resources in this phase.

**Checkpoint**: `npm run check` runs and passes on an empty source tree, `.agents/settings.json`
validates against the published schema, and the baseline can be pushed to a feature branch — never
directly to `main`, whose establishing commit a human approves (Principle V starting line).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The boundaries every user story depends on — configuration, observability, the model
interface, platform auth, the ledger, the statechart shell, the CLI, and the end-to-end harness every
e2e task drives.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

### Tests (write first, observe failing)

- [X] T011 [P] Unit tests for the JSON-lines logger and credential redaction in `tests/unit/observability/logger.test.ts` (FR-032, FR-033)
- [X] T012 [P] Unit tests for target-repository path resolution, including escape rejection and the absence of any `process.cwd()` fallback, in `tests/unit/config/target.test.ts` (FR-026, FR-027)
- [X] T013 [P] Unit tests for namespaced settings loading in `tests/unit/config/settings.test.ts`: every missing required key rejected; an unrecognized key **inside** `reviewService` stops the run; a sibling agent's section is ignored rather than rejected; an absent optional setting is filled from the documented default and its effective value reported (FR-028, FR-050, FR-054)
- [X] T014 [P] Unit tests for the cross-field settings invariants — `reviewerTokenReserve < tokenBudget`, `platformApiReserve < platformApiBudget`, `maxReviewableDiffSize > maxPullRequestSize` — each stopping the run like a missing required key, in `tests/unit/config/invariants.test.ts` ([data-model.md](data-model.md) OperatingSettings)
- [X] T015 [P] Unit tests for the token ledger — pre-spend check, reviewer reserve, cumulative total, the `check`/`record` addressing interface — in `tests/unit/ledger/tokens.test.ts` (FR-031, FR-038, FR-047)
- [X] T016 [P] Unit tests for reconstructing the cumulative total from check-run outputs, including the local-versus-remote mismatch escalation, in `tests/unit/ledger/reconstruct.test.ts` (FR-038)
- [X] T017 [P] Unit tests for rate-limit accounting, reserve detection, `retry-after` honoring, and reset waiting in `tests/unit/github/rate-limit.test.ts` (FR-040)
- [X] T018 [P] Unit tests for App JWT to installation-token exchange and for parsing the granted `permissions` the FR-051 check compares against, in `tests/unit/github/auth.test.ts` (FR-002, FR-003)
- [X] T019 [P] Unit tests for CLI argument parsing in `tests/unit/cli.test.ts`, including that a missing `--target` stops with an error rather than defaulting to the working directory (FR-026, FR-027)
- [X] T020 [P] Integration test asserting the statechart declares every state and guard in [data-model.md](data-model.md) — including `checkingPrerequisites` and the empty-diff exit — in `tests/integration/review/machine.test.ts` (Principle VII, FR-051, FR-052)

### Implementation

- [X] T021 [P] Implement the JSON-lines logger with `runId` and single-point redaction in `src/observability/logger.ts` (FR-032, FR-033)
- [X] T022 [P] Implement target-repository resolution — all paths through the parameter, no `process.cwd()` fallback — in `src/config/target.ts` (FR-026, FR-027)
- [X] T023 Implement settings loading in `src/config/settings.ts`: Ajv validation of the `reviewService` section strictly, sibling sections ignored, required/optional split with documented defaults applied to optional keys only, cross-field invariants checked in code, no in-code defaults for required keys (FR-028, FR-050, FR-054) — depends on T008, T022
- [X] T024 [P] Define the `ModelClient` interface and request/response types in `src/model/client.ts` per [contracts/model-client.md](contracts/model-client.md) (FR-029)
- [X] T025 [P] Implement `ScriptedModelClient`, recording received requests for assertion, in `src/model/scripted.ts` (FR-029, FR-030)
- [X] T026 [P] Implement GitHub App JWT to installation-token exchange, exposing the granted `permissions` from the token response for the FR-051 check, in `src/github/auth.ts` (FR-002, FR-003)
- [X] T027 [P] Implement rate-limit budget, reserve, and wait-for-reset in `src/github/rate-limit.ts` (FR-040)
- [X] T028 [P] Implement the append-only token ledger with reviewer reserve, exposing the addressable `check(target, actor, resource, estimate)` and `record(entry)` operations later features record against, in `src/ledger/tokens.ts` (FR-031, FR-047)
- [X] T029 Implement ledger reconstruction from check-run outputs in `src/ledger/reconstruct.ts` (FR-038) — depends on T028
- [X] T030 Declare the review-run statechart — every state and guard from [data-model.md](data-model.md), `checkingPrerequisites` first and the empty-diff exit on `checkingSize` — in `src/review/machine.ts` (Principle VII)
- [X] T031 Implement the CLI entry point parsing `--target`, `--checkout`, `--pull-request` in `src/cli.ts` (FR-026, FR-027) — depends on T022, T023, T030
- [X] T032 Implement the end-to-end harness in `tests/e2e/harness/` — fixture-repository client, branch and pull request creation, pushing a revision, polling the check run to a terminal state, reading review threads and escalation issues, seeding the fixtures scenarios 11, 12, 15, 17, 19, and 26 need, and teardown — so every later e2e task drives the real flow with only `ScriptedModelClient` substituted (R-015, Principle II, Principle V baseline). **Requires the App installation and the fixture repository** — see Human prerequisites. **Done 2026-08-27**: `environment.ts` (preflight), `fixture-repository.ts` (two identities, Git Data API revisions, gate polling, threads, escalations, teardown), `review-run.ts` (`runReview` and `runDaemonUntil`, the model the only substitution), `seeds.ts` (scenarios 11, 12, 14, 15, 17, 24, 26), and the harness's own `smoke.e2e.ts`. **Observed passing 2026-08-28**, once `independent-review` became a required check on the fixture's `main`: all seven smoke assertions green in 20s against the real fixture, and teardown leaves it with only `main` and `unprotected-base`

**Footprints**: T023 depends on T008 and T022; T029 on T028; T031 on T022, T023, T030. T032 writes
`tests/e2e/harness/**` only, but holds `fixture-repo`, `github-quota`, and `review-slot` while its own
smoke check runs. All other implementation tasks are disjoint.

**Checkpoint**: Foundation ready — user stories can begin, in parallel if staffed. **T011–T031 need no
GitHub access; T032 is the first task that does.**

---

## Phase 3: User Story 1 — Every pull request receives an explicit, gating verdict (Priority: P1) 🎯 MVP

**Goal**: Two roles run against the diff, each records an explicit verdict, and a single check run
reports the combined outcome.

**Independent Test**: Open a pull request in the fixture repository and observe two role verdicts and a
check run whose conclusion matches them — with a scripted model double and no further input.

### Tests (write first, observe failing)

- [X] T033 [P] [US1] Unit tests for verdict aggregation, missing-verdict-as-failure, and gate conclusion mapping in `tests/unit/review/gate.test.ts` (FR-006, FR-007, FR-008, FR-021)
- [X] T034 [P] [US1] Unit tests for role precedence, contradiction recording, and the equal-precedence disagreement path — unreachable end-to-end in version one, so asserted here (FR-048, FR-049) — in `tests/unit/review/precedence.test.ts`
- [X] T035 [US1] E2E test: clean pull request yields two approving verdicts and a `success` check run, in `tests/e2e/gating-verdict.e2e.ts` — quickstart scenario 1 (SC-001)
- [X] T036 [US1] E2E test: the security reviewer blocks what the implementation reviewer accepts — the security finding stands, the gate reports `failure`, the contradiction is recorded, and **no** disagreement escalation is raised, in `tests/e2e/gating-verdict.e2e.ts` — quickstart scenario 20 (FR-048, SC-023)
- [X] T037 [US1] E2E test: an authoring identity attempting to report the gate is refused — asserting the refusal is **structural**, since GitHub accepts check-run writes only from an App installation and rejects any user token regardless of its scopes, in `tests/e2e/gate-identity.e2e.ts` — quickstart scenario 19 (FR-022, SC-007)

### Implementation

- [X] T038 [P] [US1] Implement check-run create and update, with the conclusion mapping in [contracts/github-surface.md](contracts/github-surface.md), in `src/github/check-run.ts` (FR-021, FR-022, FR-023, FR-024)
- [X] T039 [P] [US1] Implement pull request, author, head SHA, and diff reads in `src/github/pull-request.ts` (FR-001, FR-009)
- [X] T040 [P] [US1] Implement review submission carrying a role's verdict in `src/github/reviews.ts` (FR-006)
- [X] T041 [P] [US1] Implement the security reviewer role in `src/review/roles/security.ts` (FR-005)
- [X] T042 [P] [US1] Implement the implementation reviewer role shell in `src/review/roles/implementation.ts` (FR-005)
- [X] T043 [US1] Implement role precedence and contradiction handling in `src/review/precedence.ts` (FR-048, FR-049)
- [X] T044 [US1] Implement verdict aggregation and gate derivation in `src/review/gate.ts` (FR-007, FR-008, FR-021) — depends on T038, T043
- [X] T045 [US1] Wire the `reviewing → reportingGate` path through the statechart in `src/review/machine.ts` — depends on T044

**Footprints**: T035 and T036 share `tests/e2e/gating-verdict.e2e.ts` and MUST be serialized. All e2e
tasks hold `fixture-repo`, `github-quota`, and `review-slot` — never parallel with each other or with
any other phase's e2e task. T045 writes `src/review/machine.ts`, shared with T030 and later phases.

**Checkpoint**: A pull request is gated end to end. This is the MVP.

---

## Phase 4: User Story 2 — Findings arrive on the offending line, with severity and blocking status (Priority: P1)

**Goal**: Findings post as line-anchored comments carrying severity and an explicit blocking status,
with a pull-request-level fallback when the location is not addressable.

**Independent Test**: Submit a pull request containing a hardcoded credential and assert a blocking,
severity-carrying comment anchored to the introducing line and a request-changes verdict.

### Tests (write first, observe failing)

- [X] T046 [P] [US2] Unit tests for finding fingerprints and severity-to-blocking derivation against the configured threshold, evaluated once at creation, in `tests/unit/review/findings.test.ts` (FR-011, FR-012, FR-013)
- [X] T047 [P] [US2] Unit tests for the diff-location resolver, including the not-in-diff fallback that records at pull request level rather than dropping, in `tests/unit/review/locations.test.ts` (FR-010, FR-014)
- [X] T048 [P] [US2] Unit tests for the Anthropic adapter in `tests/unit/model/anthropic.test.ts`: credentials read from the local environment or keychain and **never** from Actions secrets, never logged and never placed in a prompt, `usage` reported on every response including error paths, and output consumed only through its schema (FR-031, FR-032, FR-036)
- [X] T049 [US2] E2E test: hardcoded credential yields a blocking anchored finding and request-changes, in `tests/e2e/findings.e2e.ts` — quickstart scenario 2 (SC-003)
- [X] T050 [US2] E2E test: a finding outside the diff is recorded at pull request level rather than dropped, in `tests/e2e/findings.e2e.ts` (FR-014)

### Implementation

- [X] T051 [P] [US2] Implement finding fingerprints, the fixed severity scale, and blocking derivation in `src/review/findings.ts` (FR-011, FR-012, FR-013)
- [X] T052 [P] [US2] Implement diff-location resolution and the pull-request-level fallback in `src/review/locations.ts` (FR-010, FR-014)
- [X] T053 [US2] Extend review submission to batch a role's findings into one review with `path`/`line`/`side` comments in `src/github/reviews.ts` (FR-010, FR-014) — depends on T051, T052
- [X] T054 [US2] Implement the `AnthropicModelClient` adapter in `src/model/anthropic.ts` with structured outputs, credentials from the local environment or keychain, and prompts that carry diff and comment content as delimited data rather than as instructions — the property asserted by T117 (FR-029, FR-032, FR-036) — depends on T024, T048

**Footprints**: T049 and T050 share `tests/e2e/findings.e2e.ts` and MUST be serialized. T053 writes
`src/github/reviews.ts`, shared with T040 — serialize against Phase 3.

**Checkpoint**: Findings are actionable — located, graded, and unambiguous about blocking.

---

## Phase 5: User Story 3 — The implementation reviewer enforces the project's own rules (Priority: P2)

**Goal**: Blocking findings for missing tests, missing or stale `docs/` documents, content no spec
asked for, and pull requests over the size cap without a stated justification — with the changed-line
count measured over a **declared** exclusion set rather than a guessed one.

**Independent Test**: Submit a behavior change with no `docs/` update, one with no test, one carrying an
unrelated refactor, and one oversized with and without justification — assert a blocking finding in each
case that warrants one.

### Tests (write first, observe failing)

- [X] T055 [P] [US3] Unit tests for behavior-change detection, the documentation-only exemption, and the **stale document** case — a `docs/` file present but still describing the superseded behavior — in `tests/unit/review/rules/docs.test.ts` (FR-016)
- [X] T056 [P] [US3] Unit tests for excluded-path determination in `tests/unit/review/excluded-paths.test.ts`: the set is git-reported binary **plus** `excludedPathPatterns` and nothing else; no generated-file heuristic fires; a path resembling build output but not declared is **not** excluded; the resolved list is exposed for recording (FR-053)
- [X] T057 [P] [US3] Unit tests for the scope-minimality rule across its declared categories — a refactor of untouched code, an opportunistic rename, formatting of untouched lines, a dependency change the feature does not require, and commented-out or dead code — each a blocking finding naming the content, in `tests/unit/review/rules/minimality.test.ts` (FR-042)
- [X] T058 [P] [US3] Unit tests for the changed-line counter measured with the excluded set removed, and the `maxPullRequestSize` check with its description-justification escape clearing that finding and only that finding, in `tests/unit/review/rules/size.test.ts` (FR-043)
- [X] T059 [US3] E2E test: behavior change with no `docs/` update yields a blocking finding, in `tests/e2e/constitutional-rules.e2e.ts` — quickstart scenario 3 (SC-004)
- [X] T060 [US3] E2E test: unrelated refactor yields a blocking minimality finding, in `tests/e2e/constitutional-rules.e2e.ts` — quickstart scenario 4 (FR-042, SC-018)
- [X] T061 [US3] E2E test: oversized pull request blocks without a justification and passes the size check with one, in `tests/e2e/constitutional-rules.e2e.ts` — quickstart scenarios 5 and 6 (FR-043)
- [X] T062 [US3] E2E test: a diff touching a declared excluded path and a git-binary file — both excluded from anchoring and from the changed-line count, neither blocking on its own, the excluded list recorded and its count in the check-run output, in `tests/e2e/excluded-paths.e2e.ts` — quickstart scenario 29 (FR-053)

### Implementation

- [X] T063 [P] [US3] Implement excluded-path determination — git-reported binary plus declared `excludedPathPatterns`, never inferred — in `src/review/excluded-paths.ts` (FR-053)
- [X] T064 [P] [US3] Implement the missing-tests and missing-or-stale-document checks in `src/review/rules/docs.ts` (FR-016)
- [X] T065 [P] [US3] Implement the scope-minimality check for content not traceable to the feature spec in `src/review/rules/minimality.ts` (FR-042)
- [X] T066 [US3] Implement the changed-line counter over the excluded set and the `maxPullRequestSize` check with the justification escape in `src/review/rules/size.ts` (FR-043) — depends on T063
- [X] T067 [US3] Compose the three rules into the implementation reviewer in `src/review/roles/implementation.ts` (FR-016, FR-042, FR-043) — depends on T064, T065, T066

**Footprints**: T059, T060, T061 all write `tests/e2e/constitutional-rules.e2e.ts` and MUST be
serialized. T067 writes `src/review/roles/implementation.ts`, shared with T042 — serialize against
Phase 3. T063 is also consumed by T097 in Phase 7.

**Checkpoint**: The gate is meaningful rather than ceremonial.

---

## Phase 6: User Story 4 — A push invalidates every prior verdict (Priority: P2)

**Goal**: Every run reviews from scratch, reconciles the service's own prior findings rather than
reposting them, and routes an author's justification through the waiver path.

**Independent Test**: Approve a pull request, push a commit, and assert the gate no longer reports
success and a fresh review runs; then fix one finding, leave one standing, and assert reconciliation.

### Tests (write first, observe failing)

- [X] T068 [P] [US4] Unit tests for reconciliation in `tests/unit/review/reconcile.test.ts` — resolve fixed, leave standing open without reposting, add new; and the FR-015 limits: a finding that still stands is **never** resolved, a finding authored by anyone else is **never** resolved, and nothing is resolved merely for being old (FR-015, FR-039)
- [X] T069 [P] [US4] Unit tests for reply judgement and waiver-request creation — rejected justification leaves the finding blocking, accepted justification records a waiver rather than a fix and is never resolved by reconciliation — in `tests/unit/review/replies.test.ts` (FR-044, FR-045)
- [X] T070 [US4] E2E test: a push after approval leaves the gate no longer reporting success and triggers a fresh full-diff review, in `tests/e2e/staleness.e2e.ts` — quickstart scenario 7 (FR-017, FR-018, SC-005)
- [X] T071 [US4] E2E test: re-review resolves the fixed finding, leaves the standing one open unreposted, adds the new one, in `tests/e2e/staleness.e2e.ts` — quickstart scenario 8 (FR-039, SC-015)
- [X] T072 [US4] E2E test: rejected justification keeps the finding blocking; accepted justification records a waiver request, escalates, and does not resolve or pass, in `tests/e2e/waivers.e2e.ts` — quickstart scenarios 9 and 10 (FR-044, FR-045, SC-019)

### Implementation

- [X] T073 [P] [US4] Implement review-thread reads and `resolveReviewThread` via GraphQL, restricted to threads carrying the service's own findings, in `src/github/threads.ts` (FR-015, FR-039, FR-044)
- [X] T074 [US4] Implement finding reconciliation against the current revision, resolving only the service's own findings the revision no longer exhibits, in `src/review/reconcile.ts` (FR-015, FR-039) — depends on T051, T073
- [X] T075 [US4] Implement reply judgement, waiver requests, and the gate hold in `src/review/replies.ts` (FR-044, FR-045) — depends on T074
- [X] T076 [US4] Wire the `reconciling` state and the superseded-run discard into `src/review/machine.ts` (FR-017, FR-019) — depends on T074

**Footprints**: T070 and T071 share `tests/e2e/staleness.e2e.ts` and MUST be serialized. T076 writes
`src/review/machine.ts` — serialize against T030 and T045.

**Checkpoint**: Approvals cannot be earned once and pushed behind.

---

## Phase 7: User Story 5 — The gate fails closed when the reviewer cannot review (Priority: P2)

**Goal**: Every inability to review — missing prerequisites, nothing to review, startup failure, mid-run
error, missing credentials, budget exhaustion, oversized diff, failed round, round cap, rate limits,
queue waits — produces a failing or unreported gate and an escalation, never a passing one.

**Independent Test**: Force each failure mode and assert a failing gate with a stated reason and no
approving verdict in every case.

### Tests (write first, observe failing)

- [X] T077 [P] [US5] Unit tests for prerequisite verification in `tests/unit/review/prerequisites.test.ts`: a missing installation permission fails naming it; the gate absent from the base branch's `required_status_checks.contexts` fails naming the branch protection; a `404` on the protection endpoint is the unprotected-branch failure rather than a retry; a `403` reports the missing `administration: read` first; every path spends zero model tokens and records no verdict (FR-003, FR-025, FR-051)
- [X] T078 [P] [US5] Unit tests for the empty-diff refusal in `tests/unit/review/rules/empty-diff.test.ts`: an empty diff and a whitespace-only diff are both refused, no verdict is recorded for either role, zero tokens are spent, and the gate reason states there is nothing to review (FR-052)
- [X] T079 [P] [US5] Unit tests for round history in `tests/unit/review/round-history.test.ts`: the baseline is the most recent **concluded** round read from the reviewing identity's check runs; unconcluded rounds are ignored entirely; an absent history makes the first round, which is never a failed round (FR-020, FR-046)
- [X] T080 [P] [US5] Unit tests for forward-progress detection, including the unconcluded-round baseline rule and comparison by revision-and-reply rather than elapsed time, in `tests/unit/review/progress.test.ts` (FR-046)
- [X] T081 [P] [US5] Unit tests for the reviewable-size gate spending nothing in `tests/unit/review/rules/reviewable-size.test.ts` (FR-037)
- [X] T082 [P] [US5] Unit tests asserting no code path yields `neutral`, `skipped`, or `cancelled`, and that every `failure` carries a reason, in `tests/unit/review/gate-conclusions.test.ts` (FR-023, FR-024)
- [X] T083 [P] [US5] Unit tests for escalation in `tests/unit/observability/escalate.test.ts`: every escalation both notifies through the configured channel **and** states its reason on the pull request, neither substituted for the other, and a recurring cause on the same pull request updates its issue rather than duplicating it (FR-035, R-012)
- [X] T084 [US5] E2E test: the merge gate absent from the base branch's required checks, and separately a missing installation permission — each spends zero tokens, records no verdict, fails the gate naming the missing prerequisite, and escalates, in `tests/e2e/prerequisites.e2e.ts` — quickstart scenario 26 (FR-051, SC-024)
- [X] T085 [US5] E2E test: a pull request whose diff is empty or whitespace-only is refused — zero spend, no verdict, gate `failure` stating there is nothing to review, escalation — in `tests/e2e/empty-diff.e2e.ts` — quickstart scenario 27 (FR-052)
- [X] T086 [US5] E2E test: missing model credentials and mid-run error each fail the gate with a reason and zero approving verdicts, in `tests/e2e/fail-closed.e2e.ts` — quickstart scenario 13 (FR-023, SC-002)
- [X] T087 [US5] E2E test: budget below requirement stops before spending, fails, escalates; reserve-only budget still runs the review, in `tests/e2e/budget.e2e.ts` — quickstart scenarios 14 and 15 (FR-031, FR-047, SC-009, SC-022)
- [X] T088 [US5] E2E test: oversized diff spends zero tokens, records no verdict, fails with a split reason, in `tests/e2e/fail-closed.e2e.ts` — quickstart scenario 16 (FR-037, SC-014)
- [X] T089 [US5] E2E test: no-progress round stops before re-reviewing and escalates; a retry after an unconcluded round proceeds, in `tests/e2e/progress.e2e.ts` — quickstart scenarios 11 and 12 (FR-020, FR-046, SC-020)
- [X] T090 [US5] E2E test: platform reserve pauses, notifies, leaves the gate unreported, resumes without reposting, in `tests/e2e/rate-limit.e2e.ts` — quickstart scenario 17 (FR-040, SC-016)
- [X] T091 [US5] E2E test: queue wait under the maximum leaves the gate unreported; over it notifies, fails, and escalates, in `tests/e2e/queue.e2e.ts` — quickstart scenarios 24 and 25 (FR-041, SC-017). **Amended 2026-08-20 (R-017)**: the wait is measured from the tick that enqueued the review to the review starting, not from a workflow run's `created_at`. Saturate the daemon's worker pool to produce the wait; there is no workflow run to read

### Implementation

- [X] T092 [P] [US5] Implement branch-protection reads and the is-the-gate-required assertion in `src/github/branch-protection.ts` (FR-025, FR-051)
- [X] T093 [US5] Implement startup prerequisite verification — permissions held and gate required, both before any spend, neither ever configured by the service — in `src/review/prerequisites.ts` (FR-003, FR-025, FR-051) — depends on T026, T092
- [X] T094 [P] [US5] Implement the empty and whitespace-only diff refusal in `src/review/rules/empty-diff.ts` (FR-052)
- [X] T095 [US5] Implement round-history reads — prior rounds' `roundNumber`, `headSha`, `concluded`, open blocking fingerprints and conclusion time, from the reviewing identity's check runs — in `src/review/round-history.ts` (FR-020, FR-046) — depends on T038
- [X] T096 [US5] Implement forward-progress and round-cap checks in `src/review/progress.ts` (FR-020, FR-046) — depends on T095
- [X] T097 [US5] Implement the `maxReviewableDiffSize` pre-spend gate, measured over the excluded set, in `src/review/rules/reviewable-size.ts` (FR-037) — depends on T063
- [X] T098 [P] [US5] Implement queue-wait measurement and the escalation threshold in `src/review/queue.ts` (FR-041)
- [X] T099 [US5] Implement escalation — the `NotificationChannel` interface, its GitHub-issue implementation, and the statement on the pull request that always accompanies it, neither substituted for the other — in `src/observability/escalate.ts` (FR-035) — depends on T026
- [X] T100 [US5] Wire `checkingPrerequisites`, the empty-diff exit, fail-closed exits, `waitingForReset`, and `escalating` into `src/review/machine.ts` (FR-023, FR-051, FR-052) — depends on T093, T094, T096, T097, T098, T099
- [X] T101 [US5] Create the reviewer workflow with the per-pull-request concurrency group and `cancel-in-progress: true` in `.github/workflows/review.yml` (FR-001, FR-019, FR-041) — **superseded 2026-08-20 by T128 and T130 (R-017)**: the workflow was built as specified and is deleted without ever having run. It stays `[X]` because it was done; FR-001, FR-019 and FR-041 are re-satisfied by the daemon, and the tasks that do so name it

**Footprints**: T086 and T088 share `tests/e2e/fail-closed.e2e.ts` and MUST be serialized. T100 writes
`src/review/machine.ts` — serialize against T030, T045, T076. T097 depends on T063 from Phase 5 — the
only cross-story code dependency besides US2 → US4. All e2e tasks hold the exclusive resources.

**Checkpoint**: The system degrades to stopped, never to unreviewed — and never reviews under a gate
nothing enforces.

---

## Phase 8: User Story 6 — The reviewer never approves its own work (Priority: P3)

**Goal**: A pull request authored by the reviewing identity records no approving verdict, states the
refusal, and escalates.

**Independent Test**: Open a pull request authored by the reviewing identity and assert no approving
verdict and a non-passing gate.

### Tests (write first, observe failing)

- [X] T102 [P] [US6] Unit tests for author-versus-reviewing-identity comparison, including the negative case where another author does not trip the check, in `tests/unit/review/self-review.test.ts` (FR-004)
- [X] T103 [US6] E2E test: self-authored pull request records no approval, states the reason, escalates; another author does not trip the check, in `tests/e2e/self-review.e2e.ts` — quickstart scenario 18 (FR-004, SC-006)

### Implementation

- [X] T104 [US6] Implement the self-authored refusal check in `src/review/self-review.ts` (FR-004)
- [X] T105 [US6] Wire `checkingIdentity` into `src/review/machine.ts` (FR-004) — depends on T104

**Footprints**: T105 writes `src/review/machine.ts` — serialize against every other machine task.

**Checkpoint**: Independence cannot silently collapse.

---

## Phase 9: User Story 7 — Reviews are addressable, configured, and accountable (Priority: P3)

**Goal**: Everything resolves through the target parameter, every record carries a run identifier, and
every run reports what it spent, what it excluded, and which optional settings were in effect.

**Independent Test**: Run against a fixture target from an unrelated working directory and assert it
read that target's constitution and settings, and that its records carry a run identifier and a spend
report.

### Tests (write first, observe failing)

- [X] T106 [P] [US7] Unit tests asserting every emitted record validates against `schemas/review-record.schema.json` and carries `runId`, with no bare prose on standard output, in `tests/unit/observability/records.test.ts` (FR-033, FR-034)
- [X] T107 [P] [US7] Unit tests for the check-run output payload in `tests/unit/github/check-run-output.test.ts`: tokens consumed, budget remaining, the excluded-path count, the effective value of every optional setting, and the round-history fields the next round reads are all present (FR-031, FR-046, FR-053, FR-054)
- [X] T108 [US7] E2E test: run from an unrelated working directory resolves constitution, settings, and inspected paths through `--target`; a missing `--target` stops with an error, in `tests/e2e/addressing.e2e.ts` — quickstart scenario 23 (FR-026, FR-027, SC-012)
- [X] T109 [US7] E2E test: a settings file carrying a sibling agent's section, an unknown key inside `reviewService`, and no `modelEffort` — the sibling is ignored, the unknown own key stops the run, and the documented default is applied with its effective value reported, in `tests/e2e/settings.e2e.ts` — quickstart scenario 28 (FR-050, FR-054)
- [X] T110 [US7] E2E test: a concluded run reports tokens consumed and budget remaining, and is reconstructible from its records and the pull request alone, in `tests/e2e/accountability.e2e.ts` — quickstart scenario 22 (FR-033, FR-034, SC-008)

### Implementation

- [X] T111 [US7] Extend the check-run output in `src/github/check-run.ts` to carry per-run spend and budget remaining, the excluded-path count, the effective optional settings, and the round-history fields the next round reads (FR-031, FR-046, FR-053, FR-054) — shares the file with T038 and T095, serialize against Phases 3 and 7
- [X] T112 [US7] Thread the run identifier through every emission path in `src/observability/logger.ts` and `src/review/machine.ts` (FR-033) — depends on T021, T030

**Footprints**: T111 writes `src/github/check-run.ts`, shared with T038 — serialize against Phase 3.
T112 writes two files shared with earlier phases — runs alone.

**Checkpoint**: A review is legible after the fact without re-running it.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [X] T113 Generate the statechart diagram from `src/review/machine.ts` into `docs/independent-review-service.md` via a script in `scripts/generate-diagram.ts`, wired into `check` so the diagram cannot drift (Principle VII)
- [X] T114 Write the feature document — what it does, how it works, how to run it, decisions and trade-offs, including both recorded least-privilege tensions and the human prerequisites above — in `docs/independent-review-service.md` (Principle IX) — depends on T113
- [X] T115 [P] Add the lint rule failing any assertion on model-produced strings under `tests/e2e/` in `eslint.config.js` (FR-030, SC-010)
- [X] T116 Add the timed e2e case asserting a 1,000-changed-line diff concludes within 10 minutes in `tests/e2e/performance.e2e.ts`, stating in the test that the model boundary is substituted so the figure bounds harness overhead rather than model latency; the real-model figure is an eval outside the merge path (SC-013, Principle II)
- [X] T117 [P] Add prompt-injection regression tests — diff, comment, and model-output content carrying instructions is never acted on — in `tests/unit/model/injection.test.ts` (FR-036)
- [X] T118 [P] Add a credential-leak regression test asserting no record, comment, or prompt contains credential-shaped values in `tests/unit/observability/redaction.test.ts` (FR-032)
- [X] T119 Run all 29 quickstart validation scenarios against the fixture repository and record the results in `docs/independent-review-service.md` — the `specs/` record states intent at the time it was written and is not rewritten (Principle IX)
- [X] T120 Write the pull request description: the irreducibility justification for its size per Principle X and [plan.md](plan.md) Complexity Tracking, the spec and run identifier links (Principle VII), and — if `.mcp.json` is tracked — why agent tooling configuration rides along, since it traces to no spec and sits on the escalation list (FR-043, Principle V, Principle X)
- [X] T121 E2E test: every escalation path emits a notification through the configured channel **and** states its reason on the pull request, with neither substituted for the other, in `tests/e2e/escalation.e2e.ts` — quickstart scenario 21 (FR-035, SC-011, SC-021)

**Footprints**: T113, T114, and T119 all write `docs/independent-review-service.md` and MUST be
serialized in that order. T115 extends `eslint.config.js` first created in T003 — safe, since Phase 1
completes before Phase 10. T116, T119, and T121 hold all three exclusive resources and are serialized
against each other and every other e2e task.

---

## Phase 11: Deployment topology (R-017)

**Added 2026-08-20.** [research.md](research.md) R-017 supersedes R-013: the service is a long-lived
local process that reconciles state, not a workflow on a self-hosted runner. No functional
requirement changed — see the spec's 2026-08-20 addendum — so this phase re-satisfies FR-001, FR-019
and FR-041 by a different mechanism rather than implementing anything new against them.

Two of these tasks are not consequences of R-017 at all and are recorded as the gap they are: **no
task in Phases 1–10 ever created a composition root or minted an installation token in TypeScript.**
Every adapter was built behind an interface and nothing ever constructed one. `parseArgs` is never
called, and `src/` contains no `@octokit` import. That gap predates this amendment and would have
blocked real operation under R-013 identically.

### Tests (write first, observe failing)

- [X] T122 [P] Unit test: an installation token is minted from the App's private key and refreshed before it expires, never after a `401`; a key whose permissions are not `600` is refused, in `tests/unit/github/installation-token.test.ts` (FR-002, FR-022)
- [X] T123 [P] Unit test: worktree provisioning creates a bare mirror, fetches the pull request head, adds a detached worktree at the requested SHA, and removes it on both success and failure; asserts that no command derived from the tree's own contents is ever executed, in `tests/unit/worktree.test.ts` (R-017)
- [X] T124 Integration test: the reconciliation decision, **both clauses** ([research.md](research.md) R-018) — clause (a), a head SHA carrying no `independent-review` check run is selected and one already carrying it is skipped; clause (b), a SHA whose check run concluded `failure` with open blocking findings **is** selected when one of those findings carries a reply newer than that run's conclusion time, and is **not** selected when the newest reply predates it, when the run concluded `success`, or when its output lists no open blocking finding; the thread read is skipped entirely for pull requests the cheap conditions exclude (FR-040); an unchanged listing returns `304` and selects nothing; and a run whose head SHA moved during the review discards its outcome without posting findings or the gate, in `tests/integration/reconcile.test.ts` (FR-001, FR-019, FR-044, FR-046)

### Implementation

- [X] T125 Implement the installation-token provider in `src/github/auth.ts` — JWT from the private key at `~/.config/github-app/review-app.pem`, exchange at `/app/installations/{id}/access_tokens`, refresh before expiry — mirroring [`scripts/github-app-token.sh`](../../scripts/github-app-token.sh), which stays as the by-hand path (FR-002, FR-022) — depends on T122
- [X] T126 Implement worktree provisioning in `src/worktree.ts` — bare mirror under `~/.cache/review-service/`, `git fetch` of the pull request head, detached worktree per review, removal afterwards (R-017) — depends on T123
- [X] T127 Implement the composition root in `src/composition.ts` — the only place concrete adapters are constructed: Octokit-backed `CheckRunApi`, `ReviewsApi`, `ThreadsApi`, `BranchProtectionApi` and `EscalationSurfaces`, the model client resolved from `ModelCredential`, the logger, and the ledger — and wire `src/cli.ts` to it so one named pull request can be reviewed end to end from the command line (FR-026, FR-027) — depends on T125, T126
- [X] T128 Implement the daemon in `src/daemon.ts` — the poll loop, **both predicate clauses** of [research.md](research.md) R-018, conditional requests with an `ETag` cache, bounded workers each holding a host lease from T132, and the FR-019 head-SHA re-read before posting. **Settings work, all of it required and none of it defaulted in code** (FR-028, FR-054, [data-model.md](data-model.md) OperatingSettings): add `pollIntervalSeconds` and `maxConcurrentReviews` to `reviewService` and the shared `host` section carrying `maxConcurrentAgents` — writing [contracts/settings.schema.json](contracts/settings.schema.json) **first** and republishing to `schemas/settings.schema.json`, so the contract stays the source and the copy stays a copy (T008's direction); teach `src/config/settings.ts` to validate the `host` section strictly alongside its own while still ignoring sibling agents' sections (FR-050); add the two cross-field invariants `maxConcurrentReviews ≤ host.maxConcurrentAgents` and `host.maxConcurrentAgents ≥ 1`; and add the three new keys to this repository's own `.agents/settings.json`, **without which the service stops on its own target repository**. Finally, rewire `src/review/queue.ts`, whose `queuedAt` still documents itself as "when the workflow run was created": under R-017 the wait runs from the enqueuing tick to the review holding both a worker and a host lease (FR-001, FR-019, FR-041, FR-050, FR-054, Principle VIII) — depends on T124, T127, **T132**
- [X] T129 [P] Add the `launchd` user agent at `scripts/com.agents.review.plist` with `RunAtLoad` and `KeepAlive`, an `npm run daemon` script, and its install and uninstall steps in [quickstart.md](quickstart.md) (R-017, Principle IV) — depends on T128
- [X] T130 Delete `.github/workflows/review.yml`, and update `docs/independent-review-service.md` — the topology, the removal of the fork-pull-request exclusion, and the human prerequisites table — in the same change (Principle IX) — depends on T128

**Footprints**: T125 extends `src/github/auth.ts`, first created in Phase 2 — serialize against
anything else touching it. T128 writes `contracts/settings.schema.json`, `schemas/settings.schema.json`,
`.agents/settings.json`, `src/config/settings.ts` and `src/review/queue.ts`, all shared, and MUST be
serialized against every other task touching settings — T008, T009, T013, T014, T023 and T098 own
those files in earlier phases. T127 is the only
task permitted to construct concrete adapters; a second task doing so is a merge conflict by
construction. T129 and T130 touch disjoint files and may run in parallel once T128 lands. T130 writes
`docs/independent-review-service.md` and serializes against T113, T114, and T119.

**Ordering note**: T132 precedes T128, and T127 precedes both. T127 was the critical path. Until it
existed the service could not run against a real pull request at all, which also made it what
unblocks posting the first `independent-review` check run — and the classic branch-protection UI
will not offer that context as a required check until it has seen one. **That step is now
available**: opening one throwaway pull request and letting the daemon report on it is what makes
the gate selectable in the branch-protection picker.

**Recorded during T128**: the task asked for two cross-field invariants,
`maxConcurrentReviews <= host.maxConcurrentAgents` and `host.maxConcurrentAgents >= 1`. Only the
first is in `invariantProblems`. The second is not a cross-field question at all — JSON Schema
expresses it natively, and it is `"minimum": 1` on the property, so a code check would be validation
no input could reach. `acquireHostLease` additionally refuses a capacity below one, which is the
defence in depth for a caller that never went through settings at all.

**Recorded during T127**: `ReviewThreadComment` gained `createdAt` and `OwnThread` gained
`latestReplyAt`. FR-046's forward-progress check and R-018's clause (b) both compare a reply against
a round's conclusion time, and nothing in the tree carried a reply timestamp — the GraphQL query did
not even select one. Neither requirement was reachable without it.

**Recorded during T130**: deleting `review.yml` left dangling links and a stale prerequisite in
`docs/prerequisites.md` and `docs/github-access.md`, and a stale comment in `ci.yml`. All three were
corrected in the same change, because documentation describing behavior the code no longer has is
the exact defect this service blocks pull requests for.

---

## Phase 12: Cross-artifact analysis remediation

**Added 2026-08-20**, from analysing the R-017 amendment against the spec, the constitution, and the
tree as built. Four of these six tasks close gaps the analysis found; two record work that shipped
without a task at all, which is its own kind of gap — Principle VII's traceability depends on a
commit's cited task ID resolving to something.

The predicate correction itself is not here: it belongs to the daemon and its test, so T124 and T128
are amended in place rather than shadowed by a second pair of tasks.

### The host-wide cap (R-019) — precedes T128

- [X] T131 [P] Unit tests for the host-wide agent lease in `tests/unit/host-lease.test.ts`: acquisition takes the lowest free slot; a full set of slots returns no lease rather than exceeding the cap; release frees the slot; a slot whose recorded PID is no longer live is reclaimed by the next acquirer; two acquirers racing for the last slot yield exactly one holder; and a lease is never reconstructed after the fact, unlike the ledger (FR-041, Principle VIII, [research.md](research.md) R-019)
- [X] T132 Implement the host-wide agent lease in `src/host-lease.ts` — `open(O_CREAT | O_EXCL)` against `slot-01 … slot-NN` under `${XDG_STATE_HOME:-~/.local/state}/agents/slots/`, each file recording holder PID and start time, stale-slot reclamation by PID liveness, and release on both success and failure paths (FR-041, Principle VIII, R-019) — depends on T131. **T128 depends on this**: the daemon's workers acquire a lease each, and `maxConcurrentReviews` is a ceiling on the reviewer's share rather than the host's cap

### Traceability for work that shipped without a task

Both record what is already in the tree and are therefore `[X]`, annotated like T101. They exist so
that the 2026-08-17 spec addendum has task IDs behind it, not to schedule anything.

- [X] T133 **[Retroactive record]** Resolve the model credential to a `ModelCredential` carrying its `source` — `ant auth login` profile under `~/.config/anthropic/` (preferred, and carrying no key, because the SDK reads the profile itself), then `ANTHROPIC_API_KEY`, then keychain — in `src/model/anthropic.ts`, with `AnthropicModelClient` accepting a keyless profile credential while still rejecting a source that promises a key and supplies an empty one (FR-032, and the 2026-08-17 spec addendum). Shipped 2026-08-17 alongside T054; recorded here because no task described it
- [X] T134 **[Retroactive record]** Extend startup prerequisite verification to the model credential — presence checked beside the FR-003 permission check and the FR-025 branch-protection check, so an absent credential fails with a stated reason and zero spend rather than a `401` mid-review — in `src/review/prerequisites.ts` (FR-032, FR-051, and the 2026-08-17 spec addendum). Shipped 2026-08-17 alongside T093; FR-051 names only permissions and branch protection, and this extends the same pre-spend discipline without altering what FR-051 requires

### Coverage the analysis found thin

- [X] T135 Integration test: the composition root constructs and wires every concrete adapter without throwing, and `cli.ts` reaches a review through it, in `tests/integration/composition.test.ts` (FR-026, FR-027) — depends on T127. Phase 11 named this gap precisely — "every adapter was built behind an interface and nothing ever constructed one" — and then shipped T127 with no test, so its recurrence would be as invisible as its first occurrence was
- [X] T136 [P] Unit tests for revision binding in `tests/unit/review/gate-revision.test.ts`: a verdict carries the exact revision its role examined and a verdict bound to any other revision is not counted toward the gate (FR-009); an approving verdict bound to a superseded revision does not satisfy the gate after a push, and the gate derived for the new head starts from no verdicts rather than from the old ones (FR-018). Both requirements were covered only by `tests/e2e/staleness.e2e.ts` and an implementation task, so neither is currently observable while the fixture repository is missing

**Footprints**: T131 and T132 write `tests/unit/host-lease.test.ts` and `src/host-lease.ts`, new files
touched by nothing else. T135 writes `tests/integration/composition.test.ts`, new. T136 writes
`tests/unit/review/gate-revision.test.ts`, new — deliberately a separate file from T033's
`gate.test.ts`, which is complete, so that neither task's record is rewritten. T133 and T134 write
nothing; the code they describe is already merged.

**Checkpoint**: the cap counts every agent on the machine rather than one process's own workers; a
reply reaches the reviewer without a commit; and every line of shipped code resolves to a task ID.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup — **blocks every user story**
- **US1 (Phase 3)**: depends on Foundational — the MVP
- **US2 (Phase 4)**: depends on Foundational; shares `src/github/reviews.ts` with US1
- **US3 (Phase 5)**: depends on Foundational; extends the role shell from US1
- **US4 (Phase 6)**: depends on US2 — reconciliation operates on findings US2 posts
- **US5 (Phase 7)**: depends on Foundational, plus T063 from US3 for the excluded set
- **US6 (Phase 8)**: depends on Foundational only — the most independent story
- **US7 (Phase 9)**: depends on Foundational; T111 touches US1's and US5's check-run module
- **Polish (Phase 10)**: depends on every story intended for this pull request
- **Deployment topology (Phase 11)**: depends on Foundational for the adapters it constructs; T127 before T128; **T132 (Phase 12) before T128**
- **Remediation (Phase 12)**: T131 before T132, and T132 before T128 — so the two lease tasks run *inside* Phase 11's window rather than after it. T135 depends on T127. T136 depends on nothing incomplete and may run at any point

### The GitHub boundary

T001–T031 need no GitHub access beyond one push to a feature branch. **T032 onward requires the App
installation and the fixture repository** (see Human prerequisites), because every e2e assertion lands
on a check-run conclusion and only an App can create one. Build the foundation first; provisioning can
happen in parallel with it.

### The one dependency that runs backwards through the phase numbering

Phase 12 was added after Phase 11 and contains one of its prerequisites: T131 → T132 → T128. Task IDs
record when a task was written, never when it runs, and this is the clearest case of that in the file.
Scheduling by number here would build a daemon whose workers have no cap to draw from.

### The two genuine cross-story dependencies

US4's reconciliation cannot be tested without findings to reconcile, so **US2 precedes US4**. US5's
reviewable-size gate measures over the excluded set, so **T063 (US3) precedes T097 (US5)** — the
alternative, two independent counters, is exactly the drift FR-053 exists to prevent. Every other story
is independently testable once Phase 2 completes. US6 has the smallest footprint and can be delivered at
any point after the foundation.

### Within each story

Tests are written and observed failing before implementation. Models and types precede services;
services precede the statechart wiring that composes them; the statechart wiring is always last within
a phase because `src/review/machine.ts` is the most-shared file in the tree.

### Parallel opportunities

- Phase 1: T002, T003, T004, T006, T008, T009 in parallel (T001 before T005; T007 and T010 disjoint)
- Phase 2: all ten test tasks (T011–T020) in parallel; then T021, T022, T024, T025, T026, T027, T028 in parallel
- Phase 3+: all unit test tasks within a story in parallel; **no two e2e tasks ever in parallel**
- Across stories: US5 and US6 can proceed alongside US1–US4 with disjoint footprints, except for
  `src/review/machine.ts`, which serializes T045, T076, T100, T105, T112, and except for T097's
  dependency on T063

---

## Parallel Example: Phase 2 Foundational

```bash
# Write the failing tests together — ten disjoint files
Task: "Unit tests for the JSON-lines logger in tests/unit/observability/logger.test.ts"
Task: "Unit tests for target resolution in tests/unit/config/target.test.ts"
Task: "Unit tests for namespaced settings loading in tests/unit/config/settings.test.ts"
Task: "Unit tests for settings invariants in tests/unit/config/invariants.test.ts"
Task: "Unit tests for the token ledger in tests/unit/ledger/tokens.test.ts"
Task: "Unit tests for ledger reconstruction in tests/unit/ledger/reconstruct.test.ts"
Task: "Unit tests for rate-limit accounting in tests/unit/github/rate-limit.test.ts"
Task: "Unit tests for App auth in tests/unit/github/auth.test.ts"
Task: "Unit tests for CLI parsing in tests/unit/cli.test.ts"
Task: "Integration test for the statechart declaration in tests/integration/review/machine.test.ts"

# Then the disjoint implementations
Task: "Implement the logger in src/observability/logger.ts"
Task: "Implement target resolution in src/config/target.ts"
Task: "Define the ModelClient interface in src/model/client.ts"
Task: "Implement ScriptedModelClient in src/model/scripted.ts"
Task: "Implement App auth in src/github/auth.ts"
Task: "Implement rate-limit accounting in src/github/rate-limit.ts"
Task: "Implement the token ledger in src/ledger/tokens.ts"
```

---

## Implementation Strategy

### What can start today

Phase 1 and Phase 2 through T031 — 31 tasks, no App, no fixture repository, no runner. This is the
Principle V baseline `main` must carry before the loop may run at all, and it is the one part of the
feature a human is required to supervise into existence. Land it on a feature branch; the establishing
commit is approved, not pushed to `main`.

### MVP first

1. Phase 1 Setup — the baseline, the settings the service reads, the remote it is addressed against
2. Phase 2 Foundational — blocks everything; T032 waits on the App and the fixture repository
3. Phase 3 US1 — a pull request is gated end to end
4. **Stop and validate**: quickstart scenarios 1, 19, 20

At that point the repository has a working merge gate. It is not yet safe to switch on unattended
merging — that needs US4's staleness invalidation and US5's fail-closed behavior, including the
prerequisite check without which the gate can be enforced by nothing at all — but the gate exists and
reports honestly.

### Incremental delivery

| Increment | Adds | Unlocks |
|---|---|---|
| US1 | The gate itself | Everything downstream |
| US2 | Located, graded findings | An author can act on a verdict |
| US5 | Fail-closed behavior and prerequisite verification | Safe to leave running |
| US4 | Staleness and reconciliation | Safe against push-behind-approval |
| US3 | Constitutional checks and the declared exclusion set | The gate becomes meaningful |
| US6 | Self-review refusal | Closes the independence hole |
| US7 | Addressing and accountability | Reviews legible after the fact |

**This pull request ships all seven.** The ordering above is the sequence in which value accrues, not
a set of separate merges — Principle I makes the feature the unit of delivery, and a gate that reports
without failing closed would be worse on `main` than no gate at all.

### Parallel team strategy

After Phase 2, three tracks proceed with disjoint footprints: US1 → US2 → US4 (the review path), US3
(the rule set), and US5 + US6 (the safety path), with US5 taking T063 from US3 before T097. US7 lands
last because it touches modules the other tracks own. Every merge into the feature branch passes that
task's own gates first.

---

## Notes

- `[P]` means disjoint file footprint and no incomplete dependency — never "probably fine"
- E2E tasks hold `fixture-repo`, `github-quota`, and `review-slot`, so they are serialized regardless of files
- `src/review/machine.ts` is the most-contended file: T030, T045, T076, T100, T105, T112 all write it
- `src/github/check-run.ts` is second: T038, T095 (reads), T111 all touch it
- Settings are third, and T128 touches all four places at once: `contracts/settings.schema.json` (T008), `schemas/settings.schema.json` (T008), `.agents/settings.json` (T009), `src/config/settings.ts` (T023). The contract is written first and the published copy follows it, never the reverse
- Task numbering is chronological, not topological — see T131 → T132 → T128
- A test task is not done until its failure has been observed (Principle II)
- Commit after each task; each task branch merges into the feature branch only after its own gates pass
- Every quickstart scenario 1–29 has an owning e2e task: 1/19/20 → US1, 2 → US2, 3–6/29 → US3, 7–10 → US4, 11–17/24–27 → US5, 18 → US6, 22/23/28 → US7, 21 → Polish
- **`.mcp.json`** is agent tooling configuration that traces to no spec, so under Principle X it does not belong in this feature's diff. Either ignore it in T006 and configure MCP at `--scope local` instead, or keep it tracked and justify it in T120 — it is also CI/agent configuration, which Principle V puts on the escalation list and which therefore always needs a human on the merge
