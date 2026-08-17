# Feature Specification: Independent Review Service

**Feature Branch**: `001-independent-review-service`

**Created**: 2026-08-14

**Status**: Draft

**Input**: User description: "Build the independent review service for this repository: a GitHub App plus a GitHub Actions workflow that reviews every pull request and gates its merge. […] Triggers on every pull request, runs a security reviewer and an implementation reviewer against the diff, posts line-anchored findings with severity, concludes each role with an explicit review state, sets a status check only the App identity can set, re-reviews from scratch on every push, and refuses to approve a pull request authored by its own identity. Operates against an explicit target repository parameter; runs on a self-hosted runner with local model credentials; model calls sit behind a substitutable interface; reports token spend against budget; fails closed when it cannot run; emits structured JSON logs traceable to a run identifier."

## Spec Note: Principle VI Exception *(governance)*

This feature is the single exception to Principle VI ("Independent Review Gates Every Merge"),
because the reviewers it creates cannot review the pull request that creates them. The first
pull request delivering this service is reviewed by a human. From its second pull request
onward, the service reviews itself and every other change in the repository.

The exception is narrow: it applies only to this feature's first pull request, it authorizes no
other departure from Principle VI, and it expires the moment this service is merged. It is
recorded here rather than as a constitutional amendment because it is a one-time bootstrap
condition, not a change to the rule — consistent with Principle V's starting-line clause, where
the baseline that the loop will be judged against is established under human supervision rather
than produced by the loop.

## Clarifications

### Session 2026-08-14

- Q: When a pull request's diff is too large for the reviewer to examine in a single pass, what
  should the service do? → A: Fail the gate above a configured size cap and require the pull
  request to be split. Diffs are never reviewed in portions; small pull requests are the norm.
- Q: Over what period does the token budget apply, and where does the running total live between
  reviews? → A: One cumulative total for the target repository across all pull requests, with a
  hard stop on exhaustion. The total persists across runs. Model provider (a free or local model
  versus a paid API) is a planning decision behind the FR-029 interface, and the budget binds
  either way.
- Q: If the service runs twice against the same commit, what happens to the findings it already
  posted? → A: Always re-review; never re-report a stored verdict. Each round reconciles the
  service's own comments — resolving those the current revision fixes, leaving those that still
  stand open rather than reposting them, and adding newly observed ones. Rounds stay bounded by
  FR-020, which Principle VI requires; the cap may be set high but not removed.
- Q: Should the service budget its platform API request allowance the way it budgets model tokens?
  → A: Yes, with a reserve — but as a renewable resource, not a purse. Requests cost no money and
  the allowance refills on a documented reset, so reaching the reserve stops further calls, notifies
  a human, and waits for the reset rather than hard-stopping. Only a wait exceeding the configured
  maximum fails the gate and escalates.
- Q: When several pull requests need reviewing at once but the host's concurrency cap is full, what
  happens to the reviews that cannot start? → A: They queue with the gate left unreported, since
  waiting is not failing and branch protection already holds the pull request. Waiting beyond a
  configured maximum notifies a human and escalates. Reviewer jobs are never exempt from the
  host-wide cap.
- Q: Should the implementation reviewer also block a pull request carrying changes no spec asked
  for, or one that is simply too large? → A: Yes — the implementation reviewer enforces Principle X.
  Content not traceable to the feature's spec is a blocking finding, and exceeding the configured
  maximum pull request size is a blocking finding unless the pull request description states why the
  change is irreducible. This size setting is distinct from the FR-037 reviewability cap: the
  Principle X cap is a reviewed judgment with a stated-justification escape, while the FR-037 cap
  fails the gate before any review is attempted.
- Q: When an author replies to a blocking finding with a justification instead of changing the code,
  what does the reviewer do on the next round? → A: The reviewer judges the reply. If it rejects the
  justification, the finding stands and the gate stays failing. If it accepts, the finding stops
  blocking but is not treated as fixed: the reviewer records it as a waiver request, still does not
  approve on its own say-so, and escalates the waiver to a human. Only the reviewer may decide that
  one of its own findings no longer blocks, and only a human may grant the waiver.
- Q: Should the reviewer detect a round where the author neither changed the code nor replied to a
  blocking finding, and stop immediately rather than waiting out the round cap? → A: Yes. Progress is
  measured between consecutive concluded rounds rather than over elapsed time — no timer is involved,
  since the service only runs on a pull request event. A round makes no progress when the head
  revision equals the one the previous concluded round examined and no blocking finding from that
  round received a new reply since it concluded. The first round on a pull request is never a failed
  round, and a round that did not conclude is not a baseline. Escalation transport remains an
  operating setting, but every escalation is additionally stated on the pull request itself, so the
  reason is visible where the work is.
- Q: Is the cumulative token budget reviewer-only, or one pot shared with every other agent working
  on the repository? → A: One repository-wide ledger shared by every agent, with a reviewer reserve
  — a portion of the budget only review work may draw on, so that another agent's spending can never
  leave a pull request ungated. This feature defines and owns the ledger; later features record their
  spend against it rather than keeping their own.
- Q: Is the model's depth-versus-cost setting part of the required configuration? → A: Optional, with a
  service-supplied default. It is a real lever — a repository finding reviews too shallow or too
  expensive should be able to turn it without a code change — but not one every repository must reason
  about before its first review. This establishes the general shape: the settings contract has a
  required set whose absence stops the run, and an optional set whose absence is filled by a documented
  default and whose effective value is reported with the run.
- Q: Where should the service record which files it excluded from review? → A: Nowhere elaborate, and
  it should not infer them. Generated files are kept out of the repository by `.gitignore`, so they
  never reach a diff and need no detector. What remains is committed by design — lockfiles, snapshots,
  and binaries such as images or fonts — so exclusion is a declared list in the operating settings plus
  whatever git itself reports as binary, never a heuristic. Because the set is declared rather than
  guessed, it cannot silently over-match, and recording it in the structured records is enough; the
  check-run output carries the count.
- Q: What verdict should each role record for an empty or whitespace-only diff? → A: None — such a
  pull request should not exist, so the service refuses to review it: fail the gate stating there is
  nothing to review, escalate, spend nothing. A verdict policy for a degenerate pull request would make
  it a normal case; refusing makes it visibly abnormal. Preventing its creation belongs to the
  orchestrator and is out of scope here, so until that exists the gate is what makes it impossible to
  merge. This supersedes the earlier reading that such a pull request still receives explicit verdicts.
- Q: Should the service verify its own prerequisites — permissions held, gate required by branch
  protection — before reviewing? → A: Yes, both, at startup, failing the gate and escalating when
  either is missing. A misconfigured branch protection is the one failure that leaves the service
  looking healthy while doing nothing: it reviews, posts findings, reports a failing gate, and the pull
  request merges anyway because nothing required the check. Reading branch protection needs a wider
  permission than reviewing alone, which is accepted as the price of the check being possible at all.
- Q: Is the operating-settings file the review service's alone, or shared with the agents built later?
  → A: Shared, and namespaced. Every agent's settings live in one version-controlled file under its own
  top-level key; the service validates its own subtree strictly — an unknown key there is a typo and
  stops the run — and ignores sibling keys belonging to other agents. Validating the whole file
  strictly would reject the settings a later agent adds, failing the gate on a configuration error and
  leaving nothing able to merge.
- Q: How should the service handle two reviewer roles reaching opposite conclusions on the same
  point? → A: By role precedence. The security reviewer outranks every other role: its blocking
  finding stands, another role's contrary conclusion never clears it, and the contradiction is
  recorded rather than escalated because it is already decided. A contradiction between roles of
  equal precedence — neither of them the security reviewer — stops the review, fails the gate, and
  escalates as a disagreement rather than being pushed back onto the author. An author who cannot
  satisfy a standing finding answers it with a justification, which routes to a human through the
  waiver path.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every pull request receives an explicit, gating verdict (Priority: P1)

A change lands on a branch and a pull request is opened against the target repository's default
branch. Without anyone asking, two reviewer roles — security and implementation — read the diff
and each concludes with a stated verdict: approve, or request changes. A single merge gate on the
pull request reflects the combined outcome, and the pull request cannot merge until that gate is
green. Nobody has to remember to request a review, and no pull request slips past because a
reviewer stayed quiet.

**Why this priority**: This is the merge gate itself and the reason the feature exists. Every
other component in the system depends on this gate existing before it can be built under the
project's own rules. Without it there is no product.

**Independent Test**: Open a pull request in the target repository and observe, without further
input: two role verdicts recorded on the pull request, and a merge gate whose state matches those
verdicts. Fully testable end-to-end with a scripted model double.

**Acceptance Scenarios**:

1. **Given** a pull request is opened against the target repository, **When** the review service
   runs, **Then** the security role and the implementation role each record an explicit verdict of
   approve or request-changes on the pull request.
2. **Given** both roles record an approving verdict, **When** the run completes, **Then** the merge
   gate reports success and the pull request becomes mergeable with respect to this gate.
3. **Given** at least one role records a request-changes verdict, **When** the run completes,
   **Then** the merge gate reports failure and the pull request is not mergeable.
4. **Given** a role completes its pass without producing a verdict, **When** the run completes,
   **Then** the missing verdict is treated as a failure and never as an approval.
5. **Given** the merge gate is required by branch protection, **When** the gate has not reported,
   **Then** no actor — human or automated — can merge the pull request.
6. **Given** the review service holds the reviewing identity, **When** any authoring or
   orchestrating identity attempts to report the merge gate, **Then** it is refused for lack of
   permission.
7. **Given** the security reviewer blocks a change that the implementation reviewer treats as
   acceptable, **When** the run completes, **Then** the security finding stands, the gate fails, the
   contradiction is recorded, and no disagreement escalation is raised.
8. **Given** two roles of equal precedence produce findings that no single diff can satisfy at the
   same location, **When** the run completes, **Then** the service fails the gate stating the
   disagreement and escalates to a human rather than requesting changes from the author.

---

### User Story 2 - Findings arrive on the offending line, with severity and blocking status (Priority: P1)

A pull request introduces a hardcoded credential. The security reviewer posts a comment on the
exact line that introduces it, labelled with a severity and marked as blocking, and concludes with
a request-changes verdict. An author reading the pull request can tell, without hunting, what is
wrong, where, how serious it is, and whether it must be fixed before merge.

**Why this priority**: A verdict without located, severity-graded findings is unactionable. The
author agent's remediation loop (a later feature) can only address findings it can locate, and a
human reading the pull request needs the same. Blocking and advisory findings must be
distinguishable or every finding becomes a blocker in practice.

**Independent Test**: Submit a pull request whose diff contains a hardcoded credential and assert
that a blocking, severity-carrying comment is anchored to that line and that the security verdict
is request-changes. Deterministic under a scripted model double.

**Acceptance Scenarios**:

1. **Given** a diff introducing a hardcoded credential, **When** the security reviewer runs,
   **Then** a finding is posted as a comment anchored to the line in the diff that introduces it.
2. **Given** a posted finding, **When** it is read on the pull request, **Then** it states a
   severity and states plainly whether it blocks merge.
3. **Given** a role produces at least one blocking finding, **When** it concludes, **Then** its
   verdict is request-changes.
4. **Given** a role produces only non-blocking findings, **When** it concludes, **Then** its verdict
   is approve and the findings remain visible as advisory comments.
5. **Given** a finding refers to a location not present in the diff, **When** the finding is posted,
   **Then** it is recorded at pull request level with its location stated in the body rather than
   silently dropped.

---

### User Story 3 - The implementation reviewer enforces the project's own rules on the diff (Priority: P2)

A pull request changes behavior but leaves its feature document under `docs/` untouched. The
implementation reviewer raises a blocking finding: the change is not documented. The same reviewer
raises blocking findings when new behavior arrives without tests, when a feature arrives with no
end-to-end test, when the diff carries changes no specification asked for, and when the pull request
is larger than the configured maximum without a stated reason.

**Why this priority**: Constitutional compliance (Principles II, IX, and X) is what keeps the rest
of the system honest as it is built. It depends on User Story 1 existing but adds the checks that
make the gate meaningful rather than ceremonial.

**Independent Test**: Submit a pull request that changes behavior with no `docs/` update, one that
adds behavior with no test, one carrying an unrelated refactor, and one exceeding the size limit
with and without a justification, and assert a blocking finding in each case that warrants one.

**Acceptance Scenarios**:

1. **Given** a diff that changes behavior and no added or modified Markdown document under `docs/`
   in the same pull request, **When** the implementation reviewer runs, **Then** it raises a
   blocking finding and concludes request-changes.
2. **Given** a diff that changes behavior and a `docs/` document that still describes the previous
   behavior, **When** the implementation reviewer runs, **Then** it raises a blocking finding that
   the document does not match the change.
3. **Given** a diff introducing new public behavior with no accompanying test, **When** the
   implementation reviewer runs, **Then** it raises a blocking finding.
4. **Given** a diff delivering a feature with no end-to-end test, **When** the implementation
   reviewer runs, **Then** it raises a blocking finding.
5. **Given** a diff that changes only documentation or comments, **When** the implementation
   reviewer runs, **Then** the missing-test and missing-document checks do not fire.
6. **Given** a diff containing a change the pull request's specification did not ask for — a
   refactor of untouched code, an opportunistic rename, formatting of untouched lines, or dead
   code — **When** the implementation reviewer runs, **Then** it raises a blocking finding naming
   the unrelated content and concludes request-changes.
7. **Given** a pull request whose changed-line count exceeds the configured maximum pull request
   size and whose description offers no justification, **When** the implementation reviewer runs,
   **Then** it raises a blocking finding on size.
8. **Given** the same oversized pull request with a description stating why the change is
   irreducible, **When** the implementation reviewer runs, **Then** the size finding does not
   fire and every other check still applies.

---

### User Story 4 - A push invalidates every prior verdict (Priority: P2)

A pull request is approved by both roles. The author pushes another commit. The pull request
immediately stops being mergeable, and the roles review the new diff from scratch — no verdict, no
finding, and no approval from the previous revision carries forward.

**Why this priority**: Without staleness invalidation, one approval could be earned and then
anything pushed behind it. This is the hole that unattended merging (a later feature) would drive
straight through, so it must exist before that feature does.

**Independent Test**: Approve a pull request, push a commit, and assert that the gate returns to a
non-passing state and that a fresh review is performed against the new revision.

**Acceptance Scenarios**:

1. **Given** a pull request with approving verdicts from both roles, **When** a new commit is
   pushed, **Then** the merge gate no longer reports success for the pull request.
2. **Given** a new commit is pushed, **When** the review service runs again, **Then** it reviews the
   full current diff rather than only the newly pushed commit.
3. **Given** a prior verdict exists for an earlier revision, **When** the new run concludes, **Then**
   the prior verdict is not reused, and every verdict recorded is bound to the revision it examined.
4. **Given** a review is in progress, **When** a new commit is pushed before it concludes, **Then**
   the outcome for the superseded revision does not satisfy the gate for the new revision.
5. **Given** a prior round's finding that the new revision fixes, **When** the re-review concludes,
   **Then** that finding is resolved, findings that still stand remain open without being reposted,
   and newly observed findings are added.
6. **Given** a blocking finding the author answered with a justification rather than a code change,
   **When** the re-review concludes and the reviewer rejects the justification, **Then** the finding
   remains open and blocking and the merge gate keeps failing.
7. **Given** the same finding and a justification the reviewer accepts, **When** the re-review
   concludes, **Then** the finding is recorded as a waiver request rather than resolved, it is
   escalated to a human, and the merge gate does not pass while the waiver is outstanding.
8. **Given** a blocking finding with no reply and no code change addressing it, **When** the
   re-review concludes, **Then** the finding still blocks.

---

### User Story 5 - The gate fails closed when the reviewer cannot review (Priority: P2)

The review service cannot start, crashes partway, loses access to its model, or would exceed its
configured token budget. In every case the pull request becomes un-mergeable and a human is told
why. It never becomes mergeable because the reviewer was unavailable.

**Why this priority**: Principle IV forbids degrading to unreviewed. An absent gate that reads as
"no objection" is worse than no gate at all, because it looks like a review happened.

**Independent Test**: Force each failure mode — startup failure, mid-run error, budget exhaustion —
and assert a failing gate with a stated reason in every case, and that no approving verdict is
recorded.

**Acceptance Scenarios**:

1. **Given** the review service fails before either role runs, **When** the run ends, **Then** the
   merge gate reports failure with a diagnostic reason, not success, not neutral, and not skipped.
2. **Given** the review service fails after one role approved, **When** the run ends, **Then** the
   merge gate reports failure and the partial approval does not satisfy it.
3. **Given** the remaining token budget is below what a review requires, **When** the run starts,
   **Then** it stops before spending, reports a failing gate stating budget exhaustion, and
   escalates to a human.
4. **Given** spend crosses the configured budget mid-review, **When** the threshold is crossed,
   **Then** the run stops rather than overspending and reports a failing gate.
5. **Given** the review service never starts at all, **When** merge is attempted under branch
   protection requiring the gate, **Then** the merge is refused because the required gate has not
   reported.
6. **Given** the service stops and needs a human, **When** it halts, **Then** it emits a
   notification through the configured channel rather than halting silently, and states the reason
   on the pull request as well.
7. **Given** a pull request whose diff exceeds the configured maximum reviewable size, **When** the
   review service runs, **Then** it spends nothing on the review, records no verdict, and fails the
   gate with a reason stating that the pull request must be split into smaller ones.
8. **Given** a round whose head revision matches the previous concluded round's and whose blocking
   findings received no replies since it concluded, **When** the service runs, **Then** it stops
   without re-reviewing, fails the gate stating that the round made no progress, and escalates —
   without waiting for the configured maximum rounds to be reached.
9. **Given** the previous round did not conclude, because it crashed, stopped on budget, or timed
   out queueing, **When** the service runs again against the same revision, **Then** it is not
   treated as a failed round and the review proceeds.
10. **Given** other agents have drawn the shared token budget down to the reviewer reserve, **When**
    a pull request needs reviewing, **Then** the review still runs against the reserve and the pull
    request is gated as normal.
11. **Given** the merge gate is not listed as a required check on the pull request's target branch,
    **When** the service starts, **Then** it spends nothing, fails the gate naming the missing branch
    protection, and escalates — rather than reviewing normally while the gate goes unenforced.
12. **Given** the reviewing identity lacks a permission its work requires, **When** the service starts,
    **Then** it spends nothing, fails the gate naming the missing permission, and escalates.

---

### User Story 6 - The reviewer never approves its own work (Priority: P3)

A pull request is authored by the same identity the review service reviews under. The service
refuses to approve it, says so on the pull request, and escalates to a human instead.

**Why this priority**: A rare case today — the orchestrator authors under a separate identity — but
it is the one case where independence silently collapses, and the check is cheap.

**Independent Test**: Open a pull request authored by the reviewing identity and assert that no
approving verdict is recorded and that the gate does not pass on the service's own say-so.

**Acceptance Scenarios**:

1. **Given** a pull request whose author is the reviewing identity, **When** the review service
   runs, **Then** it records no approving verdict for either role.
2. **Given** such a pull request, **When** the run concludes, **Then** the merge gate does not report
   success, the reason is stated on the pull request, and the case is escalated to a human.
3. **Given** a pull request authored by any other identity, **When** the review service runs,
   **Then** the self-review refusal does not fire.

---

### User Story 7 - Reviews are addressable, configured, and accountable (Priority: P3)

An operator points the service at a named target repository, and everything it reads — the
constitution, the operating settings, the paths it inspects — is resolved through that name rather
than through whatever directory the process happens to be sitting in. Every review carries a run
identifier, emits structured records, and reports what it spent.

**Why this priority**: Required by the constitution's Scope clause and Principle VII, and it is far
cheaper to build in now than to retrofit once a second target exists. It does not change what a
reviewer decides, only what it can be pointed at and what it leaves behind.

**Independent Test**: Run the service against a fixture target repository from an unrelated working
directory and assert it read that target's constitution and settings, and that its records carry a
run identifier and a spend report.

**Acceptance Scenarios**:

1. **Given** a target repository supplied as a parameter, **When** the service runs from an
   unrelated working directory, **Then** it resolves the constitution, operating settings, and all
   inspected paths through that parameter.
2. **Given** a target repository is not supplied, **When** the service starts, **Then** it stops with
   an error rather than defaulting to the current working directory or to any built-in repository.
3. **Given** a required operating setting is missing or invalid, **When** the service starts,
   **Then** it stops and reports a failing gate rather than falling back to a default.
4. **Given** any review, **When** it runs, **Then** every record it emits is structured and carries
   the run identifier, and no record is bare prose on standard output.
5. **Given** a completed or halted review, **When** it concludes, **Then** it reports the tokens it
   consumed and the remaining budget.
6. **Given** a review has concluded, **When** its records are read afterward, **Then** the roles that
   ran, the findings posted, the verdicts reached, and the gate state are all reconstructible from
   the records and from the pull request without re-running the review.

---

### Edge Cases

- **Empty or whitespace-only diff** — a pull request with no reviewable change is refused rather than
  reviewed: the gate fails stating there is nothing to review, the case escalates, and nothing is spent.
  It is never silently skipped, and it never receives a verdict — a verdict would make a degenerate
  pull request look like an ordinary one.
- **Diff exceeding the size cap** — a pull request whose diff exceeds the configured maximum
  reviewable size is not reviewed in portions and is never approved on a partial reading; the gate
  fails with a reason telling the author to split the pull request into smaller ones. Small pull
  requests are a norm this service enforces, not a constraint it works around.
- **Binary and committed non-source files** — excluded from line-anchored findings and from the
  changed-line count the maximum pull request size is measured against. The excluded set is what git
  reports as binary plus the paths declared in the operating settings — lockfiles, snapshots — and is
  never inferred by a generated-file heuristic: build output is kept out of the repository by
  `.gitignore` and so never reaches a diff. Their presence alone does not block. The excluded paths are
  recorded in the structured records and their count in the check-run output.
- **Pull request over the size limit with a stated justification** — the size finding does not fire,
  but no other check is relaxed; an irreducible pull request is still reviewed in full and may still
  fail on any other blocking finding.
- **Finding on an unchanged line** — recorded at pull request level with its location stated, since
  comments cannot anchor outside the diff.
- **Draft pull request** — reviewed like any other; the gate reports, and merge remains blocked by
  the draft state independently.
- **Pull request closed or merged mid-review** — the run terminates and records the outcome without
  attempting to post to a closed pull request.
- **Two runs racing on the same pull request** — only the run examining the current head revision
  may report the gate; a superseded run's outcome is discarded.
- **Re-run against an already-reviewed revision** — reviewed again in full rather than answered from
  a stored verdict; its findings are reconciled rather than duplicated, and the round counts against
  the configured maximum like any other.
- **Self-hosted runner offline** — the gate never reports, and branch protection's required-check
  requirement keeps the pull request un-mergeable.
- **Host concurrency cap full** — the review queues with the gate unreported and branch protection
  holding the pull request; it starts when a slot frees, and escalates only if the wait exceeds the
  configured maximum. A queued review is never reported as a failed one.
- **Model credentials absent from the local environment** — the run stops before spending and fails
  the gate rather than proceeding without a reviewer.
- **Platform API allowance reached mid-review** — the run stops issuing calls, notifies a human, and
  waits for the reset before resuming; the gate stays unreported while it waits, and fails only if
  the wait would exceed the configured maximum. Findings already posted are not re-posted on resume.
- **Roles contradicting each other** — the security reviewer wins outright and the contradiction is
  recorded, not escalated. Between roles of equal precedence it stops the review and escalates,
  since an author asked to satisfy two incompatible findings can only spin.
- **Round that changes nothing and answers nothing** — the service stops before re-reviewing, fails
  the gate stating the round made no progress, and escalates, rather than spending another round's
  tokens to reach the same verdict. Measured between consecutive concluded rounds, never on a timer.
- **Blocking finding answered with a justification rather than a fix** — the reviewer judges the
  reply: rejected, the finding keeps blocking; accepted, it becomes a waiver request that escalates
  to a human and holds the gate rather than passing it. The reviewer never grants the waiver itself.
- **Configured maximum review rounds exceeded on one pull request** — the service stops re-reviewing,
  fails the gate, and escalates to a human rather than looping indefinitely.
- **Reviewing identity lacks permission to post comments or report the gate** — detected at startup by
  the FR-051 check rather than discovered mid-review: failing gate, escalation, no approval, nothing
  spent.
- **Merge gate not required by branch protection** — the one failure that looks like success. The
  service verifies this before reviewing and fails the gate naming it, rather than running a review
  whose outcome nothing enforces.

## Requirements *(mandatory)*

### Functional Requirements

#### Triggering and identity

- **FR-001**: The service MUST run automatically for every pull request in the target repository,
  on opening and on every subsequent push of new commits, with no manual invocation.
- **FR-002**: The service MUST review under a reviewing identity that is distinct from every
  authoring identity used in the repository.
- **FR-003**: The reviewing identity MUST hold only the permissions its review work requires, and
  the authoring identity MUST NOT hold the reviewing identity's permissions.
- **FR-004**: The service MUST refuse to record an approving verdict on a pull request authored by
  its own reviewing identity, MUST state that refusal on the pull request, and MUST escalate it to
  a human.

#### Reviewer roles and verdicts

- **FR-005**: The service MUST run at least two reviewer roles against the diff: a security reviewer
  and an implementation reviewer.
- **FR-006**: Each role MUST conclude with one explicit verdict — approve or request changes —
  recorded on the pull request.
- **FR-007**: The absence of a verdict from a role MUST be treated as a failure of that role and
  MUST NOT be treated as approval, in any circumstance.
- **FR-008**: A role MUST conclude request-changes when it produced one or more blocking findings,
  and MUST NOT conclude approve while any of its own blocking findings stand against the reviewed
  revision. A finding the service accepted as justified under FR-044 no longer stands as blocking
  for this purpose, but the gate remains held by FR-045 until a human grants the waiver.
- **FR-009**: Each verdict MUST be bound to the exact revision it examined.
- **FR-048**: Reviewer roles MUST carry an ordered precedence, and the security reviewer MUST hold
  the highest. A blocking finding from a higher-precedence role stands regardless of any
  lower-precedence role's contrary conclusion: the contrary conclusion MUST NOT clear, downgrade, or
  withdraw it, and the service MUST NOT escalate the contradiction as a disagreement, because
  precedence already decides it. The contradiction MUST be recorded so it is visible afterward.
- **FR-049**: A contradiction between two roles of equal precedence — where one role's finding
  requires a change at a location that another role's finding forbids, so that no diff can satisfy
  both — MUST stop the review, fail the gate stating the disagreement, and escalate to a human. It
  MUST NOT be pushed back onto the author as an ordinary request-changes.

#### Findings

- **FR-010**: Findings MUST be posted as comments on the pull request, anchored to the specific
  lines of the diff they concern whenever the location lies within the diff.
- **FR-011**: Every finding MUST carry a severity drawn from a fixed, declared scale.
- **FR-012**: Every finding MUST state explicitly whether it blocks merge, so that blocking and
  advisory findings are distinguishable without interpreting the severity.
- **FR-013**: Which severities block MUST be an operating setting of the target repository, not a
  value fixed in the service.
- **FR-014**: A finding whose location is not addressable within the diff MUST be recorded at pull
  request level with its location stated in the body, and MUST NOT be discarded.
- **FR-015**: The service MUST NOT hide, dismiss, or delete findings, its own or anyone else's, and
  MUST NOT resolve a finding authored by anyone else. Resolving one of its own findings is permitted
  only as the FR-039 reconciliation — when the revision under review no longer exhibits it — and
  MUST NOT be done to a finding that still stands.

#### Constitutional compliance (implementation reviewer)

- **FR-016**: The implementation reviewer MUST raise a blocking finding when the diff introduces new
  behavior without accompanying tests, when the feature has no end-to-end test, or when a
  behavior-changing diff carries no matching feature document under the target repository's `docs/`
  directory in the same pull request — including when a document exists but still describes the
  superseded behavior.
- **FR-042**: The implementation reviewer MUST raise a blocking finding for content in the diff that
  the pull request's feature specification did not ask for — refactors of untouched code,
  opportunistic renames, formatting of untouched lines, dependency changes the feature does not
  require, abstraction or configuration added for anticipated future work, and commented-out or dead
  code.
- **FR-043**: The implementation reviewer MUST raise a blocking finding when the pull request's
  changed-line count, measured with the FR-053 excluded set removed, exceeds the configured
  maximum pull request size and the pull request description does not state why the change is
  irreducible. The exclusions are the declared ones FR-053 defines — never a generated-file
  heuristic, which could silently shrink a pull request under the cap. A stated justification MUST clear this finding and only this finding. This setting is
  distinct from the maximum reviewable diff size in FR-037, and neither MUST be substituted for the
  other: FR-037 fails the gate before any review is attempted, while this check is a reviewed
  finding like any other.

#### Re-review and staleness

- **FR-017**: Every run MUST review from scratch — on every push of new commits, and equally on any
  re-run against a revision already reviewed. No prior verdict, approval, or finding may carry
  forward, and a stored verdict MUST NOT be re-reported in place of an actual review.
- **FR-039**: On any re-review, the service MUST reconcile its own prior findings against the
  revision under review: a finding the revision no longer exhibits MUST be resolved, a finding that
  still stands MUST be left open rather than reposted as a duplicate, and a newly observed finding
  MUST be posted. Reconciliation applies only to the service's own findings. A finding accepted as
  justified under FR-044 MUST NOT be resolved by reconciliation — the revision still exhibits it —
  and MUST remain open and visible as a waiver request.
- **FR-044**: On re-review, the service MUST read replies to its own blocking findings and MUST
  judge each stated justification. A justification it rejects leaves the finding standing and the
  gate failing. A justification it accepts MUST NOT be recorded as a fix: the finding is marked as
  no longer blocking, recorded as a waiver request carrying the finding, the justification, and the
  reviewer's reason for accepting it, and escalated to a human through the configured channel. Only
  the service may judge a reply to its own finding; a reply MUST NOT clear a finding on the author's
  say-so, and an unanswered blocking finding MUST continue to block.
- **FR-045**: The service MUST NOT report a passing merge gate while any waiver request on the
  reviewed revision is outstanding, and MUST NOT grant a waiver itself. The gate may pass only once
  every blocking finding is either fixed in the diff or covered by a human-approved waiver recorded
  against that revision.
- **FR-018**: A push MUST invalidate every existing approving verdict on the pull request, and a
  stale approval MUST NOT satisfy the merge gate.
- **FR-019**: Only the run examining the pull request's current head revision may report the merge
  gate; a run superseded by a newer push MUST discard its outcome.
- **FR-020**: The service MUST count its review rounds per pull request against the configured
  maximum, and on exceeding it MUST stop, fail the gate, and escalate to a human rather than
  continuing to re-review.
- **FR-046**: The service MUST detect a round that makes no progress and MUST stop on it
  immediately — failing the gate with that reason and escalating to a human — rather than
  continuing until the FR-020 round cap is reached. A round makes no progress when the head revision
  it would examine is identical to the one examined by the previous concluded round for that pull
  request, and no blocking finding open at the end of that round has received a reply since it
  concluded. Progress MUST be determined by comparing consecutive concluded rounds, never by elapsed
  time. The first round on a pull request MUST NOT be treated as a failed round, and a round that
  did not conclude MUST NOT serve as the comparison baseline, so that a retry after a crash, a
  budget stop, or a queue timeout is not mistaken for a stalled author.

#### The merge gate

- **FR-021**: The service MUST report a merge gate on the pull request whose state is derived from
  the role verdicts: passing only when every required role approved the current revision.
- **FR-022**: The merge gate MUST be reportable only by the reviewing identity; no authoring or
  orchestrating identity may create, update, or satisfy it.
- **FR-023**: The service MUST fail the gate — never report success, neutral, or skipped — whenever
  it cannot complete a full review for any reason, including startup failure, mid-run error, missing
  credentials, missing permissions, or budget exhaustion.
- **FR-024**: A failing gate MUST state a reason a human can act on.
- **FR-025**: The gate MUST be configured as a required check under branch protection, so that a
  pull request whose gate has not reported cannot be merged by any actor.
- **FR-054**: The operating settings MUST distinguish a required set from an optional set. A missing or
  invalid **required** setting stops the run (FR-028). A missing **optional** setting MUST be filled
  from a documented default rather than stopping the run, and the effective value MUST be reported with
  the run so that no behavior depends on a value nobody can see. Review depth — how hard the model works
  before answering — is optional; every budget, reserve, threshold, and cap is required.
- **FR-053**: The service MUST determine excluded paths from what the version control system reports as
  binary plus an explicitly declared list of path patterns in the operating settings, and MUST NOT infer
  them from a generated-file heuristic. Excluded paths MUST be recorded in the service's records and
  their count reported with the run.
- **FR-052**: The service MUST refuse a pull request whose diff is empty or contains only whitespace:
  fail the gate stating there is nothing to review, escalate, record no verdict, and spend no model
  tokens. Preventing such a pull request from being opened is the orchestrator's concern and out of
  scope here.
- **FR-051**: Before reviewing, the service MUST verify its own prerequisites: that the reviewing
  identity holds every permission its work requires (FR-003), and that the merge gate is listed as a
  required check on the branch the pull request targets (FR-025). A missing prerequisite MUST fail the
  gate with a reason naming it and MUST escalate, before any model tokens are spent. The service MUST
  NOT attempt to configure either — it verifies and reports, because an identity that can change branch
  protection can remove the gate.
- **FR-037**: The service MUST fail the gate for a pull request whose diff exceeds the configured
  maximum reviewable size, stating that the pull request must be split, and MUST NOT review such a
  diff in portions, sample it, or approve any part of it.

#### Target-repository addressing and settings

- **FR-026**: The service MUST accept the target repository as an explicit parameter, and MUST
  resolve the constitution, the operating settings, and every inspected path through that parameter
  rather than from the process working directory.
- **FR-027**: The service MUST stop with an error when no target repository is supplied, and MUST
  NOT default to the current working directory or to any built-in repository identity.
- **FR-028**: The service MUST read its operating settings — required reviewer roles, blocking
  severity threshold, maximum review rounds, maximum reviewable diff size, maximum pull request
  size, excluded path patterns, token budget and reviewer reserve, escalation notification channel,
  platform API request budget and reserve, maximum wait for a rate-limit reset, maximum wait for a
  review slot — from
  version-controlled configuration in the target repository, and MUST stop rather than substitute a
  default when a required setting is missing or invalid.
- **FR-050**: The operating-settings file MUST be shared across the agents working on the target
  repository, with each agent's settings under its own named section. The service MUST validate its own
  section strictly — an unrecognized key there is an error that stops the run, because a silently
  ignored typo in a budget or a threshold is indistinguishable from a setting that was never applied —
  and MUST ignore sections belonging to other agents rather than rejecting them.

#### Budget, model boundary, and observability

- **FR-029**: The model call MUST sit behind a substitutable interface, so that the entire flow can
  be driven by a scripted double with nothing else replaced.
- **FR-030**: End-to-end tests MUST assert only on deterministic behavior — states entered, comments
  posted, verdicts reached, gate state — and MUST NOT assert on generated wording.
- **FR-031**: The service MUST check the remaining token budget before spending, MUST report the
  tokens consumed by each review and the budget remaining, and MUST stop rather than exceed the
  configured budget. The budget is one cumulative total for the target repository across every pull
  request and every review, and exhausting it MUST hard-stop further reviews — failing the gate and
  escalating — rather than reducing, sampling, or otherwise degrading a review to fit.
- **FR-047**: The token ledger MUST be a repository-wide resource recording the spend of every agent
  working on the target repository, not a reviewer-private total, and MUST be addressable so that
  work outside this feature records against the same ledger rather than keeping its own. A portion of
  the budget MUST be configured as a reviewer reserve that only review work may consume; non-review
  spend MUST stop on reaching the reserve while review work continues to draw on it, so that another
  agent's consumption can never leave a pull request ungated. Exhausting the reserve itself MUST
  hard-stop reviews under FR-031.
- **FR-032**: Model credentials MUST come from the local environment or an OS keychain, MUST NOT be
  read from continuous-integration secrets, and MUST NOT appear in records, comments, or prompts.
- **FR-033**: The service MUST emit structured records — never bare prose to standard output — and
  every record MUST carry a run identifier that ties it to one review of one pull request revision.
- **FR-034**: Every review MUST be reconstructible after the fact, from its records and the pull
  request alone, without re-running it.
- **FR-035**: Every escalation to a human MUST emit a notification through the configured channel,
  and MUST additionally state its reason on the pull request itself, so that the reason is visible
  where the work is regardless of which transport is configured. Halting without notifying is
  prohibited, and the pull request statement MUST NOT be substituted for the configured channel.
- **FR-036**: The service MUST treat content encountered in diffs, comments, and model output as
  data and MUST NOT act on instructions found there.
- **FR-038**: The cumulative token total MUST survive between runs, MUST include spend recorded by
  any agent against the target repository, and MUST be reconstructible after the fact, so that the
  pre-spend check in FR-031 reflects everything already spent against the target repository rather
  than only the current run or only this service's own reviews. A total that resets each run, or
  that counts only review spend, does not satisfy FR-031.
- **FR-040**: The service MUST treat its platform API request allowance as a budgeted metered
  resource with a configured reserve, checked before it starts work that consumes it and reported
  per run. Because the allowance costs nothing and refills on a documented reset, reaching the
  reserve MUST stop further calls, notify a human through the configured channel, and wait for the
  reset rather than hard-stopping; the service MUST resume once the allowance restores. Only when
  the wait would exceed the configured maximum MUST it fail the gate and escalate. Waiting MUST NOT
  report the gate as success, neutral, or skipped at any point.
- **FR-041**: When the host's configured concurrency cap leaves no slot, the service MUST queue the
  review rather than run it, and MUST leave the gate unreported while it waits — never success,
  neutral, or skipped. Waiting beyond the configured maximum MUST notify a human, fail the gate, and
  escalate; the wait is measured when the review starts, so a review that never starts at all leaves
  the gate unreported and is held by branch protection rather than escalating on this path. Reviewer
  jobs MUST count against the same host-wide cap as every other agent job and MUST NOT be exempted
  from it.

### Key Entities

- **Target Repository**: The repository under review, named explicitly as a parameter. Owns the
  constitution, the operating settings, and the paths the reviewers inspect. Exactly one is
  supported in version one, addressed rather than assumed.
- **Operating Settings**: The version-controlled configuration read from the target repository —
  required reviewer roles, blocking severity threshold, maximum review rounds, maximum reviewable
  diff size, maximum pull request size, excluded path patterns, token budget and reviewer reserve,
  platform API request budget and reserve, maximum wait for a rate-limit reset, maximum wait for a
  review slot, escalation notification channel. Shared with every other agent working on the repository, each under its own
  named section; the service validates its own section strictly and ignores the others (FR-050).
  Missing or invalid values stop the run. The two size settings are separate:
  the maximum reviewable diff size fails the gate before review, the maximum pull request size
  produces a blocking finding that a stated justification can clear.
- **Review Run**: One complete review of one pull request revision — one round. Carries a run
  identifier, the revision examined, the roles that ran, the findings posted, the verdicts reached,
  the gate state reported, the tokens consumed, and whether it concluded. Only a concluded run is
  the baseline the next round's forward-progress check compares against.
- **Reviewer Role**: A named reviewing perspective — security or implementation — applied to the
  diff and concluding with exactly one verdict per run. Roles are ordered by precedence, with the
  security reviewer highest; precedence decides a contradiction rather than escalating it.
- **Finding**: A single observation about the diff. Carries a location, a severity, an explicit
  blocking-or-advisory status, and a description. Anchored to a diff line when addressable. A
  blocking finding the service accepted as justified additionally carries a waiver request — the
  author's justification and the reviewer's reason for accepting it — and stays open until a human
  decides it.
- **Verdict**: A role's conclusion for one revision — approve or request changes — recorded on the
  pull request and bound to the revision examined. Never inferred from silence.
- **Merge Gate**: The single required check reported by the reviewing identity, derived from the
  verdicts, and settable by no other identity.
- **Budget Ledger**: The record of every metered resource consumed against its configured budget and
  reserve for the target repository, checked before spending and reported per run. Tokens are one
  cumulative total spanning every pull request, every review, and every agent working on that
  repository, surviving between runs; their exhaustion is a hard stop, not a signal to review more
  cheaply. A configured share of the token budget is the reviewer reserve, drawable by review work
  alone, so that spend by other agents cannot leave a pull request ungated. This feature owns the
  ledger and later features record against it rather than keeping separate totals. Platform API
  requests are tracked separately because they cost nothing and refill on a reset, so their
  exhaustion pauses and resumes rather than halting the repository.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of pull requests opened or updated in the target repository receive either
  explicit verdicts from every required reviewer role or a failing merge gate — never neither.
- **SC-002**: 0 pull requests reach a mergeable state without a current passing merge gate, across
  every scenario exercised, including reviewer unavailability, mid-run failure, and budget
  exhaustion.
- **SC-003**: A diff containing a hardcoded credential yields a blocking finding anchored to the
  exact introducing line, with a request-changes verdict, in 100% of end-to-end runs.
- **SC-004**: A behavior-changing diff with no matching document under `docs/` yields a blocking
  finding from the implementation reviewer in 100% of end-to-end runs.
- **SC-005**: After any push, 0 prior approvals satisfy the merge gate, and the pull request is
  un-mergeable until a fresh review of the new revision concludes.
- **SC-006**: 0 approving verdicts are recorded on pull requests authored by the reviewing identity.
- **SC-007**: 0 merge gates are reported by any identity other than the reviewing identity, verified
  by attempting to report one from an authoring identity.
- **SC-008**: 100% of reviews are traceable to a run identifier, and 100% of concluded runs report
  tokens consumed and budget remaining.
- **SC-009**: 0 reviews exceed the configured token budget, measured as one cumulative total across
  every review and every agent's spend against the target repository; a review that would exceed it
  stops before spending and escalates.
- **SC-022**: 0 pull requests go ungated because non-review spend consumed the budget — with the
  budget drawn down to the reviewer reserve by other agents, 100% of reviews still run.
- **SC-010**: The end-to-end suite drives the complete flow with a scripted model double, passes
  from a clean checkout, and contains 0 assertions on generated wording.
- **SC-011**: 100% of escalations emit a notification through the configured channel; 0 silent halts.
- **SC-012**: The service resolves its constitution and settings through the target-repository
  parameter in 100% of runs, verified by running from an unrelated working directory; 0 reads
  derive from the process working directory.
- **SC-013**: A review of a diff of up to 1,000 changed lines concludes within 10 minutes on the
  developer machine, so that the gate does not become the reason work stalls.
- **SC-014**: 100% of pull requests exceeding the configured maximum reviewable diff size fail the
  gate with a split-the-pull-request reason, and 0 of them consume model tokens or record a verdict.
- **SC-015**: Across any number of review rounds on one pull request, 0 findings appear as
  duplicates, 100% of findings the current revision no longer exhibits are resolved, and 0 findings
  that still stand are resolved.
- **SC-016**: 0 runs exceed the configured platform API budget; 100% of runs that reach its reserve
  notify a human and either resume after the reset or escalate on exceeding the maximum wait, and 0
  of them report the gate as anything other than unreported or failing while waiting.
- **SC-017**: 0 reviews held only by the host concurrency cap report a failing gate before the
  configured maximum wait elapses, and 0 report success while queued; 100% of waits that end and
  exceeded that maximum notify a human and escalate. A wait that never ends is covered by SC-002
  instead: the gate stays unreported and the pull request stays un-mergeable.
- **SC-018**: A diff carrying a change no specification asked for yields a blocking finding from the
  implementation reviewer in 100% of end-to-end runs, and 0 pull requests exceeding the configured
  maximum pull request size are approved without either a split or a justification stated in the
  description.
- **SC-019**: 0 merge gates pass with an outstanding waiver request, and 0 waivers are granted by
  the service itself; 100% of accepted justifications escalate to a human with the finding and both
  stated reasons recorded, and 0 of them are recorded as fixes or resolved by reconciliation.
- **SC-020**: 0 rounds that neither change the head revision nor receive a reply to a blocking
  finding consume model tokens; 100% of them fail the gate and escalate on the first such round
  rather than at the round cap, and 0 retries following a round that did not conclude are
  misclassified as failed rounds.
- **SC-021**: 100% of escalations state their reason on the pull request in addition to notifying
  the configured channel.
- **SC-024**: 0 reviews run while the merge gate is not a required check or a needed permission is
  absent; 100% of those cases fail the gate naming the missing prerequisite, escalate, and consume 0
  model tokens.
- **SC-023**: 0 security-reviewer blocking findings are cleared, downgraded, or withdrawn by another
  role's contrary conclusion, and 0 such contradictions escalate as disagreements; 100% of
  contradictions between roles of equal precedence fail the gate and escalate instead of returning a
  request-changes to the author.

## Assumptions

Reasonable defaults chosen where the description did not specify. Each is derived from the
constitution and may be revised in planning.

- **Severity scale**: findings carry one of `critical`, `high`, `medium`, `low`. The blocking
  threshold defaults to `high` and above, and is an operating setting (FR-013) rather than a fixed
  value, so a target repository can tighten it without a code change.
- **Verdict granularity**: each role records its own verdict, and a single aggregate merge gate is
  derived from them. One check is required by branch protection rather than one per role, so that
  adding a reviewer role later does not require reconfiguring branch protection.
- **Self-authored pull requests**: treated as a case where the reviewer cannot legitimately review.
  The gate fails and the case escalates, consistent with Principle IV's rule that the system
  degrades to stopped rather than to unreviewed.
- **Budget exhaustion**: no partial approval is ever recorded. A review that cannot complete within
  budget fails the gate, matching the treatment of any other inability to review.
- **Shared ledger**: the token budget meters the whole loop, not this service alone, so the ledger
  is defined here as a repository-wide resource that later features record against. The reviewer
  reserve exists because the alternative failure is the worst one available: an author agent
  spending the pot dry would stop reviews from running, which under Principle IV is degrading to
  unreviewed rather than to stopped. Where the ledger lives and how it is addressed are planning
  decisions, constrained by FR-038's requirement that it survive between runs.
- **Review scheduling**: reviewer jobs count as agents for Principle VIII's host-wide concurrency
  cap and are never exempt. Queuing rather than failing keeps an ordinary scheduling delay from
  reading as a review failure, and the bounded wait keeps a stuck queue from being invisible. How
  the queue is implemented is a planning decision.
- **Platform API allowance**: free of monetary cost but capped per hour, and it refills, which is
  why FR-040 pauses where FR-031 hard-stops. The binding constraint is expected to be the secondary
  limit on content-creating requests rather than the primary hourly ceiling, since posting findings
  across many rounds is this service's heaviest call pattern. Exact ceilings are a planning input to
  be read from current platform documentation, not fixed here.
- **Review depth**: an optional setting (FR-054) rather than a required one, because a repository
  should be able to start reviewing without first reasoning about how hard the model ought to think.
  The lever exists for the repository that later finds its reviews too shallow or too expensive; until
  then a documented default applies and is reported with every run.
- **Model provider**: undecided at spec time and deliberately left behind FR-029's substitutable
  interface — a free or locally hosted model, or a paid managed model service. The cumulative
  budget and its hard stop bind either way: a free provider sets the budget differently rather than
  making it unnecessary, so the ledger and the pre-spend check are built regardless of the choice.
- **Pull request size**: two separate limits, both operating settings (FR-028), and neither
  substitutes for the other. The maximum *reviewable* diff size (FR-037) is the point past which a
  review cannot honestly be performed: the gate fails before anything is spent, and the service does
  not chunk, sample, or partially review — splitting is the author's job, and Principle I already
  requires feature-sized, independently testable slices. The maximum *pull request* size (FR-043) is
  Principle X's discipline cap, defaulting to 400 changed lines excluding generated files: exceeding
  it is a blocking finding that a justification in the description clears, because some changes
  genuinely are irreducible. The reviewable cap is expected to sit well above the pull request cap;
  both specific values are planning decisions informed by SC-013.
- **Scope minimality**: the implementation reviewer judges whether a change traces to the pull
  request's specification, using the same reading of the diff it already performs for tests and
  documents (FR-042). Unrelated content is a blocking finding rather than a bonus, per Principle X.
  Adjacent cleanup an author notices belongs in its own spec and its own pull request; the reviewer
  says so rather than accepting it.
- **Behavior change detection**: the implementation reviewer determines whether a diff changes
  behavior. Documentation-only and comment-only diffs do not trigger the test and document checks.
- **Comment lifecycle across rounds**: a pull request may take many review rounds, and each round
  reconciles rather than re-posts, so the comment thread stays readable however long the loop runs.
  The reviewer resolves only findings it raised and only once the revision under review no longer
  exhibits them; it never resolves another party's comment, and never resolves one merely for being
  old. This is the one carve-out from FR-015, and it is the reviewer confirming a fix, not an author
  hiding a comment — the behavior Principle VI actually prohibits.
- **Role precedence**: the constitution requires reviewer disagreement to escalate rather than be
  resolved by attrition, but a disagreement with a settled answer is not a disagreement. Security
  outranks the other roles, so a security block is decided rather than escalated, and only a
  contradiction between roles of equal precedence reaches a human. In version one the only roles are
  security and implementation, so every contradiction is decided by precedence and the
  equal-precedence path exists for the roles a later feature adds. Because no pair of equal-precedence
  roles exists yet, User Story 1's eighth acceptance scenario is verified by unit test in version one
  rather than end-to-end; it becomes an end-to-end case with the third role. An author who believes a standing
  finding is wrong answers it with a justification and reaches a human through the waiver path rather
  than by re-pushing.
- **Waivers**: reading replies to its own findings is the reviewer's job, because only the reviewer
  can say whether its finding still holds; granting the waiver is a human's, because Principle V
  forbids merging a change carrying a waived finding on an agent's say-so. Accepting a justification
  therefore stops the finding blocking without approving the pull request — it converts a deadlock
  into an escalation, which is the outcome Principle VI prescribes for disagreement. The reviewer
  never resolves such a finding: the code still exhibits it, and the record must show that.
- **Review rounds**: the service counts its own rounds per pull request. Driving the author's
  remediation loop belongs to the orchestrator and is out of scope; the round cap, the
  forward-progress check, and their escalations live here, because only the reviewer knows how many
  times it has reviewed and what changed between those times. Progress is an event comparison rather
  than a timeout — the service runs only on a pull request event, so there is no clock to wait out,
  and comparing consecutive concluded rounds keeps an infrastructure retry from reading as a stalled
  author.
- **Target repository**: version one is exercised against the repository the service lives in,
  supplied by name as a parameter like any other target. Multi-repository support is out of scope,
  and so is hardcoding a single repository.
- **Runner**: a self-hosted runner on the developer machine, so that model credentials stay in the
  local environment or keychain and never enter continuous-integration secrets.
- **Branch protection**: configured by a human out-of-band, since an identity that can change branch
  protection can remove the gate. The service depends on that configuration, documents it, and — per
  FR-051 — verifies it before each review, but never changes it. Verifying costs one read and turns the
  quietest failure in the system into a loud one; the ability to write branch protection is what the
  service must not have, and reading it is not that.
- **Escalation channel**: the notification channel is an operating setting; the specific transport
  is a planning decision, and a missing configured channel stops the run under FR-028.

## Out of Scope

Each is a later feature that depends on this one.

- The orchestrator loop and its state machine.
- Automatic merging of pull requests, and the author-side loop that addresses review comments.
- Isolated checkouts, worktrees, and parallel agent execution.
- Evaluation suites measuring reviewer quality against a real model.
- Support for more than one target repository at a time.
- Reviewer roles beyond security and implementation.
- Recording other agents' spend against the shared token ledger. This feature defines and owns the
  ledger and the reviewer reserve; each later feature records its own spend against it.
- Granting waivers. This feature raises a waiver request and escalates it; the human decision and
  the mechanism that records it belong to the orchestrator.
- Managing branch protection settings, or provisioning the reviewing identity's installation.

## Dependencies

- A hosting platform providing pull requests, line-anchored review comments, review states,
  required status checks, and branch protection.
- A distinct reviewing identity, installed on the target repository with least-privilege
  permissions, and separate from every authoring identity.
- A self-hosted runner on the developer machine, with model credentials available from its local
  environment or keychain.
- The target repository's constitution at `.specify/memory/constitution.md` and its version-
  controlled operating settings.
- Model API access within the configured token budget.
- A human-approved waiver, when one is granted, recorded against the reviewed revision where the
  service can read it — the service raises the waiver request but does not grant or record the
  decision (FR-045).

## Post-Ratification Addenda

Principle IX: *"The spec under `specs/` records what was intended, at the time it was intended, and
is never rewritten."* Nothing above this heading is edited. Where a decision has moved since the
spec was written, it is recorded here as a dated entry, so the original intent and its later
revision are both legible. What is true *now* is in
[docs/independent-review-service.md](../../docs/independent-review-service.md) and
[docs/prerequisites.md](../../docs/prerequisites.md); this section only records that a change
happened and why.

### 2026-08-17 — FR-032: a third local credential source

**FR-032 as written** enumerates two sources: "Model credentials MUST come from the local
environment or an OS keychain, MUST NOT be read from continuous-integration secrets, and MUST NOT
appear in records, comments, or prompts."

**What changed.** The service now also accepts an OAuth profile written by `ant auth login` under
`~/.config/anthropic/` (relocatable via `ANTHROPIC_CONFIG_DIR`), and that is the preferred source.
This is the implemented and verified path; a static `ANTHROPIC_API_KEY` remains supported.

**Why the requirement itself is unchanged.** FR-032's invariant is that the credential is *local to
the runner*, never from CI, and never in records, comments, or prompts. A profile satisfies all
three, and satisfies the third more strongly than either original source: the SDK reads the profile
itself, so **the secret never enters the service's process at all** — there is no value in memory to
redact, log, or leak. The enumeration was a closed list of two written before the profile path was
considered; the property it was protecting is intact.

**Consequences recorded elsewhere:**

- Amazon Bedrock and Google Vertex AI were considered and rejected — both require a cloud account,
  which Principle IV prohibits without a constitutional amendment. Workload Identity Federation
  remains the likely end state for an unattended runner, because OAuth refresh tokens hard-expire.
- The credential is now resolved to a `ModelCredential` carrying its `source`, rather than to a
  bare key string, because a profile credential legitimately carries no key.
- **Presence is verified as a startup prerequisite**, alongside the FR-003 permission check and the
  FR-025 branch-protection check, so an absent credential fails with a stated reason and zero spend
  rather than surfacing as a `401` partway through a review. FR-051 names only permissions and
  branch protection; this extends the same pre-spend discipline to FR-032 without altering what
  FR-051 requires.
