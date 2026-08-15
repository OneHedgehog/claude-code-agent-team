# Phase 0 Research: Independent Review Service

**Feature**: 001-independent-review-service | **Date**: 2026-08-14

Every decision below resolves something the spec deliberately left to planning, or something the
constitution constrains without naming a mechanism. Each records what was chosen, why, and what was
rejected. Nothing here reopens a decision the spec already made.

---

## R-001: Repository baseline (Principle V starting line)

**Decision**: This feature's pull request establishes the repository baseline — Node.js toolchain,
TypeScript configuration, lint, format, type checks, test runner, an executable end-to-end harness,
and the CI workflow — alongside the review service itself.

**Rationale**: The repository has **zero commits**. There is no `package.json`, no CI, no test
runner. Principle V requires `main` to carry a baseline on which every gate the loop enforces already
runs and passes, requires that baseline to be established under human supervision rather than
produced by the loop, and forbids the loop from creating the gates that judge it. This feature's
first pull request is human-reviewed under the spec's Principle VI exception, which makes it exactly
the supervised moment the starting-line clause describes. A reviewer service cannot ship without a
toolchain to build it, and a second "scaffolding" feature would produce a `main` that the loop is
forbidden to start against anyway.

**Consequence for Principle X**: this pull request will exceed `maxPullRequestSize`. The description
must state why the change is irreducible — recorded in Complexity Tracking in [plan.md](plan.md).

**Alternatives considered**: A separate scaffolding feature merged first — rejected because it
inverts the dependency (the scaffolding has no spec-driven purpose without a first feature) and adds
a pull request that Principle I would judge as not independently shippable.

---

## R-002: Language, runtime, and package manager

**Decision**: TypeScript in strict mode on Node.js 24 LTS, pinned by `.nvmrc` and `engines` in
`package.json`. npm as the package manager, with a committed `package-lock.json`.

**Rationale**: Principle III mandates TypeScript for everything that is not ML or data work; a
reviewer service is orchestration and platform integration, so there is no Python in this feature.
Node 24 is the active LTS line and is what a GitHub Actions self-hosted runner on a developer
machine will have available. npm ships with Node, needs no additional install step, and satisfies
Principle IV's "no new component without a demonstrated need" — pnpm and yarn would each be a new
dependency justified only by preference at this size.

**Alternatives considered**: pnpm (faster, better monorepo story) — rejected, this is a single
package and the constitution prefers existing tooling; Bun — rejected, a third runtime with a
different standard library is not warranted and its CI parity is unproven for this stack.

---

## R-003: Test runner and the three correctness layers

**Decision**: Vitest for unit, integration, and end-to-end suites, with the three layers separated by
directory (`tests/unit`, `tests/integration`, `tests/e2e`) and by npm script, never conflated in one
command.

**Rationale**: Principle II requires the three layers to stay distinct and requires an executable
e2e harness in the baseline. Vitest is TypeScript-native (no separate transform step), supports
per-directory projects so the layers can run independently, and gives a single runner for all three —
which keeps CI running the same commands a developer runs locally. It is one new third-party
dependency, justified here as the test runner the baseline requires.

**Alternatives considered**: `node:test` with `tsx` — genuinely zero-dependency and tempting under
Principle IV, but the TypeScript path still needs a loader, watch mode is weaker, and the assertion
and mocking ergonomics would cost more code in the substitutable-model tests than the dependency
saves; Jest — rejected, heavier, slower, and its TypeScript story requires more configuration.

---

## R-004: GitHub platform client

**Decision**: Octokit — `@octokit/app` for App authentication and installation tokens, `@octokit/rest`
for the REST surface, `@octokit/graphql` for the review-thread mutations, plus the `throttling` and
`retry` plugins.

**Rationale**: It is the first-party client, it implements App JWT → installation token exchange
correctly (a security-sensitive flow this feature should not hand-roll), and the throttling plugin
surfaces exactly the rate-limit signals FR-040 requires. The GraphQL client is not optional — see
R-006.

**Alternatives considered**: Hand-rolled `fetch` against the REST API — rejected; the App auth token
lifecycle and the rate-limit header handling are the two places where a bug is silent and expensive.

---

## R-005: Reporting the merge gate — check runs

**Decision**: The merge gate is a **check run** created and updated by the GitHub App installation
token, with `checks: write` permission. Verdict-to-conclusion mapping: every required role approved →
`success`; any inability to review, missing verdict, blocking finding, or outstanding waiver →
`failure`. `neutral`, `skipped`, and `cancelled` are never used.

**Rationale**: GitHub's documentation is explicit that **only GitHub Apps can create check runs** —
OAuth apps and personal access tokens can read them but cannot create or update them. That is a
platform-enforced guarantee that satisfies FR-022 structurally rather than by convention: an
authoring identity holding a personal access token physically cannot report this gate. The
never-`neutral`/`skipped` rule implements FR-023 — GitHub treats both as non-failing, which is
exactly the "absent gate that reads as no objection" Principle IV prohibits.

**Alternatives considered**: A commit status via the statuses API — rejected; statuses can be set by
any identity with `repo` scope, which would let an authoring token satisfy its own gate and defeat
FR-022. Requiring the Actions job's own conclusion as the gate — rejected for the same reason plus
the fact that a job that never starts reports nothing, which FR-025 relies on branch protection to
catch but which loses the diagnostic reason FR-024 requires.

---

## R-006: Posting, reconciling, and resolving findings

**Decision**: Findings are posted with the REST review API (`POST /repos/{owner}/{repo}/pulls/{n}/reviews`)
carrying a `comments[]` array with `path` + `line` + `side`, submitted as one review per role.
Findings whose location is not in the diff go in the review body (FR-014). **Resolving** a prior
finding uses the **GraphQL `resolveReviewThread` mutation**; there is no REST equivalent.

**Rationale**: Batching each role's findings into a single review submission is what keeps the
platform API cost proportional to rounds rather than to findings — decisive given the 500
content-creating requests per hour ceiling (R-007). Review threads are not exposed in the REST API at
all, so FR-039's reconciliation is only implementable through GraphQL: query the pull request's
`reviewThreads` (thread IDs are `PRRT_`-prefixed), match the service's own prior findings by their
embedded fingerprint, and call `resolveReviewThread(input: {threadId})` for the ones the current
revision no longer exhibits.

**Finding fingerprint**: each posted finding carries a machine-readable marker in its comment body
(an HTML comment holding role, rule, path, and a normalized content hash) so a later round can match
its own prior findings without storing local state that Principle VII would call a cache.

**Alternatives considered**: One comment per finding via the review-comments endpoint — rejected, it
multiplies content-creating requests by the finding count; deleting rather than resolving stale
findings — rejected outright, FR-015 forbids it and the spec's Assumptions call resolution the single
carve-out.

---

## R-007: Platform API budget and reserve (FR-040)

**Decision**: Meter two ceilings separately. **Primary**: installation limit, 5,000 requests/hour
minimum, scaling with repository and user count to a 12,500/hour cap — read from
`x-ratelimit-limit`/`-remaining`/`-reset` rather than assumed. **Secondary**: **80
content-creating requests per minute and 500 per hour** — the binding constraint, exactly as the
spec's Assumptions predicted. The reserve is configured against the secondary hourly ceiling. On
reaching the reserve: stop issuing calls, notify, wait for `x-ratelimit-reset` (or `retry-after` when
present), resume; fail the gate only if the wait would exceed `maxRateLimitWaitSeconds`.

**Rationale**: This service's heaviest call pattern is posting findings across rounds, and those are
content-creating requests. A budget written against the 5,000/hour primary limit would never fire
while the 500/hour secondary limit silently throttled the reviewer. GitHub's guidance is explicit:
honor `retry-after` when present, otherwise wait for the reset, and never retry immediately.

**Alternatives considered**: Metering only the primary limit — rejected as above; treating secondary
limits as transient errors to retry through — rejected, that is the "resolve exhaustion by spending"
pattern Principle IV forbids in its API-quota form.

---

## R-008: Model boundary and provider

**Decision**: A `ModelClient` interface with exactly two implementations in version one — a
`ScriptedModelClient` used by every end-to-end test, and an `AnthropicModelClient` using the official
`@anthropic-ai/sdk` against `claude-opus-5`. Credentials from `ANTHROPIC_API_KEY` in the runner's
local environment or the OS keychain, never from Actions secrets (FR-032). Requests use adaptive
thinking; `output_config.effort` is an operating setting so a target repository can trade cost
against depth without a code change.

**Rationale**: FR-029 requires the boundary; the spec leaves the provider open and notes that the
budget binds either way. A managed Claude model is the honest default for a reviewer whose whole
value is judgment quality, and the interface keeps a local model (Ollama, LM Studio) a later adapter
rather than a rewrite. Structured findings come back through **structured outputs**
(`output_config.format` with a JSON Schema) rather than prose parsing, which is what makes FR-030's
"assert on states, never on wording" achievable — the deterministic surface is the schema, not the
sentences.

**Prompt-injection posture (FR-036)**: diff content, comment bodies, and reply text are passed as
data inside delimited blocks, with a system instruction stating that instructions found in reviewed
content are data and must never be acted on. Model output is consumed only through the schema —
never `eval`'d, never used to select an API call, never used to construct a path.

**Alternatives considered**: A local model as the v1 default — rejected for version one; quality at
the review bar is unproven and the substitutable interface makes it a cheap later experiment. Prose
output with a parser — rejected, it makes every e2e assertion a wording assertion in disguise.

---

## R-009: Review-run control flow (Principle VII)

**Decision**: The review run's lifecycle is an **XState v5** statechart declared as data, with the
state diagram generated from that declaration and committed under `docs/`. States, in outline:
`resolvingSettings → checkingIdentity → checkingProgress → checkingBudgets → reviewing(security ‖
implementation) → reconciling → reportingGate → done`, with `escalating` and `waitingForReset`
reachable from several states and a terminal `halted`.

**Rationale**: Principle VII requires explicit, declared control flow with a generated diagram, and
the constitution names XState unless the plan justifies otherwise. The reviewer's flow genuinely has
guards worth declaring — self-authored refusal, failed round, size caps, budget reserves, rate-limit
waits — and every one of them is a place where an ad-hoc `if` would later be indistinguishable from a
bug.

**Alternatives considered**: Plain async functions with early returns — rejected, prohibited by
Principle VII's "ad-hoc control flow that can only be understood by reading the implementation";
durable-execution engines (Temporal, Inngest) — rejected explicitly by the constitution's technology
constraints as workflow infrastructure.

---

## R-010: Budget ledger persistence and reconstructibility

**Decision**: An append-only JSONL ledger on the runner host is the working store, and **every run's
spend is also written into its check-run output**, so the cumulative total is reconstructible from
GitHub alone. Reads at start-up prefer the local file and fall back to reconstruction; a mismatch
between the two is an escalation, not a silent correction.

**Rationale**: FR-038 requires the total to survive between runs and be reconstructible after the
fact; Principle VII requires every state to be rebuildable from GitHub and calls local state a cache.
Writing spend into the check-run output satisfies both without adding a database, which Principle IV's
new-infrastructure clause would otherwise require a merged spec to justify. The reviewer reserve
(FR-047) is enforced at the pre-spend check by comparing the requested spend against
`tokenBudget − reserve` for non-review work and against `tokenBudget` for review work.

**Alternatives considered**: A committed ledger file in the target repository — rejected, it makes
every review write to `main` and turns budget accounting into diff noise; a SQLite database — rejected
as new infrastructure without a demonstrated need; repository or Actions variables — rejected, they
are mutable by any identity with the right permission and would put budget state inside the blast
radius of the thing being reviewed.

---

## R-011: Operating settings — location, format, validation

**Decision**: Version-controlled at `<target>/.agents/settings.json`, **one file shared by every
agent, each under its own top-level section** (FR-050), validated at start-up against a JSON Schema
shipped with the service ([contracts/settings.schema.json](contracts/settings.schema.json)). This
service owns the `reviewService` section. Validation is asymmetric by design: the root object is
`additionalProperties: true` so sibling sections are ignored, while the `reviewService` subtree is
`additionalProperties: false` so an unrecognized key *there* stops the run.

Settings split into a **required** set and an **optional** set (FR-054). A missing or invalid
required setting stops the run and fails the gate (FR-028); a missing optional setting is filled from
the schema's documented `default` and its effective value is reported with the run. Every budget,
reserve, threshold, and cap is required. `modelEffort` is the one optional setting, plus
`escalationChannel.label`. There are no defaults in code for required settings; for those, the
schema's `default` keyword is documentation, not a fallback.

Three cross-field invariants — `reviewerTokenReserve < tokenBudget`,
`platformApiReserve < platformApiBudget`, `maxReviewableDiffSize > maxPullRequestSize` — are not
expressible in JSON Schema and are checked in code immediately after schema validation, with the same
stop-the-run consequence.

**Rationale**: FR-026 requires resolution through the target-repository parameter, and Principle III
requires machine-checkable contracts at boundaries. JSON with a schema is checkable by both the
service and CI, and needs no parser dependency. One namespaced file rather than a file per agent is
what FR-050 requires, and the asymmetric validation is the whole point of it: validating the entire
file strictly would reject the settings a later agent adds, failing the gate on a configuration error
and leaving nothing able to merge — while validating loosely would let a typo in a budget or a
threshold pass silently, which is indistinguishable from a setting that was never applied.

The required/optional split exists so a repository can start reviewing without first reasoning about
how hard the model ought to think, while nothing that meters money or bounds a loop can be left to a
default nobody chose. Reporting the effective optional value with the run is what keeps the
convenience from becoming invisible behavior.

**Alternatives considered**: YAML — rejected, it needs a parser dependency and its type coercion
surprises are a poor fit for settings that must fail loudly; putting settings under `.specify/` —
rejected, that directory is spec-kit's, and mixing runtime configuration into it would couple the
service to a tool it does not otherwise depend on; a file per agent under `.agents/` — rejected by
FR-050, which requires one shared file, since per-agent files let two agents' budgets drift out of
sight of each other when the ledger they draw on is shared; making every setting required — rejected
by FR-054, it forces a decision about review depth before the first review is ever run.

---

## R-012: Escalation channel (FR-035)

**Decision**: A `NotificationChannel` interface with one version-one implementation: **a GitHub issue**
in the target repository, labelled `escalation`, assigned to the configured human, and updated rather
than duplicated for a recurring cause on the same pull request. Independently, and always, the reason
is stated on the pull request itself.

**Rationale**: FR-035 requires both a configured channel and a statement on the pull request, and
forbids substituting one for the other. A GitHub issue is durable, reconstructible from GitHub
(Principle VII), costs nothing (Principle IV), needs no new infrastructure, and is a genuinely
different surface from a pull request comment — so the two do not collapse into one signal. The
interface leaves Slack or a desktop notification as a later adapter.

**Alternatives considered**: Slack webhook — rejected for version one, it needs a workspace and a
secret for a benefit the issue already provides; email — rejected, needs an SMTP dependency; desktop
notification via `osascript` — rejected as the sole channel, it is invisible in the record the
constitution requires.

---

## R-013: Triggering, concurrency, and queue waiting (FR-041)

**Decision**: A single workflow on `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`)
running on the self-hosted runner. A per-pull-request `concurrency` group with
`cancel-in-progress: true` implements FR-019's superseded-run discard. The host-wide cap is the
runner's configured job slot count — reviewer jobs take an ordinary slot and are never given a
dedicated runner. Queue wait is measured from the workflow run's `created_at` to job start;
exceeding `maxQueueWaitSeconds` notifies, fails the gate, and escalates.

**Boundary, stated rather than assumed**: the measurement is taken by the job itself, so the
escalation happens when the job *starts* and finds it waited too long — there is no process running
while the job is still queued. A review that never starts at all therefore never escalates on this
path; it leaves the gate unreported, and branch protection's required-check requirement is what keeps
the pull request un-mergeable (spec Edge Cases → "Self-hosted runner offline"). That is the correct
failure — un-mergeable and quiet beats mergeable — but it is a different mechanism from FR-041's
escalation, and SC-017 is scoped to waits that end.

**Rationale**: `concurrency` with cancellation is the platform's own answer to "only the run examining
the current head may report", and cancelling the superseded run is stronger than letting it finish and
discarding its outcome. Using the runner's slot count as the cap is what makes Principle VIII's
"counts any CI or reviewer job executing on the same host" true by construction rather than by
agreement.

**Alternatives considered**: A dedicated reviewer runner outside the cap — rejected, explicitly
prohibited by FR-041 and Principle VIII; `cancel-in-progress: false` with post-hoc discard — rejected,
it burns tokens on a revision whose outcome is already known to be unusable.

---

## R-014: Structured logging (FR-033)

**Decision**: A ~40-line JSON-lines logger in `src/observability/`, writing one object per line to
stdout with `runId`, `timestamp`, `level`, `event`, and event-specific fields. No logging dependency.
A shared redaction step drops any value matching known credential shapes before serialization.

**Rationale**: FR-033 requires structured records carrying a run identifier and forbids bare prose;
that is a small amount of code, and Principle IV's "prefer the standard library and existing
dependencies" makes a logging framework hard to justify for it. Redaction lives at the single
serialization point so FR-032's "credentials must not appear in records" has exactly one place to be
right.

**Alternatives considered**: pino — rejected, a dependency for functionality measured in tens of
lines; `console.log` with manual `JSON.stringify` at call sites — rejected, it puts redaction and the
run identifier at every call site instead of one.

---

## R-015: End-to-end strategy (Principle II)

**Decision**: End-to-end tests run against a **real private fixture repository** on GitHub, using the
real App installation, real git, real branches, and real pull requests, with the model boundary
replaced by `ScriptedModelClient`. Assertions cover states entered, comments posted, verdicts
recorded, gate conclusion, and escalations — never generated wording.

**Rationale**: Principle II is unambiguous: e2e exercises the real system with exactly one
substitution, and "nothing else may be mocked." A fake GitHub server would mock the very boundary
this feature exists to integrate with, and every FR about permissions, check-run identity, and review
threads would go untested. GitHub is an explicitly allowed network dependency under Principle IV.

**Cost**: e2e consumes the platform API budget and the fixture repository's own quota. The suite is
budgeted for and scoped to the smallest pull requests that exercise each acceptance scenario.

**Alternatives considered**: Record/replay with `nock` — rejected, it mocks the platform boundary and
freezes API behavior at recording time; a local GitHub API simulator — rejected for the same reason,
with the added cost of maintaining a second implementation of the thing under test.

---

## R-016: Prerequisite verification and excluded paths (FR-051, FR-052, FR-053)

**Decision**: Three checks run before any model tokens are spent, in this order, each failing the gate
with a reason naming what is wrong and escalating.

1. **Permissions** (FR-003, FR-051) — the installation token response carries the `permissions` it was
   granted. The service compares that against the set [contracts/github-surface.md](contracts/github-surface.md)
   declares and fails on any absence, rather than discovering it mid-review as a `403`.
2. **Branch protection** (FR-025, FR-051) — `GET /repos/{o}/{r}/branches/{b}/protection` on the pull
   request's base branch, asserting the check run's name appears in `required_status_checks.contexts`.
   A `404` means the branch is unprotected, which is the failure case, not an error to retry. This
   requires `administration: read`, and it is the one permission whose corresponding **write** the
   installation must never hold.
3. **Reviewability** (FR-052, FR-037) — an empty or whitespace-only diff is refused outright: no
   verdict, no spend. An oversized diff fails with a split-the-pull-request reason.

Excluded paths (FR-053) are the union of what git reports as binary and the paths matching the
declared `excludedPathPatterns` setting — **no generated-file heuristic**. The resolved list is
recorded in the run's records and its count in the check-run output.

**Rationale**: a merge gate that branch protection does not require is the one failure mode that
leaves the service looking healthy while doing nothing — it reviews, posts findings, reports a failing
gate, and the pull request merges anyway because nothing required the check. One read turns the
quietest failure in the system into the loudest. Verifying rather than configuring is deliberate: an
identity that can write branch protection can remove the gate, so the service holds `administration:
read` and never the write.

The exclusion set is declared rather than inferred because a heuristic cannot be audited and can
silently over-match — an over-matching generated-file detector would drop real source from the
changed-line count, quietly shrinking a pull request under the Principle X cap. Build output is
already kept out of the repository by `.gitignore` and never reaches a diff, so the only exclusions
needed are things committed on purpose.

**Alternatives considered**: verifying branch protection lazily, on the first gate report — rejected,
tokens are already spent by then and FR-051 requires zero spend on a missing prerequisite;
*configuring* branch protection when absent — rejected outright, it requires a write permission that
would let the service remove its own gate; treating an empty diff as an automatic approval or an
automatic skip — rejected by FR-052, a verdict on a degenerate pull request makes it look ordinary,
and a skip is the non-failing gate Principle IV prohibits; detecting generated files by path
convention (`dist/`, `build/`, `*.min.js`) — rejected by FR-053 for the over-matching reason above.

---

## Open items deliberately left to implementation

- **Concrete cap values** for `maxReviewableDiffSize` and `maxPullRequestSize` (the latter defaults to
  400 per Principle X): set in the target repository's settings, informed by SC-013's ten-minute
  budget for a 1,000-line diff.
- **Effort level** for model calls: the one *optional* operating setting (FR-054), defaulting to
  `high` and reported with every run; sweep per SC-013.
- **Reviewer reserve fraction** of the token budget: an operating setting, no default in code.

## Sources

- [Rate limits for the REST API — GitHub Docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [REST API endpoints for check runs — GitHub Docs](https://docs.github.com/en/rest/checks/runs)
- [GraphQL mutations reference — GitHub Docs](https://docs.github.com/en/graphql/reference/mutations)
- [Necessary permissions for resolveReviewThread — GitHub Community Discussion #44650](https://github.com/orgs/community/discussions/44650)
