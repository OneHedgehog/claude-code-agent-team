# Feature Specification: The Bootstrap Exception

**Feature Branch**: `record-bootstrap-exception` — the Development Workflow deletes a feature branch
on merge, so cite this record's merge commit on `main` rather than this ref, which will not resolve

**Created**: 2026-08-30

**Status**: Recorded — the waiver is spent and cannot be drawn on again

**Input**: The merge gate could not review its own introduction. This records the waiver that
resolved it, the human who approved it, and the reason — in an artifact that is never rewritten.

## Why this is a spec and not a note in `docs/`

Principle VI requires a waived finding to carry "a recorded, human-approved reason". Principle IX
divides where such a record lives: a spec "records what was intended, at the time it was intended,
and is never rewritten", while `docs/` "is rewritten whenever that changes". A waiver belongs in the
first kind of artifact. It is a fact about one moment that must stay legible after the operator
documentation has moved on, and a reader asking "under what authority did this merge?" must not
depend on a page that is edited every time a prerequisite changes.

[docs/prerequisites.md](../../docs/prerequisites.md) §5 carries the operational form of this record —
the commands, the verified settings — and points here for the authority.

## What happened

[#1](https://github.com/OneHedgehog/claude-code-agent-team/pull/1) carried the whole service. The
service reviewed it and **refused it correctly**: 11,935 changed lines against a
`maxReviewableDiffSize` of 2,000 (FR-037), no review attempted, zero model tokens spent, the reason
stated on the pull request, and escalation issue #2 opened.

That refusal has no escape by design. FR-043's `## Size justification` clears the 400-line
discipline cap; FR-037 has none, because a diff too large to review is not made reviewable by
explaining itself. The pull request introducing FR-037 was therefore necessarily larger than FR-037
permits.

Spec 001 anticipated the shape of this problem — "the reviewers it creates cannot review the pull
request that creates them" — and provided for the first pull request to be reviewed by a human. It
did not anticipate the mechanics of *merging* that pull request once the gate was already required,
which is what this spec records.

## What was waived, and what was not

`main` required a passing `independent-review` check **and** one approving review. Removing the
check alone would not have been enough: GitHub does not permit approving one's own pull request, so
a sole author cannot satisfy the second requirement at all.

The minimal override was therefore `enforce_admins`: disabled, the merge performed, re-enabled. The
gate's configuration — the required context and the approving-review count — was never changed. The
exception is recorded as an administrator bypass rather than as a weakened gate, because that is
what it was.

**Verified after restoring:** `enforce_admins.enabled` is `true`,
`required_status_checks.checks` is `["independent-review"]`, `required_approving_review_count` is
`1`.

## Who approved it

[@OneHedgehog](https://github.com/OneHedgehog), the repository owner, performed the bypass and the
merge on 2026-08-30, on the reasoning recorded above. Principle V requires a human to approve an
establishing commit; this is that approval, named rather than implied.

## What it leaves unreviewed

Those 11,935 lines reached `main` with **no reviewer findings against them at all**. The service
never examined the change — it refused it on size before any role ran. Everything merged before this
record is unreviewed by construction. A future reader auditing this repository should treat the
merge commit of #1 as the boundary: below it, human reading only; above it, the gate.

## Scope, and expiry

This waiver applies **once**, to the change that introduced the gate. It authorizes no other
departure from Principle VI and no second bypass. It is already spent: the exception was closed when
`enforce_admins` was restored, and a later pull request over the reviewable limit gets split, which
is what FR-037 asks for.

## Success criteria

- **SC-001**: A reader can determine, from this spec alone, what was overridden, by whom, when, and
  why, without consulting a document that is rewritten as operations change.
- **SC-002**: The protection settings named above read back from GitHub exactly as recorded.
- **SC-003**: No pull request after #1 merges under an administrator bypass.
