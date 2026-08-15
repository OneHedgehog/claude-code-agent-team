# Quickstart: Independent Review Service

**Feature**: 001-independent-review-service | **Date**: 2026-08-14

How to run the service and prove it works end to end. Validation scenarios map to the spec's
acceptance criteria; nothing here duplicates [data-model.md](data-model.md) or
[contracts/](contracts/).

---

## Prerequisites

Configured by a human out-of-band — the service depends on these and documents them, but does not
manage them (spec Assumptions, Dependencies):

1. **A GitHub App** installed on the target repository with the permissions in
   [contracts/github-surface.md](contracts/github-surface.md), distinct from every authoring identity.
2. **A self-hosted runner** on the developer machine, labelled `self-hosted,agents-host`, with its job
   slot count set to the host-wide concurrency cap (Principle VIII).
3. **Branch protection** on the default branch requiring the reviewer check run.
4. **Local credentials** on the runner host — `ANTHROPIC_API_KEY` in the environment or OS keychain,
   and the App's private key. Never in Actions secrets (FR-032).
5. **A private fixture repository** with the same App installed, for the end-to-end suite (R-015).

## Setup

```bash
npm ci
```

```bash
npm run build
```

## Configure the target repository

Create `<target>/.agents/settings.json` validated against
[contracts/settings.schema.json](contracts/settings.schema.json). The file is **shared by every agent
working on the repository**, each under its own top-level section; this service reads and validates
`reviewService` and ignores the rest (FR-050).

Every required key must be present under `reviewService` — a missing or invalid value stops the run
rather than falling back to a default (FR-028) — and an **unrecognized key inside that section also
stops the run**, because a typo in a budget is indistinguishable from a setting that was never
applied. Sibling sections are never validated and never rejected.

```json
{
  "reviewService": {
    "requiredReviewerRoles": ["security", "implementation"],
    "blockingSeverityThreshold": "high",
    "maxReviewRounds": 10,
    "maxReviewableDiffSize": 2000,
    "maxPullRequestSize": 400,
    "excludedPathPatterns": ["package-lock.json", "**/*.lock", "**/__snapshots__/**"],
    "tokenBudget": 20000000,
    "reviewerTokenReserve": 4000000,
    "platformApiBudget": 400,
    "platformApiReserve": 50,
    "maxRateLimitWaitSeconds": 3900,
    "maxQueueWaitSeconds": 1800,
    "escalationChannel": { "type": "github-issue", "assignee": "<github-login>" }
  }
}
```

`modelEffort` is the one **optional** setting (FR-054). Omitted, as above, the documented default
`"high"` applies and the effective value is reported with the run, so a value nobody chose is still a
value everybody can see. Every budget, reserve, threshold, and cap is required.

`excludedPathPatterns` is the only configurable source of exclusions. The service additionally
excludes whatever git reports as binary, and never infers exclusions from a generated-file heuristic —
build output is kept out of the repository by `.gitignore` and never reaches a diff (FR-053).

A later agent's settings sit beside this service's and are ignored by it:

```json
{
  "reviewService": { "…": "as above" },
  "orchestrator": { "humanApprovalRequired": true }
}
```

## Run a review

The target repository is always an explicit parameter. Running from an unrelated working directory is
the normal case, not an edge case (FR-026, SC-012):

```bash
node dist/cli.js review --target owner/name --checkout /path/to/checkout --pull-request 42
```

Omitting `--target` stops with an error rather than defaulting to the current directory (FR-027):

```bash
node dist/cli.js review --pull-request 42
```

## Test suites

The three correctness layers stay separate and are never conflated in one command (Principle II).

```bash
npm run test:unit
```

```bash
npm run test:integration
```

```bash
npm run test:e2e
```

```bash
npm run check
```

`check` runs lint, format check, type check, unit, and integration — the same command CI runs, so a
check that exists only in CI is impossible (Technology Constraints).

---

## Validation scenarios

Each drives the real flow against the fixture repository with `ScriptedModelClient` substituted at the
model boundary and nothing else replaced. Assertions cover states entered, comments posted, verdicts
recorded, and gate conclusion — never generated wording (FR-030).

| # | Scenario | Expected | Covers |
|---|---|---|---|
| 1 | Open a clean pull request | Both roles record `approve`; check run concludes `success` | US1 · SC-001 |
| 2 | Pull request adding a hardcoded credential | Blocking finding anchored to the introducing line, severity stated, `request-changes`, gate `failure` | US2 · SC-003 |
| 3 | Behavior change with no `docs/` update | Blocking finding from the implementation reviewer | US3 · SC-004 |
| 4 | Diff carrying an unrelated refactor | Blocking finding naming the unrelated content | US3 · SC-018 |
| 5 | Oversized pull request, no justification | Blocking size finding | US3 · SC-018 |
| 6 | Same pull request, justification in the description | Size finding does not fire; other checks still apply | US3 |
| 7 | Push a commit after approval | Gate **no longer reports** `success`; fresh review of the new revision; no prior verdict reused | US4 · SC-005 |
| 8 | Re-review where one finding is fixed and one stands | Fixed finding resolved, standing finding left open and not reposted, new finding added | US4 · SC-015 |
| 9 | Author replies with a justification the reviewer rejects | Finding stays open and blocking; gate `failure` | US4 · SC-019 |
| 10 | Author replies with a justification the reviewer accepts | Waiver request recorded and escalated; finding **not** resolved; gate does not pass | US4 · SC-019 |
| 11 | Re-trigger with no diff change and no reply | Stops before re-reviewing, zero tokens spent, gate `failure` stating no progress, escalation | US5 · SC-020 |
| 12 | Retry after a crashed round on the same revision | Not treated as a failed round; review proceeds | US5 · SC-020 |
| 13 | Model credentials absent | Zero spend, gate `failure`, escalation | US5 · SC-002 |
| 14 | Budget below what a review requires | Stops before spending, gate `failure` stating exhaustion, escalation | US5 · SC-009 |
| 15 | Budget drawn to the reviewer reserve by non-review spend | Review still runs; pull request still gated | SC-022 |
| 16 | Diff exceeding `maxReviewableDiffSize` | Zero tokens, no verdict, gate `failure` telling the author to split | US5 · SC-014 |
| 17 | Platform reserve reached mid-review | Calls stop, human notified, gate stays unreported while waiting, resumes after reset without reposting | SC-016 |
| 18 | Pull request authored by the reviewing identity | No approving verdict, gate not `success`, reason stated, escalation | US6 · SC-006 |
| 19 | Authoring identity attempts to report the gate | Refused for lack of permission | US1 · SC-007 |
| 20 | Security blocks what implementation accepts | Security finding stands, gate `failure`, contradiction recorded, no disagreement escalation | US1 · SC-023 |
| 21 | Any escalation | Notification through the configured channel **and** the reason stated on the pull request | SC-011 · SC-021 |
| 22 | Any concluded run | Records carry the run identifier; tokens consumed and budget remaining reported | US7 · SC-008 |
| 23 | Run from an unrelated working directory | Constitution, settings, and inspected paths all resolved through `--target` | US7 · SC-012 |
| 24 | Host concurrency cap full, wait under the maximum | Review queues, gate stays unreported, starts when a slot frees, never reports success or failure while queued | SC-017 |
| 25 | Queue wait exceeds `maxQueueWaitSeconds` | Human notified, gate `failure`, escalation | SC-017 |
| 26 | Merge gate not a required check on the base branch, and separately a missing installation permission | Zero tokens spent, no verdict, gate `failure` naming the missing prerequisite, escalation | US5 · SC-024 |
| 27 | Pull request whose diff is empty or whitespace-only | Refused rather than reviewed: zero spend, **no verdict from either role**, gate `failure` stating there is nothing to review, escalation | US5 · FR-052 |
| 28 | Settings carrying a sibling agent's section, an unknown key in `reviewService`, and no `modelEffort` | Sibling ignored; unknown own key stops the run; the documented default is applied and its effective value reported with the run | US7 · FR-050 · FR-054 |
| 29 | Diff touching a declared excluded path and a git-binary file | Both excluded from anchoring and from the changed-line count; neither blocks on its own; excluded paths recorded and their count in the check-run output | US3 · FR-053 |

Two criteria are properties of the suite rather than of any one scenario, and are checked as suite-level
assertions instead:

- **SC-010** — the end-to-end suite drives the complete flow with `ScriptedModelClient`, passes from a
  clean checkout, and contains zero assertions on generated wording. Enforced by a lint rule over
  `tests/e2e/` that fails on assertions against model-produced strings, plus a clean-checkout CI run.
- **SC-013** — a review of a diff up to 1,000 changed lines concludes within 10 minutes on the developer
  machine. Measured by a timed end-to-end case with a fixture diff of that size; the measurement also
  informs the `maxReviewableDiffSize` and `modelEffort` settings.

Scenarios 11, 12, 15, 17, 19, and 26 need fixture setup that the happy paths do not — a crashed prior
round, a pre-drawn ledger, a throttled installation, an authoring token, a fixture branch whose
protection omits the check. Each is arranged in the test's own setup, never by mocking the platform.

## Reading a run afterwards

Records are JSON lines on stdout, shaped by
[contracts/review-record.schema.json](contracts/review-record.schema.json):

```bash
node dist/cli.js review --target owner/name --checkout . --pull-request 42 | tee run.jsonl
```

```bash
jq -r 'select(.event == "state.entered") | "\(.timestamp) \(.state)"' run.jsonl
```

```bash
jq -r 'select(.event == "gate.reported") | "\(.gate.conclusion) \(.gate.reason // "")"' run.jsonl
```

Spend for the run also lands in the check-run output, which is what makes the cumulative total
reconstructible from GitHub when the local ledger is absent (FR-038).
