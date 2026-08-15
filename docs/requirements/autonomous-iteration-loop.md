# Requirement: Autonomous Iteration Loop

**Status**: Draft — input for `/speckit-specify`
**Date**: 2026-08-12
**Constitutional impact**: Resolved — constitution v3.4.0

## Context

The system runs unattended. An authoring agent produces a feature, reviewer agents review it
through a GitHub App, and the authoring agent iterates on their comments until they approve.
Merging may be performed by the agent itself rather than by a human, depending on
configuration. The loop cannot begin on an empty repository — there must first be something
to branch from.

---

## R1 — Bootstrap Precondition (outside the loop)

The autonomous loop MUST NOT run against an empty or unproven repository. The baseline is
built before the loop exists, by different means than the loop uses.

**R1.1** The baseline MUST NOT be produced by the autonomous loop. It MAY be authored by an
agent working interactively under human supervision, and a human MUST approve the commit that
establishes it. The constraint is supervision, not authorship — what is prohibited is the loop
creating the gates that will later judge it.

**R1.2** Before the loop starts for the first time, `main` MUST contain a *minimal working
baseline*:

| Element | Requirement |
|---|---|
| Commit history | `main` exists with at least one commit |
| Project skeleton | Both stacks scaffolded — TypeScript workspace, Python package |
| Build | A build command exists and succeeds |
| Lint + format + types | Commands exist and pass clean on the skeleton |
| Unit tests | A test command exists and passes, with at least one real test |
| E2E harness | An e2e runner exists and executes at least one passing trivial test |
| CI | A GitHub Actions workflow runs all of the above and is green on `main` |
| Governance | `.specify/memory/constitution.md` and `CLAUDE.md` present |
| Reviewer App | The GitHub App is installed on the repository with its permissions granted |
| Configuration | The settings in R7 are present and valid |

**R1.3** The baseline exists so that every gate the loop enforces is *already runnable* on day
one. An agent MUST NOT be the first party to discover that a required command is missing.

**R1.4** The loop MUST run a preflight check of R1.2 before starting, and MUST refuse to start
— with a report naming the missing elements — if any element is absent or failing. The
preflight MUST NOT attempt to create the missing elements itself.

**R1.5** After the baseline exists, subsequent features branch from `main` as normal. R1
applies to first start only.

**R1.6** The baseline is the one artifact in the project not produced by the spec → plan →
tasks → implement pipeline, because that pipeline does not yet exist when it is built. It is
therefore also the one artifact whose quality rests entirely on human review.

---

## R2 — The Review Iteration Loop

Once a feature's pull request is open, the authoring agent and the reviewer agents iterate
until the reviewers approve or the loop is stopped.

**R2.1** Each round is: reviewers review the current diff → post comments → conclude with
approve or request-changes.

**R2.2** On request-changes, the authoring agent MUST address every blocking comment, either
by changing the code or by replying with a stated justification, then push and re-request
review.

**R2.3** Reviewers MUST re-review the updated diff. A previous verdict MUST NOT be carried
forward.

**R2.4** Any push to the branch MUST invalidate existing approvals. A stale approval MUST NOT
satisfy the merge gate.

**R2.5** A round MUST make forward progress. A round that produces neither a code change nor a
reply to a blocking comment is a failed round and MUST terminate the loop under R2.7.

**R2.6** The loop terminates successfully when every required reviewer role holds a current
approving review AND all other feature gates pass.

**R2.7** The loop terminates unsuccessfully and escalates to a human, leaving the branch,
checkouts, and full comment history intact, when any of: the configured maximum review rounds
is exhausted; a round makes no forward progress; a gate fails that the agent cannot fix; a
required gate cannot run at all (R6); or any metered budget is exhausted (R6).

**R2.8** The authoring agent MUST NOT resolve, hide, dismiss, or close a blocking comment it
did not fix, and MUST NOT approve its own pull request.

---

## R3 — Merge Authority (configurable)

**R3.1** Merge behavior is governed by the setting `merge.humanApprovalRequired`.

**R3.2** When `true` (default): the agent stops after reviewer approval, requests human
review, and takes no further action on that feature. The human merges.

**R3.3** When `false`: the agent merges the pull request itself once *all* gates pass —
reviewer approvals current, CI green, full suite including e2e green, spec and run linked.

**R3.4** Regardless of the setting, a pull request MUST escalate to a human and MUST NOT be
auto-merged when it touches any path on the `merge.alwaysEscalate` list, or when any blocking
finding was waived rather than fixed.

**R3.5** The merge MUST be a squash merge producing exactly one commit on `main` per feature.

**R3.6** The setting is read at the start of each feature and recorded in the run log, so that
after the fact it is always clear which mode produced a given merge.

---

## R4 — Post-Merge Continuation

**R4.1** After a successful merge the agent MUST delete the feature branch, remove all
isolated checkouts belonging to that feature, and record the outcome in the run log.

**R4.2** The agent then picks up the next available feature without human intervention. This
is what makes the system non-stop.

**R4.3** If another feature merged first and the branch no longer applies cleanly, the agent
MUST rebase onto `main` and re-run all gates. If the rebase materially changes the diff,
approvals are invalidated per R2.4 and review restarts.

**R4.4** A failed or escalated feature MUST NOT block independent features from proceeding.

---

## R5 — Where Each Party Runs

**R5.1** Reviewer agents MUST run in GitHub Actions, triggered by `on: pull_request`, under
the reviewer App identity. The orchestrator opening or updating the pull request is itself the
trigger; no separate notification mechanism is built for this direction.

**R5.2** The reviewer verdict MUST be enforced as a required status check that only the
reviewer App can set. The local agent MUST NOT be able to merge without it. Enforcement is
structural, not conventional — the orchestrator is not trusted to police its own gate.

**R5.3** Deterministic gates (build, lint, format, types, unit tests, e2e) MUST run in the
same CI workflow, as jobs separate from the reviewer job.

**R5.4** The local agent learns of review outcomes by **polling** the GitHub API, not by
receiving webhooks. No public ingress, tunnel, or inbound listener may be introduced. Polling
interval and per-feature timeout are configured.

**R5.5** Rationale for R5.4, recorded so it is not relitigated: the agent sits behind NAT with
no uptime requirement, so a webhook would demand a public endpoint into a laptop to buy
latency that a minutes-long iteration does not need. App installations allow 15,000 API
requests/hour; polling every 15 seconds costs 240/hour per in-flight pull request.

**R5.6** CI jobs MUST execute on a **self-hosted runner** on the developer machine, not on
GitHub-hosted runners. This is what keeps R5.1 affordable on a private repository and keeps
model credentials off GitHub entirely — the runner reads them from the local environment or
keychain, exactly as the orchestrator does.

**R5.7** R5.6 does not weaken R5.2. The trigger, the check run, and branch-protection
enforcement remain server-side at GitHub; only the compute is local. The orchestrator still
cannot merge without a passing check it does not control, which is the property D1 exists to
protect.

**R5.8** The reviewer job MUST NOT be reachable by untrusted contributors. On a private
repository this holds by default. A self-hosted runner MUST NOT be enabled for a public
repository or for fork-originated pull requests, where a hostile diff could execute on the
host or reach the reviewer agent's context.

**R5.9** Reviewer jobs consume the same host as the orchestrator's agents and MUST therefore
count against the global concurrency cap (constitution Principle VIII).

---

## R6 — Resource Budgets and Halt on Exhaustion

**R6.1** Every metered resource the loop consumes MUST have a configured budget and reserve:
model tokens, GitHub API rate limit, disk for worktrees, and — for any job that runs on a
GitHub-hosted runner rather than the self-hosted one (R5.6) — Actions minutes.

**R6.2** Budgets MUST be checked at preflight and again before starting each new feature.
Where GitHub-hosted minutes are in use, remaining minutes are read from the billing API.
Self-hosted runner minutes are not metered by GitHub and do not consume the plan's included
minutes; the binding constraint there is host capacity (R5.9), not quota.

**R6.3** On crossing into the reserve, the loop MUST stop taking on new features while
allowing in-flight features to finish or unwind cleanly. On full exhaustion, the loop MUST
halt and escalate.

**R6.4** Exhaustion MUST NOT be resolved by weakening the system. Specifically, the agent MUST
NOT relocate reviewer agents from CI to the local machine, MUST NOT skip a review that cannot
currently run, MUST NOT merge on the grounds that review is unavailable, and MUST NOT enable
billing or raise a spending limit. The system degrades to stopped, never to unreviewed.

**R6.5** A required gate that cannot run is treated identically to a gate that failed.

**R6.6** Remaining budget for every metered resource MUST be reported in the run log at each
feature boundary, so that approaching exhaustion is visible before it halts the loop.

---

## R7 — Configuration

```yaml
merge:
  humanApprovalRequired: true      # false = agent merges once all gates pass
  alwaysEscalate:                  # never auto-merged, regardless of the above
    - .specify/memory/constitution.md
    - CLAUDE.md
    - .github/**
    - package.json
    - pyproject.toml

review:
  requiredRoles: [security, implementation]
  maxRounds: 3
  runsIn: github-actions           # triggered and enforced by GitHub — see R5.1, R5.2
  runner: self-hosted              # executed on this machine — see R5.6
  pollIntervalSeconds: 15
  perFeatureTimeoutMinutes: 60

execution:
  maxConcurrentAgents: 4           # global: features, tasks, AND reviewer jobs (R5.9)

budget:
  tokens:
    maxPerFeature: <unset>
  apiRateLimit:
    reserve: 1000
  diskGb:
    reserve: 10
  actionsMinutes:                  # only if any job moves to a GitHub-hosted runner
    reserve: 200
```

All settings MUST be validated at preflight (R1.4). An invalid or missing setting MUST prevent
the loop from starting rather than falling back to a default.

---

## R8 — Loop Control, Isolation, and Observability

**R8.1** The loop's control flow MUST be an explicit statechart declared as data — states,
transitions, guards — not conditionals spread through the implementation. Each feature gate
is a guard on a transition.

**R8.2** The state diagram MUST be generated from that declaration, so the picture cannot
drift from the behavior.

**R8.3** Every transition MUST be recorded with its trigger, timestamp, run identifier, and
resulting state.

**R8.4** The loop MUST be able to rebuild its position from GitHub alone — branches, pull
requests, review state, check runs — after a crash or restart. Local state is a cache. A
state that can be entered but not reconstructed is a defect.

**R8.5** Agent execution MUST be confined by the execution environment, not by agent
compliance: filesystem scope limited to its own checkout and toolchain, per-agent CPU and
memory limits, and egress restricted to GitHub, package registries, and the model API.

**R8.6** Isolation mechanism follows Principle VIII — worktree by default, separate clone
where containerization makes a worktree non-isolable. The choice MUST be settled by a spike
measuring bind-mount file I/O cost on macOS before it is adopted wholesale.

**R8.7** A user MUST be able to answer "what is running now" from a status command and "what
happened" from the recorded transitions, without reading source code.

**R8.8** Escalation MUST emit a notification through a configured channel. Silent halting is
prohibited — an unattended system that stops without saying so is indistinguishable from one
still working.

---

## R9 — Feature Documentation Gate

**R9.1** Every feature MUST ship a Markdown document under `docs/` in the same pull request as
its code (Principle IX). The loop MUST enforce this as a merge gate.

**R9.2** When a feature changes behavior, its existing document MUST be updated in the same
pull request. A behavior change with an untouched document is a blocking finding.

**R9.3** Reviewer agents MUST verify that the document exists and that it matches the diff.
Presence alone does not satisfy the gate.

**R9.4** The feature document is distinct from its spec and MUST NOT substitute for it: the
spec records intent at the time it was formed and is never rewritten; the document records
current truth and is rewritten whenever that changes.

---

## Acceptance Criteria

1. Given an empty repository, when the loop is started, then it refuses to start and names
   every missing baseline element.
2. Given a baseline that builds but has no e2e harness, when the loop is started, then it
   refuses to start and names the e2e harness.
3. Given an open PR where the security reviewer requests changes, when the author agent
   pushes a fix, then the reviewer re-reviews the new diff and the round counter increments.
4. Given a PR with an approving review, when a new commit is pushed, then the approval no
   longer satisfies the merge gate.
5. Given `humanApprovalRequired: true` and all gates green, then the agent requests human
   review and does not merge.
6. Given `humanApprovalRequired: false` and all gates green, then the agent squash-merges,
   deletes the branch, removes the checkouts, and starts the next feature.
7. Given `humanApprovalRequired: false` and a diff touching `CLAUDE.md`, then the agent
   escalates instead of merging.
8. Given `maxRounds: 3` and a reviewer that requests changes four times, then the loop stops
   at round three, escalates, and leaves the branch and comments intact.
9. Given a round that produces no diff and no reply, then the loop stops and escalates.
10. Given remaining Actions minutes below the configured reserve, when the loop finishes its
    current feature, then it takes on no new feature and escalates.
11. Given Actions minutes fully exhausted mid-feature, then the loop halts and escalates, and
    does not run reviewers locally, skip review, or merge unreviewed.
12. Given a reviewer job that never starts, then the loop treats it as a failed gate rather
    than as an absent one.
13. Given any in-flight pull request, then no inbound network listener is opened by the local
    agent at any point.
14. Given the full system running, then no model or provider credential is present in GitHub
    Actions secrets, in the repository, or in any workflow file.
15. Given a reviewer job running on the self-hosted runner, then it counts against the global
    concurrency cap alongside feature and task agents.
16. Given branch protection configured, then a pull request whose reviewer check has not
    reported cannot be merged by the orchestrator, regardless of its other state.
17. Given a feature whose pull request contains no document under `docs/`, then the merge gate
    fails and names the missing document.
18. Given a feature that changes behavior with its existing document untouched, then reviewers
    raise a blocking finding.
19. Given the orchestrator process is killed mid-review, when it restarts, then it rebuilds
    the correct state from GitHub alone and resumes without duplicating work.
20. Given any completed run, then its state diagram and the sequence of transitions it took
    are both derivable from recorded data, with no source reading required.
21. Given an agent attempting to write outside its own checkout, then the execution
    environment denies it — the attempt fails structurally, not by agent self-restraint.

---

## Resolved Decisions

**D1 — Reviewers run in GitHub Actions, not locally.** (Was Q2.) The decisive argument is
integrity, not convenience: a locally invoked reviewer is a gate the orchestrator enforces
against itself, and a buggy orchestrator can skip it silently. In CI behind a required status
check, it cannot. See R5.1–R5.3.

**D2 — The local agent polls; no webhooks.** (Was Q1.) See R5.4–R5.5 for the reasoning,
recorded there so it is not relitigated.

**D3 — Quota exhaustion stops the loop.** No fallback to local reviewers, no unreviewed
merge, no enabling billing. See R6 and constitution Principle IV ("degrades to stopped, never
to unreviewed").

**D4 — n8n is not adopted for the core loop.** It does not solve the ingress problem it
appears to solve — it would need the same public endpoint — and its polling alternative
duplicates orchestrator logic that must be unit-testable and reviewable as a diff. Its
plausible future home is the escalation edge (notifying a human across channels), which sits
outside the control flow. Revisit only under a spec showing a need the orchestrator cannot
meet, per the constitution's Technology and Cost Constraints.

**D5 — The repository is private.** (Was Q6.) A public repository would let untrusted parties
open pull requests that automatically trigger an LLM reviewer holding App permissions — a
prompt-injection surface where the hostile input is the artifact under review. The Actions
minutes advantage of a public repository does not outweigh that, and D6 removes the minutes
constraint anyway.

**D6 — CI runs on a self-hosted runner; no model credential is stored in GitHub.** (Was Q5.)
The reviewer job executes on the developer machine and reads model credentials from the local
environment, so the credential never leaves the host. Self-hosted minutes are not billed, so a
private repository's included-minutes cap stops binding. Server-side triggering and branch
protection are unaffected, so D1's integrity property survives intact (R5.7).

Considered and rejected: storing a provider API key as an Actions secret — a long-lived
credential outside the host, for no gain once the runner is local. Considered and deferred:
Amazon Bedrock authenticated by GitHub OIDC to an IAM role, which is the correct design *if*
jobs ever move to GitHub-hosted runners, since OIDC issues short-lived credentials and stores
no secret. It is unnecessary while the runner is local, and would introduce a cloud dependency
the constitution's local-first principle otherwise avoids.

---

## Open Questions

**Q3 — Do App reviews satisfy branch protection?** GitHub's "required approving reviews" is
oriented toward users and teams; an App's approval may not count toward it. D1 already routes
enforcement through a required status check, which sidesteps this, but confirm during
`/speckit-plan` and treat the approving review as the human-readable record.

**Q4 — Who breaks a tie** when two reviewer roles disagree with each other rather than with
the author? Currently escalates to a human under R2.7; confirm that is the desired behavior
rather than a precedence order between roles.

**Q7 — Does the machine sleeping strand in-flight pull requests?** With a self-hosted runner
(D6), CI only runs while the host is awake. A queued reviewer job on a sleeping laptop looks
identical to a slow one until the per-feature timeout fires. Decide whether the orchestrator
should detect this and pause rather than burn timeouts.

**Q8 — Runner isolation.** A self-hosted runner executes workflow code with the privileges of
the account running it, on the same machine as the orchestrator's worktrees. Acceptable for a
private single-author repository, but worth deciding whether the runner gets a dedicated user
account or container.

**Q9 — The orchestrator modifies its own running source.** While the target repository is the
one the orchestrator lives in, every feature it ships changes the code it is currently
executing. Two consequences to settle before implementation: (a) whether the orchestrator's own
source belongs on `merge.alwaysEscalate` alongside the constitution and CI config, since it is
equally a guardrail; and (b) that after merging a change to itself the loop MUST restart rather
than continue, because its in-memory behavior no longer matches `main`. Multi-repository
operation would dissolve this, which is one argument for keeping the target-repository seam
addressable (Governance → Scope).

---

## Constitutional Impact — RESOLVED in v3.4.0

This requirement conflicted with constitution v2.1.0. The conflicts were resolved by
amendment to v3.0.0 (human-approved 2026-08-12), refined in v3.1.0; it is now compliant.

| Conflict | Was (v2.1.0) | Now |
|---|---|---|
| Principle V | Agents MUST NOT "merge their own pull requests into `main`" | Merge permitted when `humanApprovalRequired` is off and all gates pass; escalation list is a non-configurable floor |
| Workflow gate 5 | "A human approves the merge. Agents propose; humans merge." | Conditional on the setting, which defaults to on |
| Principle V | no bootstrap rule | Starting line added. v3.0.0 required a human-authored first commit; v3.1.0 narrows this to prohibiting *loop*-authored bootstrap — supervised agent authoring is permitted, with human approval of the establishing commit |
| Principle VI | titled "Self-Review Before Human Review" | Retitled "Independent Review Gates Every Merge"; adds approval staleness and forward-progress rules |

Recommended default remains `humanApprovalRequired: true` until the reviewer agents have a
track record on this repository.
