# Phase 1 Data Model: Independent Review Service

**Feature**: 001-independent-review-service | **Date**: 2026-08-14

Entities from the [spec](spec.md)'s Key Entities, given concrete fields, validation rules, and
lifecycles. Every type is TypeScript in strict mode; every boundary type has a JSON Schema under
[contracts/](contracts/).

---

## TargetRepository

The repository under review, supplied as an explicit parameter (FR-026, FR-027).

| Field | Type | Notes |
|---|---|---|
| `owner` | `string` | Non-empty |
| `name` | `string` | Non-empty |
| `checkoutPath` | `string` | Absolute path to the working tree the run inspects |

**Validation**: constructed only from the CLI parameter. No default, no fallback to `process.cwd()`,
no built-in identity (FR-027). Every path the service reads is resolved against `checkoutPath`; a
resolved path escaping it is a hard error, not a warning.

---

## OperatingSettings

Read from the `reviewService` section of `<target>/.agents/settings.json`, validated against
[contracts/settings.schema.json](contracts/settings.schema.json) (FR-028).

**The file is shared, and namespaced** (FR-050). Every agent working on the target repository keeps
its settings under its own top-level section. This service validates the `reviewService` section
**strictly** — an unrecognized key there is an error that stops the run, because a silently ignored
typo in a budget or a threshold is indistinguishable from a setting that was never applied — and
**ignores sibling sections** belonging to other agents rather than rejecting them. Validating the
whole file strictly would reject the settings a later agent adds, failing the gate on a configuration
error and leaving nothing able to merge.

**Required settings** — a missing or invalid value stops the run (FR-028, FR-054):

| Field | Type | Meaning |
|---|---|---|
| `requiredReviewerRoles` | `RoleName[]` | Roles whose approval the gate requires |
| `blockingSeverityThreshold` | `Severity` | Lowest severity that blocks (FR-013) |
| `maxReviewRounds` | `integer ≥ 1` | Round cap per pull request (FR-020) |
| `maxReviewableDiffSize` | `integer ≥ 1` | Changed lines past which no review is attempted (FR-037) |
| `maxPullRequestSize` | `integer ≥ 1` | Principle X cap; justification clears it (FR-043) |
| `excludedPathPatterns` | `string[]` | Declared exclusions; the only configurable source (FR-053) |
| `tokenBudget` | `integer ≥ 1` | Cumulative repository-wide total (FR-031) |
| `reviewerTokenReserve` | `integer ≥ 0` | Share drawable by review work only (FR-047) |
| `platformApiBudget` | `integer ≥ 1` | Content-creating requests per hour |
| `platformApiReserve` | `integer ≥ 0` | Stop-and-wait threshold (FR-040) |
| `maxRateLimitWaitSeconds` | `integer ≥ 1` | Past this, fail and escalate (FR-040) |
| `maxQueueWaitSeconds` | `integer ≥ 1` | Past this, fail and escalate (FR-041) |
| `escalationChannel` | `ChannelConfig` | Transport plus its configuration (FR-035) |

**Optional settings** — absence is filled from the documented default in the schema rather than
stopping the run, and the effective value is reported with the run so that no behavior depends on a
value nobody can see (FR-054):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `modelEffort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"high"` | Depth/cost trade-off |
| `escalationChannel.label` | `string` | `"escalation"` | Label applied to the escalation issue |

Every budget, reserve, threshold, and cap is required; review depth is the one lever a repository may
leave unset before its first review.

**Invariants**, enforced in code immediately after schema validation because JSON Schema cannot
express them, with the same stop-the-run consequence as a missing required key:
`reviewerTokenReserve < tokenBudget`; `platformApiReserve < platformApiBudget`;
`maxReviewableDiffSize > maxPullRequestSize` (the reviewability cap sits above the discipline cap —
otherwise FR-043 could never fire).

---

## ExcludedPaths

Determined per run, never inferred (FR-053).

| Source | Rule |
|---|---|
| Version control | Whatever git reports as binary |
| Operating settings | Paths matching `excludedPathPatterns` |

Nothing else excludes a path. There is **no generated-file heuristic**: build output is kept out of
the repository by `.gitignore` and never reaches a diff, so what remains is committed by design —
lockfiles, snapshots, and binaries such as images or fonts. Because the set is declared rather than
guessed, it cannot silently over-match.

Excluded paths are removed from line-anchored finding placement and from the changed-line count that
`maxPullRequestSize` (FR-043) and `maxReviewableDiffSize` (FR-037) are measured against. Their
presence alone never blocks. The resolved list is recorded in the run's structured records and its
count is reported in the check-run output (FR-053).

---

## ReviewRun

One review of one pull request revision — one round (FR-033, FR-046).

| Field | Type | Notes |
|---|---|---|
| `runId` | `string` | Ties every record to this run |
| `target` | `TargetRepository` | |
| `pullRequestNumber` | `integer` | |
| `headSha` | `string` | The exact revision examined (FR-009) |
| `roundNumber` | `integer ≥ 1` | Counted per pull request (FR-020) |
| `startedAt` / `endedAt` | `timestamp` | |
| `concluded` | `boolean` | Only a concluded run is a progress baseline (FR-046) |
| `roleResults` | `RoleResult[]` | One per required role that ran |
| `gateConclusion` | `"success" \| "failure" \| "unreported"` | Never neutral or skipped (FR-023) |
| `tokensConsumed` | `integer` | Reported per run (FR-031) |
| `budgetRemaining` | `integer` | |
| `platformRequestsUsed` | `integer` | Content-creating requests this run (FR-040) |
| `excludedPaths` | `string[]` | Paths excluded from anchoring and counting; count reported (FR-053) |
| `effectiveOptionalSettings` | `Record<string, unknown>` | Optional settings and the values actually applied (FR-054) |

**State machine** (XState, per R-009 — this declaration is the source of the generated diagram):

```
resolvingSettings → checkingPrerequisites → checkingIdentity → checkingProgress → checkingSize
  → checkingBudgets → reviewing → reconciling → reportingGate → done
```

Guarded exits, each terminal or looping rather than falling through:

| From | Guard | To |
|---|---|---|
| `resolvingSettings` | required setting missing or invalid, unknown key in own section, or invariant violated | `failingGate` then `escalating` (FR-028, FR-050), zero spend |
| `checkingPrerequisites` | a permission the work requires is absent | `failingGate` then `escalating` (FR-003, FR-051), zero spend |
| `checkingPrerequisites` | the gate is not a required check on the base branch | `failingGate` then `escalating` (FR-025, FR-051), zero spend |
| `checkingIdentity` | author is the reviewing identity | `escalating` (FR-004) |
| `checkingProgress` | no diff change and no reply since last concluded round | `escalating` (FR-046) |
| `checkingProgress` | `roundNumber > maxReviewRounds` | `escalating` (FR-020) |
| `checkingSize` | diff empty or whitespace-only after exclusions | `failingGate` then `escalating` (FR-052), zero spend, **no verdict** |
| `checkingSize` | changed lines > `maxReviewableDiffSize` | `failingGate` (FR-037), zero spend |
| `checkingBudgets` | remaining tokens below required | `escalating` (FR-031) |
| `checkingBudgets` | platform requests at reserve | `waitingForReset` → `checkingBudgets`, or `escalating` past `maxRateLimitWaitSeconds` (FR-040) |
| any | unhandled error | `failingGate` then `escalating` (FR-023) |

`checkingPrerequisites` sits immediately after `resolvingSettings` and before every other check
because FR-051 requires both verifications *before any model tokens are spent*, and because a gate
nothing enforces makes every later state pointless.

The empty-diff exit records **no verdict for either role**. A verdict policy for a degenerate pull
request would make it a normal case; refusing makes it visibly abnormal (FR-052).

`escalating` always precedes `halted` and always both notifies and states its reason on the pull
request (FR-035). `halted` never reports the gate as success, neutral, or skipped.

**Staleness**: the machine has no path that reads a stored verdict. `reviewing` is entered on every
run — on a push and equally on a re-run against an already-reviewed revision — and always re-derives
verdicts from the current diff (FR-017). Prior approvals are never carried across a push: the gate is
recreated for the new head SHA, so a stale approval has nothing to attach to (FR-018), and the
superseded run is cancelled by the workflow's concurrency group rather than allowed to report
(FR-019).

**Round history and the progress baseline**: FR-020's round count and FR-046's forward-progress check
both need the *previous concluded round* for the pull request, which no single run holds. That
history lives where Principle VII requires every state to live — **on GitHub**, in the output of each
round's check run:

| Recorded in the check-run output | Read by the next round for |
|---|---|
| `roundNumber` | The round cap (FR-020) |
| `headSha` | Whether the revision changed since the last concluded round (FR-046) |
| `concluded` | Whether this round may serve as a baseline at all (FR-046) |
| Open blocking finding fingerprints and the timestamp the round concluded | Whether any of them received a reply since (FR-046) |
| `tokensConsumed`, `budgetRemaining`, excluded-path count | Ledger reconstruction (FR-038) and FR-053 reporting |

The next round enumerates the check runs the reviewing identity created on the pull request's
commits, takes the most recent with `concluded = true` as its baseline, and ignores unconcluded ones
entirely — which is what keeps a retry after a crash, a budget stop, or a queue timeout from being
mistaken for a stalled author (FR-046). The local JSONL is a cache of the same facts and is never the
authority.

---

## ReviewerRole

| Field | Type | Notes |
|---|---|---|
| `name` | `"security" \| "implementation"` | Version one runs exactly these two roles (FR-005) |
| `precedence` | `integer` | Lower is higher authority; `security` is highest (FR-048) |
| `promptTemplate` | `string` | Role instructions; diff and comments enter as delimited data |

**Precedence rule**: a blocking finding from a higher-precedence role stands against any
lower-precedence role's contrary conclusion, the contradiction is recorded, and no disagreement
escalation fires. A contradiction between equal-precedence roles stops the review and escalates
(FR-049) — unreachable in version one, where the only two roles have distinct precedence.

---

## Finding

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Content fingerprint — role + rule + path + normalized hash (R-006) |
| `role` | `RoleName` | |
| `severity` | `"critical" \| "high" \| "medium" \| "low"` | Fixed declared scale (FR-011) |
| `blocking` | `boolean` | Stated explicitly, not inferred from severity (FR-012) |
| `location` | `DiffLocation \| PullRequestLevel` | Anchored when addressable (FR-010, FR-014) |
| `description` | `string` | |
| `status` | `"open" \| "resolved" \| "waiver-requested"` | |
| `waiver` | `WaiverRequest \| null` | Present only when `status = "waiver-requested"` |

**Lifecycle**: `open` → `resolved` only when the revision under review no longer exhibits it
(FR-039); `open` → `waiver-requested` only when the service accepts an author's stated justification
(FR-044). A `waiver-requested` finding is **never** resolved by reconciliation — the code still
exhibits it — and holds the gate until a human grants the waiver (FR-045).

**Blocking derivation**: `blocking = severity >= blockingSeverityThreshold`, evaluated once at
creation and then stated explicitly on the finding, so a later threshold change cannot silently
reinterpret an already-posted finding.

### WaiverRequest

| Field | Type | Notes |
|---|---|---|
| `justification` | `string` | The author's stated reason, verbatim |
| `acceptanceReason` | `string` | Why the reviewer accepted it |
| `revision` | `string` | The head SHA it was raised against |

---

## Verdict

| Field | Type | Notes |
|---|---|---|
| `role` | `RoleName` | |
| `decision` | `"approve" \| "request-changes"` | Never inferred from silence (FR-007) |
| `revision` | `string` | Bound to the revision examined (FR-009) |

**Rules**:

- Absence of a verdict is a role failure, represented as an explicit `MissingVerdict` result rather
  than as `undefined` — there is no code path where a missing verdict can be read as approval (FR-007).
- A role's decision is derived from its own findings, not asserted independently: any standing blocking
  finding forces `request-changes`, and `approve` is unreachable while one stands (FR-008). A finding
  accepted as justified no longer stands as blocking for this derivation, but the gate is still held by
  the outstanding waiver (FR-045).

---

## MergeGate

| Field | Type | Notes |
|---|---|---|
| `checkRunId` | `number` | Created by the App installation only (FR-022, R-005) |
| `conclusion` | `"success" \| "failure"` | |
| `reason` | `string` | Required whenever `failure` (FR-024) |
| `revision` | `string` | Only the current head may report (FR-019) |

**Passing requires all of**: every required role approved the current revision, zero standing
blocking findings, zero outstanding waiver requests (FR-045), and the run concluded.

---

## BudgetLedger

Repository-wide, shared across every agent, surviving between runs (FR-038, FR-047).

| Field | Type | Notes |
|---|---|---|
| `targetRepository` | `string` | `owner/name` |
| `entries` | `LedgerEntry[]` | Append-only |

### LedgerEntry

| Field | Type | Notes |
|---|---|---|
| `runId` | `string` | |
| `at` | `timestamp` | |
| `actor` | `"review" \| string` | Only `review` may draw on the reserve |
| `resource` | `"tokens" \| "platform-requests"` | |
| `amount` | `integer ≥ 0` | |

**Pre-spend check**: review work passes when `spent + estimate ≤ tokenBudget`; non-review work passes
when `spent + estimate ≤ tokenBudget − reviewerTokenReserve`. Platform requests are tracked
separately because they refill (FR-040) — reaching their reserve pauses and resumes rather than
hard-stopping.

**Addressing** (FR-047): the ledger is a repository-wide resource, not a reviewer-private total, so
later features record against *this* ledger rather than keeping their own. It is addressed by target
repository and exposes exactly two operations:

| Operation | Signature | Rule |
|---|---|---|
| Pre-spend check | `check(target, actor, resource, estimate) → allowed \| denied(reason)` | Applies the reserve rule above; `actor = "review"` is the only actor permitted to draw into `reviewerTokenReserve` |
| Record | `record(entry: LedgerEntry) → void` | Append-only; never rewrites or compacts an existing entry |

The append-only JSONL file at a fixed path under the runner host's state directory, keyed by
`owner/name`, is the version-one implementation of that interface — a cache whose authoritative
counterpart is the check-run outputs. Writing this feature's own spend is in scope; **wiring other
agents' spend into it is not** (spec Out of Scope), which is why the obligation here is that the
interface exists and is addressable, not that a second caller exists yet.

**Reconstruction**: each run writes `tokensConsumed` and `budgetRemaining` into its check-run output,
so the total is rebuildable from GitHub with the local JSONL file absent (R-010). A disagreement
between the two sources escalates.
