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
`claude-agent-reviewer-app[bot]` alone moved the pull request to `APPROVED`. #6 also appears below
as one of the pull requests the reviewer's recurring faults later blocked; both are true and they do
not compete. An approving review from one role is not a green gate, which needs *both* roles to
produce verdicts and zero blocking findings on one revision — so #6 demonstrates that the identity
is eligible to approve, not that its gate ever closed. What blocked #9 was that the conjunction
never occurred, as stated in "What happened" above: a role produced no verdict at all on four of the
nine rounds, and on the rest the two verdicts and zero blocking findings never coincided on one
revision. The reviewer was not silent across all nine — it raised the findings that were argued and
answered — so the App never reached an approving review, rather than never speaking. Two earlier
drafts of this record got this wrong in opposite directions: one said a sole maintainer "cannot
satisfy the second at all", enshrining a recoverable failure as a permanent property of the
repository; the other said the reviewer "never produced a verdict across nine rounds", which
contradicts the count four paragraphs above and would have credited the transport with producing
nothing.

The override was therefore `enforce_admins`: disabled, the merge performed, re-enabled — stated on
the operator's account and, for the first two steps, by inference from the merge having succeeded
against a gate that was never green. The absence of an audit log (see "Who approved it") is why
those two are inference rather than record, and this sentence is hedged where that section is
candid; an unhedged version of it is the sentence a later reader would have quoted.

**The present state is not inference.**
`GET /repos/OneHedgehog/claude-code-agent-team/branches/main/protection` answers
`enforce_admins.enabled: true`, read 2026-09-10, with `required_status_checks.contexts` still
`["independent-review"]` and one required approving review. What that establishes outright is that the
protection is *enforced on `main` today*; that it was switched off and put *back* is an event claim,
and inherits the inference above rather than escaping it. The enforced state is the claim which bounds
this override's blast radius, so it is the one worth evidencing rather than asserting.

**The gate's configuration was not changed** — not the required context, not the approving-review
count, not `maxReviewableDiffSize`. It is recorded as an administrator bypass rather than as a
weakened gate, because that is what it was.

Deliberately *not* done, and named so that no future reader mistakes their absence for oversight:

- `maxReviewableDiffSize` was not raised to admit this change. Weakening a limit to pass one's own
  work is what Principle IV forbids and what this pull request already had to escalate once.
- `required_status_checks.contexts` was not emptied.
- The transport was not merged to a branch with the gate removed.

**Feature gate 4 (Principle X, size) was satisfied, not crossed** — the second gate a reader
reconciling this merge would otherwise be left to account for alone. #9 ran to roughly 2,000
non-lockfile lines against a `maxPullRequestSize` of 400, and its description carried the stated
irreducibility justification Principle X permits: an order-of-magnitude figure, the command that
re-derives it at any revision, and a "Why it cannot be smaller" section arguing that two-thirds is
test and specification each traceable to a specific finding. So gate 4 was met through the escape the
principle provides.

**The remaining gates, so that "gate 5" is an accounting rather than an assertion.** Gate 1 (lint,
format, types) and gate 2 are covered by the `check` run below. Gate 3 (the feature's document under
`docs/`, present in the same pull request) was met: #9 modified `docs/independent-review-service.md`
in its own diff. Gate 6 was met: #9's description carried both its spec link and an authoring run
identifier, `6cf65d0c-bf53-4b92-8190-eec4e66d89f3`. **Gate 7 is the one this record cannot settle**
— it is human approval, and "Who approved it" below states plainly that no artifact of it reached
GitHub. So what was *overridden* is gate 5, the never-green review context and the approving review
it would have carried; gate 7 was not overridden so much as left unevidenced, and saying "gate 5
alone" without that distinction would assert the very thing the strongest section of this file
declines to assert.

**Gate 2 was satisfied so far as a pull request can show it.** CI reported `check` as `success` on #9's
head `e758e13` at `2026-09-06T10:11:41Z`, fifty-three minutes before the merge; that command covers
build, lint, format, types and the unit and integration suites. The feature's e2e test runs on the
developer machine rather than in CI (see `.github/workflows/ci.yml`), so that portion of gate 2 left no
artifact on the pull request and is not claimed here. An earlier revision of this record said "gates 2
and 5", adopting a prior reviewer's "2/5" shorthand as though it were an enumeration. It is not: the
`independent-review` context is the reporting surface of gate 5 and cannot make gate 2 fail, and
nothing anywhere in these events is a test failure.

Note that `maxReviewableDiffSize` (FR-037, the service's refusal-to-review threshold) and
`maxPullRequestSize` (Principle X, the merge gate) are distinct settings with distinct defaults. The
first bullet above, and the "not `maxReviewableDiffSize`" clause before it, speak only to the former.

## Who approved it

**What the record can show.** [#9](https://github.com/OneHedgehog/claude-code-agent-team/pull/9) was
merged at `2026-09-06T11:05:06Z` by the `OneHedgehog` account, as squash commit
[`7e22757`](https://github.com/OneHedgehog/claude-code-agent-team/commit/7e22757e62) — one parent, so
the workflow's squash-only rule and Principle I's single-revertible-commit rule were not among the
things departed from. That is the whole of the verifiable trail.

**What it cannot show, stated plainly rather than paraphrased.** There is no approving comment from
the operator on #9. The last comment on the pull request is at `09:54:36Z`, seventy minutes before the
merge, and it is an agent's round-7 reply; no comment follows the merge, and no human review was
submitted. On the operator's account, the approval was given out of band — in the terminal session
driving the agent — and no artifact of it reached GitHub. **This record therefore contains no words
of the approver's own**, and the paraphrase an earlier draft carried, describing what they "had been
told before deciding", has been removed rather than kept: it was an agent's account of a human's
reasoning, offered where the human's own testimony belongs.

Two structural reasons it cannot be reconstructed after the fact, both worth naming because they
will recur:

- **The account is shared.** `OneHedgehog` is both the repository owner and the authoring agent's PAT
  identity. Every comment on #9 was written by the agent under that account, including one that
  addresses `@OneHedgehog` in the second person. The timeline cannot distinguish the human from the
  agent, so no amount of reading it establishes who said what.

  **This is a containment defect and not only an evidentiary one**, and it is the more consequential
  reading. An authoring agent holding the owner's credential holds the permission to disable
  `enforce_admins`, push to `main`, and merge without a green gate. Principle V requires such
  prohibitions to be "enforced by the execution environment, not by the agent's own compliance" — "a
  rule an agent could break by deciding to is not a control; it is a hope" — and the Technology
  section requires that the authoring identity not hold the permissions of the reviewing identity. On
  the facts this record itself supplies, neither holds today. So when this file says below that it
  does not license an agent to perform the override, that reservation is normative and currently
  unenforced: the distinction between "a human did it" and "the account did it" is not merely
  unlogged here, it is unenforceable.
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

- It does not license an agent to perform this override. Principle V reserves it for a human; the
  merge was made by the `OneHedgehog` account, and what that does and does not establish about
  who decided is recorded in "Who approved it" above.
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

**Four items are carried forward, and only one of them is tracked.** They are: waiver 2; the
recurring reviewer faults — subscription session limits and unsatisfied response schemas; the
condition disclosed in the gate-2 paragraph above, that the e2e half of feature gate 2 runs off CI
and so cannot be evidenced from any pull request in this repository; and the shared-credential
containment defect named under "Who approved it", which is the most consequential of the four.

The exception is the schema half of the second. [Spec 004](../004-schema-retry/spec.md) landed as
[#11](https://github.com/OneHedgehog/claude-code-agent-team/pull/11) while this record was in flight
and asks once more when a reply misses the schema, so that fault is tracked and partly remediated
rather than merely open — this record's own review rounds show the retry firing and the round then
concluding. It is not closed: a retry lowers the rate at which a role produces no verdict, and does
not make the response contract constrained the way the `api` transport does. The other three, and
the session-limit half of the second, cite nothing the way the FR-037 cap escalation cites
[#10](https://github.com/OneHedgehog/claude-code-agent-team/issues/10).

A never-rewritten record is an archive, not a work queue: nothing here surfaces them at the moment
they matter. For waiver 2 and the session limits that moment is the next override request; for the
off-CI e2e half it is the next *merge*, which arrives sooner and more often; for the shared
credential it is any moment an agent decides otherwise, which is the point of the principle it
defeats. Opening those issues is not in this diff — it would be unrelated content under Principle X
— so the gap is named rather than quietly carried, and filing them belongs to whoever next reaches
this impasse.