# Contract: GitHub platform surface

Every platform call the service makes, the identity that makes it, the permission it needs, and the
requirement it serves. This is the contract that makes FR-022's identity separation checkable rather
than assumed.

## Identities

The reviewing identity is distinct from every authoring identity used in the repository (FR-002), and
each holds only the permissions its own work requires (FR-003).

| Identity | Holds | Never holds |
|---|---|---|
| **Reviewing identity** — the GitHub App installation | `checks: write`, `pull_requests: write`, `contents: write`¹, `issues: write`, `administration: read`² | **Write** on branch protection or repository administration — an identity that can change branch protection can remove the gate |
| **Authoring identity** — used by later features | `contents: write` on feature branches | `checks: write` — structurally cannot report the merge gate |

GitHub enforces the separation for us at the point that matters: **only GitHub Apps can create or
update check runs**. An authoring token cannot satisfy this gate even if it tries (FR-022, SC-007).

## Calls

| Purpose | API | Permission | Requirement |
|---|---|---|---|
| Verify the installation's own permissions | `GET /installation` (token response `permissions`) | none beyond authentication | FR-003, FR-051 |
| Verify the gate is a required check on the target branch | `GET /repos/{o}/{r}/branches/{b}/protection` | `administration: read`² | FR-025, FR-051 |
| Read the pull request, author, head SHA | `GET /repos/{o}/{r}/pulls/{n}` | `pull_requests: read` | FR-001, FR-004, FR-009 |
| Read the diff | `GET /repos/{o}/{r}/pulls/{n}` (diff media type) | `pull_requests: read` | FR-037, FR-043, FR-052 |
| Read prior rounds' outcomes (progress baseline) | `GET /repos/{o}/{r}/commits/{sha}/check-runs` | `checks: read` | FR-020, FR-046 |
| Create the merge gate | `POST /repos/{o}/{r}/check-runs` | `checks: write` | FR-021, FR-022 |
| Update the gate's conclusion and output | `PATCH /repos/{o}/{r}/check-runs/{id}` | `checks: write` | FR-023, FR-024, R-010 |
| Post a role's findings and verdict | `POST /repos/{o}/{r}/pulls/{n}/reviews` | `pull_requests: write` | FR-006, FR-010, FR-014 |
| Read prior findings and replies | GraphQL `pullRequest.reviewThreads` | `pull_requests: read` | FR-039, FR-044, FR-046 |
| Resolve a fixed finding | GraphQL `resolveReviewThread` | `contents: write`¹ | FR-039 |
| State an escalation reason on the pull request | `POST /repos/{o}/{r}/issues/{n}/comments` | `issues: write` | FR-035 |
| Open or update an escalation issue | `POST /repos/{o}/{r}/issues`, `PATCH .../issues/{n}` | `issues: write` | FR-035, R-012 |

¹ Resolving a review thread requires repository `contents` read **and write** on the installation —
a wider permission than the rest of this feature needs. Recorded as a known least-privilege tension:
version one accepts it because FR-039's reconciliation is otherwise unimplementable, and no other
call in this table writes repository contents.

² Reading branch protection requires `administration: read`, the second least-privilege tension in
this feature, and it is accepted for the reason FR-051 states: a merge gate that is not a required
check is the one failure that leaves the service looking healthy while doing nothing — it reviews,
posts findings, reports a failing gate, and the pull request merges anyway because nothing required
the check. Reading costs one request and turns the quietest failure in the system into a loud one.
The corresponding **write** is exactly what the installation must not hold, since an identity that
can change branch protection can remove the gate: the service verifies and reports, never configures
(FR-051, spec Assumptions → Branch protection).

## Prerequisite verification (FR-051)

Both checks run before any model tokens are spent, and a missing prerequisite fails the gate naming
it and escalates.

| Prerequisite | How it is verified | On failure |
|---|---|---|
| The reviewing identity holds every permission its work requires (FR-003) | Compare the installation token's `permissions` against the set this table requires | `failure`, reason names the missing permission, escalate, zero spend |
| The merge gate is a required check on the pull request's base branch (FR-025) | The check run's name appears in `required_status_checks.contexts` for the base branch | `failure`, reason names the missing branch protection, escalate, zero spend |

A `404` on the protection endpoint means the branch is unprotected, which is the failure case, not an
error to retry.

A `403` has **two causes that must be reported differently**, distinguished by the response message:

| Message | Cause | Reported as |
|---|---|---|
| `Resource not accessible by personal access token` (or `by integration`) | The installation lacks `administration: read` | The *first* prerequisite failing |
| `Upgrade to GitHub Pro or make this repository public to enable this feature.` | The repository's plan does not offer branch protection — private repositories on GitHub Free have neither branch protection nor rulesets | Not a permission fault at all: the gate **cannot** be made required until the plan or visibility changes. Naming it as a missing permission sends the operator hunting a grant that is already held. |

Collapsing these two was verified to be wrong against a real repository: on a private GitHub Free
repository an installation holding `administration: read` — proven by `GET /repos/{o}/{r}/keys`,
`/autolinks`, `/actions/permissions` and `/actions/runners` all returning `200` — still receives
`403` on `/branches/{b}/protection`. The `/rulesets` endpoint settles it: GitHub reports its
requirement as `metadata: read`, and it returns the same upgrade `403`.

## Conclusion mapping

| Situation | Check-run conclusion |
|---|---|
| Every required role approved the current revision, no standing blocking findings, no outstanding waiver | `success` |
| Any blocking finding stands, any role requested changes, or a waiver is outstanding | `failure` |
| Any inability to review — startup failure, mid-run error, missing credentials, missing permission, gate not required by branch protection, empty or whitespace-only diff, budget exhaustion, oversized diff, failed round, round cap, self-authored | `failure`, with a reason (FR-023, FR-024, FR-051, FR-052) |
| Queued for a host slot, or waiting for a rate-limit reset, within the configured maximum | **not reported** — the check run is not created or is left `in_progress` (FR-040, FR-041) |

`neutral`, `skipped`, and `cancelled` are never used. GitHub treats the first two as non-failing, which
is precisely the "absent gate that reads as no objection" Principle IV prohibits.

## Rate-limit handling

| Signal | Response |
|---|---|
| `x-ratelimit-remaining` at or below `platformApiReserve` | Stop issuing calls, notify, wait for `x-ratelimit-reset`, resume (FR-040) |
| `retry-after` header present | Honor it exactly; never retry sooner |
| Wait would exceed `maxRateLimitWaitSeconds` | Fail the gate, escalate |

Ceilings observed rather than assumed: the installation's primary limit (5,000/hour minimum, scaling
to 12,500) comes from the response headers, and the binding secondary ceiling — **80 content-creating
requests per minute, 500 per hour** — is what `platformApiBudget` is configured against.

## Workflow trigger and concurrency

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: [self-hosted, agents-host]
```

`cancel-in-progress: true` implements FR-019: a run superseded by a newer push is cancelled rather
than allowed to finish and report against a stale revision. The self-hosted runner's configured job
slot count is the host-wide concurrency cap; reviewer jobs occupy an ordinary slot and are never
exempted (FR-041, Principle VIII).

## Out of scope for this feature

Managing branch protection and provisioning the App installation are configured by a human
out-of-band, as the spec's Assumptions record — an identity that can change branch protection can
remove the gate.
