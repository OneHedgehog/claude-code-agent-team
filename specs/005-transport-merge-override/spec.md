# Feature Specification: The Transport Merge Override

**Feature Branch**: recorded after the fact — cite this record's merge commit on `main`, not a ref

**Created**: 2026-09-06

**Status**: Recorded — final. The events it describes are complete, and Principle IX means this file
is not rewritten. Records an override performed on
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
enabled. Neither was satisfied, and the reasons differ.

The context had never gone green. The approving review was missing for the same underlying reason,
not for a structural one: GitHub does not permit an author to approve their own pull request, but
the reviewer App is a separate identity and its approval *does* count — demonstrated on
[#6](https://github.com/OneHedgehog/claude-code-agent-team/pull/6), where a review by
`claude-agent-reviewer-app[bot]` alone moved the pull request to `APPROVED`. What blocked #9 was
that the reviewer never produced a verdict across nine rounds, so it never approved anything. An
earlier draft of this record said a sole maintainer "cannot satisfy the second at all", which would
have enshrined a recoverable failure as a permanent property of the repository.

The override was therefore `enforce_admins`: disabled, the merge performed, re-enabled — stated on
the operator's account and, for the first two steps, by inference from the merge having succeeded
against a gate that was never green. The absence of an audit log (see "Who approved it") is why
those two are inference rather than record, and this sentence is hedged where that section is
candid; an unhedged version of it is the sentence a later reader would have quoted.

**The third step is not inference.** `GET /repos/OneHedgehog/claude-code-agent-team/branches/main/protection`
answers `enforce_admins.enabled: true`, read 2026-09-10, with `required_status_checks.contexts` still
`["independent-review"]` and one required approving review. The protection is demonstrably back, and
that is the claim which bounds this override's blast radius, so it is the one worth evidencing rather
than asserting.

**The gate's configuration was not changed** — not the required context, not the approving-review
count, not `maxReviewableDiffSize`. It is recorded as an administrator bypass rather than as a
weakened gate, because that is what it was.

Deliberately *not* done, and named so that no future reader mistakes their absence for oversight:

- `maxReviewableDiffSize` was not raised to admit this change. Weakening a limit to pass one's own
  work is what Principle IV forbids and what this pull request already had to escalate once.
- `required_status_checks.contexts` was not emptied.
- The transport was not merged to a branch with the gate removed.

**Feature gate 4 (Principle X, size) was satisfied, not crossed** — the second unsatisfied gate a
reader reconciling this merge would otherwise be left to account for alone. #9 ran to roughly 2,000
non-lockfile lines against a `maxPullRequestSize` of 400, and its description carried the stated
irreducibility justification Principle X permits: an order-of-magnitude figure, the command that
re-derives it at any revision, and a "Why it cannot be smaller" section arguing that two-thirds is
test and specification each traceable to a specific finding. So gate 4 was met through the escape the
principle provides, and only gates 2 and 5 — the never-green review context — were overridden.

Note that `maxReviewableDiffSize` (FR-037, the service's refusal-to-review threshold) and
`maxPullRequestSize` (Principle X, the merge gate) are distinct settings with distinct defaults. The
two bullets above speak only to the former.

## Who approved it

**What the record can show.** [#9](https://github.com/OneHedgehog/claude-code-agent-team/pull/9) was
merged at `2026-09-06T11:05:06Z` by the `OneHedgehog` account, as merge commit
[`7e22757`](https://github.com/OneHedgehog/claude-code-agent-team/commit/7e22757e62). That is the
whole of the verifiable trail.

**What it cannot show, stated plainly rather than paraphrased.** There is no approving comment from
the operator on #9. The last comment on the pull request is at `09:54:36Z`, fifty-one minutes before
the merge, and it is an agent's round-7 reply; no comment follows the merge, and no human review was
submitted. The approval was given out of band — in the terminal session driving the agent — and no
artifact of it reached GitHub. **This record therefore contains no words of the approver's own**, and
the paraphrase an earlier draft carried, describing what they "had been told before deciding", has
been removed rather than kept: it was an agent's account of a human's reasoning, offered where the
human's own testimony belongs.

Two structural reasons it cannot be reconstructed after the fact, both worth naming because they
will recur:

- **The account is shared.** `OneHedgehog` is both the repository owner and the authoring agent's PAT
  identity. Every comment on #9 was written by the agent under that account, including one that
  addresses `@OneHedgehog` in the second person. The timeline cannot distinguish the human from the
  agent, so no amount of reading it establishes who said what.
- **There is no audit log.** `OneHedgehog` is a user account, not an organisation, and the audit-log
  API answers `404`. The `enforce_admins` toggle — off, merge, on — left no retrievable record. Its
  having happened is inferred from the merge succeeding against a gate that was never green.

This is the weakest part of the record, and it is left visible instead of being written around. A
Principle VI approval that survives only as an agent's summary is not a recorded human approval; it
is a claim about one. The remedy is procedural and belongs to the next occurrence, not to this file:
the operator states the reason in their own words, in a comment, before the override.

Principle V requires a human on this merge independently of any of that: the change touches
dependency manifests and the reviewer's own operating settings, and carries waived findings — three
routes to the same escalation floor.

## What it does not license

- It does not license an agent to perform this override. Principle V reserves it for a human, and
  the decision above was taken by one after the option was put to them.
- It is spent. A second merge without a green gate needs its own record and its own approval — and,
  on the standard set above, an approving comment written by the operator before the fact.
- It does not close the structural cause. The reviewer's failures across #9's nine rounds were
  subscription session limits and unsatisfied response schemas, both of which recur: the same two
  faults blocked [#5](https://github.com/OneHedgehog/claude-code-agent-team/pull/5) and
  [#6](https://github.com/OneHedgehog/claude-code-agent-team/pull/6) three days later. Until they are
  fixed, the next sizeable pull request reaches the same impasse. That is a known-open defect, not a
  standing licence to bypass the gate again.
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
more persuasively would make the record worse.

It can still be closed, and the mechanism matters: **by a new spec that cites 003 and closes waiver
2, filed under `specs/` as its own record** — not by editing
`specs/003-subscription-backed-transport/spec.md` in place. An earlier draft of this line said
"an amendment to spec 003", which pointed the next actor at exactly the rewrite this document's own
reason for existing forbids. Records supersede; they are not revised.
