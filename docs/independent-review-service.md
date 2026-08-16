# Independent Review Service

A GitHub App and workflow that reviews every pull request in a named target repository and gates its
merge. Two reviewer roles — security and implementation — read the diff, post line-anchored findings
carrying severity and an explicit blocking status, and each conclude with a stated verdict. A check
run, which only a GitHub App can create, carries the combined outcome.

**Spec**: [specs/001-independent-review-service/spec.md](../specs/001-independent-review-service/spec.md).
That document records what was intended when it was written and is never rewritten. This one records
what is true now.

> **Status: not yet operational.** The code below is built and tested, but the service cannot run
> against a real pull request until the [human prerequisites](#human-prerequisites) are met, and the
> merge gate itself is [blocked on a plan limitation](#the-merge-gate-is-blocked). Both are described
> honestly rather than hidden behind a green test suite.

## What it does

For each pull request, in order:

1. Resolves the target repository's constitution and operating settings **through an explicit
   `--target` parameter**, never through the working directory.
2. Verifies its own prerequisites before spending anything — the permissions it holds, and that its
   check run is a required check on the base branch.
3. Refuses to review its own work, an empty diff, an oversized diff, a stalled round, or a round past
   the cap — each with a stated reason and zero model spend.
4. Runs the security and implementation reviewers against the diff.
5. Posts each role's findings as one batched review, anchored to the offending line where the
   location is addressable and at pull-request level where it is not.
6. Reconciles against its own prior findings: resolves what the revision no longer exhibits, leaves
   standing what it does, adds what is new. It never reposts, and never resolves a finding it did
   not see fixed.
7. Reports a single check run: `success`, `failure` with a reason, or nothing at all.

Every push invalidates prior approvals, because the gate is recreated for the new head SHA and a
stale approval has nothing to attach to.

## How it works

### Control flow

The run is an XState statechart declared as data in [`src/review/machine.ts`](../src/review/machine.ts).
The diagram below is generated from that declaration by
[`scripts/generate-diagram.ts`](../scripts/generate-diagram.ts) and checked in `npm run check`, so it
cannot drift from the behavior.

<!-- BEGIN GENERATED STATECHART -->

```mermaid
stateDiagram-v2
  [*] --> resolvingSettings
  resolvingSettings --> failingGate: SETTINGS_RESOLVED [settingsInvalid]
  resolvingSettings --> checkingPrerequisites: SETTINGS_RESOLVED
  checkingPrerequisites --> failingGate: PREREQUISITES_CHECKED [permissionsMissing]
  checkingPrerequisites --> failingGate: PREREQUISITES_CHECKED [gateNotRequiredByBranchProtection]
  checkingPrerequisites --> checkingIdentity: PREREQUISITES_CHECKED
  checkingIdentity --> escalating: IDENTITY_CHECKED [selfAuthored]
  checkingIdentity --> checkingProgress: IDENTITY_CHECKED
  checkingProgress --> escalating: PROGRESS_CHECKED [roundCapExceeded]
  checkingProgress --> escalating: PROGRESS_CHECKED [noForwardProgress]
  checkingProgress --> checkingSize: PROGRESS_CHECKED
  checkingSize --> failingGate: SIZE_CHECKED [diffEmpty]
  checkingSize --> failingGate: SIZE_CHECKED [diffExceedsReviewableSize]
  checkingSize --> checkingBudgets: SIZE_CHECKED
  checkingBudgets --> escalating: BUDGETS_CHECKED [tokenBudgetExhausted]
  checkingBudgets --> escalating: BUDGETS_CHECKED [rateLimitWaitExceeded]
  checkingBudgets --> waitingForReset: BUDGETS_CHECKED [platformReserveReached]
  checkingBudgets --> reviewing: BUDGETS_CHECKED
  reviewing --> reconciling: REVIEW_COMPLETED
  reconciling --> reportingGate: RECONCILED
  reportingGate --> done: GATE_REPORTED
  failingGate --> escalating: GATE_REPORTED
  escalating --> halted: ESCALATED
  waitingForReset --> checkingBudgets: RESET_ELAPSED
  anyState --> failingGate: ERROR
  done --> [*]
  halted --> [*]
  note right of anyState
    Available from every state (FR-023).
  end note
```

<!-- END GENERATED STATECHART -->

`checkingPrerequisites` sits immediately after `resolvingSettings` because both verifications must
complete before any model tokens are spent, and because a gate nothing enforces makes every later
state pointless.

### The pieces

| Area | Module | Does |
|---|---|---|
| Addressing | [`config/target.ts`](../src/config/target.ts) | Resolves every path through `--target`; no `process.cwd()` fallback |
| Settings | [`config/settings.ts`](../src/config/settings.ts) | Validates the `reviewService` section strictly, ignores siblings |
| Model | [`model/client.ts`](../src/model/client.ts) | The one substitutable boundary; `anthropic.ts` and `scripted.ts` implement it |
| Platform | [`github/`](../src/github/) | App auth, pull request and diff reads, the check run, reviews, review threads, rate limits |
| Review logic | [`review/`](../src/review/) | Roles, rules, findings, locations, reconciliation, waivers, progress, precedence, the gate |
| Ledger | [`ledger/`](../src/ledger/) | Cumulative token spend with a reviewer reserve, reconstructible from check runs |
| Observability | [`observability/`](../src/observability/) | JSON-lines records with redaction; escalation |

### Two identities, and why the separation is structural

| Identity | Holds | Never holds |
|---|---|---|
| **Reviewing** — the App installation | `checks: write`, `pull_requests: write`, `contents: write`, `issues: write`, `administration: read` | Write on branch protection or administration |
| **Authoring** — used by later features | `contents: write` on feature branches | `checks: write` |

GitHub enforces the part that matters: **only GitHub Apps can create check runs.** An authoring
token cannot report this gate whatever scopes it carries. That is a platform guarantee, not a
convention this service maintains.

## How to run it

```bash
npm run check
```

Runs build, lint, format, types, the diagram check, unit tests, and integration tests — exactly what
CI runs, because a check that only exists in CI is prohibited.

```bash
node dist/cli.js --target owner/name --checkout /path/to/checkout --pull-request 42
```

A missing `--target` stops with an error rather than defaulting to the working directory.

Settings live at `<target>/.agents/settings.json` under a `reviewService` section, validated against
[`schemas/settings.schema.json`](../schemas/settings.schema.json). Every budget, reserve, threshold
and cap is required; `modelEffort` is the one optional setting, and its effective value is reported
with every run.

## Decisions and trade-offs

**The model call is behind an interface** so end-to-end tests drive the entire flow with a scripted
double and nothing else mocked. Findings come back through structured outputs rather than prose, so
no test ever asserts on generated wording.

**The gate never reports `neutral`, `skipped`, or `cancelled`.** GitHub treats the first two as
non-failing, which is exactly the absent gate that reads as no objection. Every inability to review
is a `failure` with a reason. A run still waiting reports nothing at all rather than reporting
something reassuring.

**State lives on GitHub, not on disk.** Round history, spend, and the excluded-path count are written
into each round's check-run output, so the next round rebuilds them from GitHub alone. The local
JSONL ledger is a cache; a disagreement between the two escalates rather than being silently
corrected.

**Exclusions are declared, never inferred.** The excluded set is what git reports as binary plus the
configured `excludedPathPatterns`, and nothing else. A generated-file heuristic cannot be audited and
can silently over-match — dropping real source from the changed-line count and quietly shrinking a
pull request under the size cap.

**Progress is measured by revision and reply, never by elapsed time.** A slow author is not a stalled
one. An unconcluded round is ignored entirely as a baseline, which is what stops a retry after a
crash from being mistaken for an author who pushed nothing.

**The service verifies branch protection; it never configures it.** An identity that can write branch
protection can remove its own gate.

### Two least-privilege tensions, recorded rather than hidden

- **`contents: write`** — resolving a review thread is available only through the GraphQL
  `resolveReviewThread` mutation, which requires it. There is no REST equivalent: review threads are
  not exposed there at all. Without it, reconciliation is unimplementable and the comment history
  grows without bound.
- **`administration: read`** — verifying the gate is a required check needs it. The corresponding
  *write* is precisely what the installation must never hold.

### What is deliberately deferred

Process-level containment — filesystem scope, per-agent CPU and memory limits, restricted egress —
is **not** implemented. The constitution requires the sandboxing runtime to be settled by a file-I/O
spike on the host platform before adoption, and that spike is not this feature. What is *not*
deferred is the part achievable through permissions: the reviewing identity structurally cannot
merge, cannot push, and cannot alter branch protection.

## Human prerequisites

None of these can be done by the service. An identity that can provision its own gate can remove it.

| Prerequisite | Blocks | Notes |
|---|---|---|
| **GitHub App** created and installed on both repositories, permissions as above, private key in the runner's environment or keychain | Every end-to-end test, and real operation | Only an App can create a check run; no PAT substitutes at any scope |
| **Private fixture repository** | Every end-to-end test | Cannot be the target repository: one scenario needs a branch where the gate is deliberately *not* required |
| **Self-hosted runner** registered, job-slot count set to the host-wide concurrency cap | Every end-to-end test, and real operation | Reviewer jobs take an ordinary slot |
| **`ANTHROPIC_API_KEY`** in the runner's local environment or keychain | Production runs | Never in Actions secrets — that would put the model credential inside the blast radius of the pull requests it reviews |
| **Branch protection** requiring the check on the default branch | Real operation | See below |

## The merge gate is blocked

The target repository is **private on GitHub Free**, which offers neither branch protection nor
rulesets. Both endpoints return `403 Upgrade to GitHub Pro or make this repository public to enable
this feature.`

The service verifies that its check run is a *required* check before every review, and treats a
missing required check as `failure` + escalate + zero spend. Built as specified against this
repository today, it would refuse to review anything, permanently. So
[`github/branch-protection.ts`](../src/github/) and the prerequisite check that consumes it are
**not implemented**, and the statechart's `gateNotRequiredByBranchProtection` guard has no producer
yet.

Resolving it needs one of: making the repository public, upgrading to GitHub Pro, or moving it to an
organization on Team or above.

Note that a `403` here has two causes that must never be collapsed:

| Message | Means |
|---|---|
| `Resource not accessible by personal access token` | The grant really is missing |
| `Upgrade to GitHub Pro or make this repository public…` | The plan does not offer the feature; the grant may well be held |

Verified against this repository: the token **holds** `administration: read` — `/keys`, `/autolinks`,
`/actions/permissions` and `/actions/runners` all return `200` — and still gets `403` on
`/branches/main/protection`. Reporting the second case as a missing permission sends an operator
hunting a grant they already have.

## Test layers

| Layer | Model | Gates merge | Status |
|---|---|---|---|
| Unit | Not invoked | Yes | 503 tests passing |
| Integration | Not invoked | Yes | 52 tests passing |
| End-to-end | Scripted double | Yes | **Not yet runnable** — needs the App and fixture repository |

End-to-end tests exercise real git, real branches, real pull requests, with only the model boundary
substituted. They assert on states entered, comments posted, verdicts recorded, gate conclusion, and
escalations — never on generated wording.
