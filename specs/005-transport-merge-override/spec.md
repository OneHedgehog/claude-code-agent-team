# Feature Specification: The Transport Merge Override

**Feature Branch**: recorded after the fact — cite this record's merge commit on `main`, not a ref

**Created**: 2026-09-06

**Status**: Draft — records an override performed on
[#9](https://github.com/OneHedgehog/claude-code-agent-team/pull/9)

**Input**: The subscription-backed transport was merged without the merge gate ever reporting
green. This records what was overridden, by whom, on what reasoning, and what it does not license.

## Why this is a spec

Principle VI requires a waived finding to carry a recorded, human-approved reason, and Principle IX
puts that record under `specs/`, which is never rewritten, rather than in `docs/`, which is. Spec
002 set the pattern for exactly this shape of event and this record follows it.

## What happened

[#9](https://github.com/OneHedgehog/claude-code-agent-team/pull/9) was reviewed **nine times** by
the service, through the transport it adds, on a host with no API credential. Every blocking finding
raised across those rounds was fixed or declined with a stated justification, and the replies are on
the pull request.

The gate never reported green, for two reasons that are properties of the situation rather than of
the change:

1. **A reviewer failed to produce a verdict on four of the nine rounds** — twice because the harness
   hit the operator's subscription session limit, and twice because a model response did not satisfy
   the review schema. The second is FR-059 working as specified: this transport asks for the schema
   in words rather than constraining generation, and a response that misses it is rejected rather
   than parsed. A green gate requires *both* roles to produce verdicts and zero blocking findings on
   the same revision, and that conjunction did not occur.

2. **The pull request sits against the FR-037 reviewability cap.** Nine rounds of review-mandated
   tests, specification and disclosure grew it from roughly 800 changed lines to the cap of 2,000 —
   the service refused to review it at all once, at 2,090 (escalation
   [#10](https://github.com/OneHedgehog/claude-code-agent-team/issues/10)), and it was brought back
   under by consolidating rationale into `specs/` rather than by raising the cap. At the time of
   the override it had roughly 16 lines of headroom, so a further round could not be absorbed.

## What was overridden, and what was not

`main` required the `independent-review` context and one approving review, with `enforce_admins`
enabled. Neither was satisfiable: the context had never gone green, and GitHub does not permit an
author to approve their own pull request, so a sole maintainer cannot satisfy the second at all.

The override was therefore `enforce_admins`: disabled, the merge performed, re-enabled. **The gate's
configuration was not changed** — not the required context, not the approving-review count, not
`maxReviewableDiffSize`. It is recorded as an administrator bypass rather than as a weakened gate,
because that is what it was.

Deliberately *not* done, and named so that no future reader mistakes their absence for oversight:

- `maxReviewableDiffSize` was not raised to admit this change. Weakening a limit to pass one's own
  work is what Principle IV forbids and what this pull request already had to escalate once.
- `required_status_checks.contexts` was not emptied.
- The transport was not merged to a branch with the gate removed.

## Who approved it

[@OneHedgehog](https://github.com/OneHedgehog), the repository owner, on 2026-09-06, having been
told before deciding that the gate had never reported green, that a reviewer had failed on four of
nine rounds, and that the alternative on offer was splitting `specs/003` into its own pull request
to buy iteration room.

Principle V requires a human on this merge independently of any of that: the change touches
dependency manifests and the reviewer's own operating settings, and carries waived findings — three
routes to the same escalation floor.

## What it does not license

- It does not license an agent to perform this override. Principle V reserves it for a human, and
  the decision above was taken by one after the option was put to them.
- It is spent. A second merge without a green gate needs its own record and its own approval.
- It says nothing about the correctness of the findings that were declined rather than fixed. Those
  are argued on the pull request and stand or fall on their own.

## What remains open at merge

**Waiver 2 of [spec 003](../003-subscription-backed-transport/spec.md) is recorded with an approval
quote about licensing, and waives Principle IV's no-degradation clause.** The service raised this on
five consecutive rounds. It was not closed before merging, and merging makes it permanent: a future
reader reconciling the `critical` finding `993ed16e56c5a372` against the record will find a
Principle IV waiver anchored to six words about a licence.

This is recorded as an open defect in the permanent record rather than resolved, because resolving
it means an operator stating in their own words what they approved, and an agent reconstructing that
more persuasively would make the record worse. It can still be closed by an amendment to spec 003.
