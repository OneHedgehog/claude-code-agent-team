# Feature Specification: Routing Each Reviewer Role To Its Own Provider

**Feature Branch**: `reviewer-provider-routing`

**Created**: 2026-09-16

**Status**: Draft

**Input**: The reviewer reaches exactly one model family, so one quota outage stops the gate and
both required roles share one set of blind spots. This gives each role an ordered route across
providers, fails over on capacity and never on contract, and accounts for the spend per provider.

## Why this is its own spec

Spec 003 gave the reviewer a second *transport* — a second way to reach the same model family,
selected by one global `modelTransport` setting. That is not the same as a second *provider*, and
the difference is what this spec exists to close. A transport chooses who is billed. A provider
chooses who is reviewing.

Three new obligations follow, none of them restatements of FR-055 or FR-057: a route is per-role
rather than global, failover has to distinguish failures it may retry elsewhere from failures it
must not, and a budget stated as one number stops meaning anything once the tokens behind it come
from different accounts. Principle I requires each to trace to a spec.

## What the record already shows

[#9](https://github.com/OneHedgehog/claude-code-agent-team/pull/9) was reviewed nine times. **Two
of those rounds produced no verdict because the operator's subscription session limit was reached**
([spec 005](../005-transport-merge-override/spec.md)). FR-065 makes that fail closed, which is
correct and is not the complaint. The complaint is that failing closed with one provider configured
means the gate cannot close *at all* until a quota the service does not control replenishes — and
`main` stays shut behind it, including to the change that would fix it. That is the deadlock spec
003 was written to end, re-entered through a different door.

The second problem is quieter. `requiredReviewerRoles` is `["security", "implementation"]`, and
today both run on one model family. Two roles drawing on one model share their failure modes: a
class of defect that family does not see is a class no required role sees, and the gate reports
green with the same confidence either way. Principle VI's independence is real at the GitHub
identity level — the reviewer App is not the author — and absent at the model level.

## Clarifications

### Session 2026-09-19

- Q: Should the two required reviewer roles default to sharing one provider, or to a provider
  different from the author's? → A: Separate them. Claude Code authors; review runs on another
  provider. FR-082 is active on this repository rather than dormant.
- Q: Under failover, does the time limit apply per attempt or to the role as a whole? → A: Per
  attempt, and shortened from 15 minutes to 5.
- Q: Does the project-wide token budget remain as a ceiling above the per-provider budgets, or is
  it replaced by them? → A: Replaced. **Superseded by the 2026-09-20 session below**, which moves
  the limit from the provider to the funding account; the "replaced, not kept above" half stands.

### Session 2026-09-20 (scope)

- Q: Is a provider outside the current model family in scope? → A: **No.** The operator's decision
  is to stay on Claude for now. FR-077 is restated below to require what is actually built — more
  than one provider on more than one funding account — and the stronger form, a second model
  *family*, is recorded as out of scope rather than left standing as an unmet MUST. SC-007 and
  model-level independence go with it, and FR-082's check ships built, tested and dormant.

  Corrected here rather than in `tasks.md`, where it was first written. Principle IX protects a
  *merged* spec as the record of intent at the time; this one has never merged, so landing it with
  a requirement its own task list disclaims would put a false MUST into the repository on day one.

### Session 2026-09-20

- Q: Where do budgets and reserves attach, now that one vendor can serve several model families
  through one credential? → A: **To the funding account.** Attribution stays at the provider.
  Budgeting per provider would let two providers on one account carry two budgets whose sum
  exceeds what the account holds, each passing its own reserve check while the shared quota was
  exhausted — the failure FR-081 exists to prevent, one level up.
- Q: Does `modelTransport` survive this feature? → A: Retained as a **deprecated alias**, read by
  the migration only. Declaring both `modelTransport` and `providers` in one file is a declaration
  error at preflight, so there is never a second source of truth about how a model is reached.
- Q: What result from the provider-quality replay permits a new provider to carry a required role?
  → A: It MUST surface every recorded **blocking** finding in the replayed rounds; a single miss
  blocks promotion. Its additional findings are judged by a human, whose decision is recorded.

## Acceptance scenarios

The failover rule is the part of this feature that can be wrong while looking right, so it is
pinned here rather than left to the requirements alone.

1. **Given** a role whose route is `[A, B]` and **A** refuses with a session limit, **When** the
   role runs, **Then** **B** is asked, the role produces one verdict, and the record names **B** as
   its author and **A** as a capacity failure.
2. **Given** the same route and **A** returns a response that misses the review schema, **When** the
   role runs, **Then** **B** is NOT asked, the role produces a missing verdict, and the gate fails
   with the schema violation as its stated reason.
3. **Given** a route where every provider returns a capacity failure, **When** the role runs,
   **Then** the gate fails closed, the stated reason names each provider and its failure class, and
   no further provider is invented, no limit is raised, and no required role is dropped.
4. **Given** a settings file that declares only `modelTransport` and no routes, **When** the service
   starts, **Then** it runs exactly as it did before this feature and reports the same effective
   behaviour.
5. **Given** a route naming a provider whose credential is absent, **When** the service starts,
   **Then** preflight fails before any model call and names the provider and the missing credential.
6. **Given** a run in which one role used **A** and the other used **B**, **When** the spend is
   read, **Then** each provider's draw is readable separately and neither is reported only as part
   of a combined total.
7. **Given** settings naming the authoring provider and a route placing that same provider under a
   required reviewer role, **When** the service starts, **Then** preflight fails and names the
   violation, unless an override with a recorded reason is present in the settings.
8. **Given** a route `[A, B]` and **A** still running at the 5-minute bound, **When** the bound
   expires, **Then** **A** is cancelled rather than abandoned, its spend is charged at no less than
   the prompt it sent (FR-067), and **B** is asked.
9. **Given** a route long enough that its attempts at 5 minutes each could outlast
   `maxQueueWaitSeconds`, **When** the service starts, **Then** preflight fails rather than letting
   a review hold the only slot past the wait everything queued behind it agreed to.

### Edge cases

- A route listing the same provider twice: the second entry buys nothing, since a capacity failure
  will not have cleared. Treated as a declaration error at preflight rather than honoured.
- A provider that returns a well-formed response of no substance — a verdict with no findings on a
  diff that plainly has them. This is not detectable as a failure and MUST NOT be treated as one;
  it is a quality question that the measurement in Assumptions answers, not a routing question.
- A credential that expires between preflight and the model call: a capacity failure, and the route
  advances.
- A capacity failure on the last provider of one role while another role has already produced a
  verdict: the run still fails closed, and the successful role's verdict does not carry the gate.
- An empty route, or a role named in `requiredReviewerRoles` with no route: a declaration error at
  preflight, never an implicit fallback to some default provider.

## Requirements

- **FR-076**: Each required reviewer role MUST resolve to an ordered list of providers — its
  *route* — declared in the operating settings and reported as effective with each run (FR-054). A
  settings file that declares only `modelTransport` MUST keep working unchanged, as the single-entry
  route it already describes; this feature adds a dimension, it does not invalidate a configuration.
  `modelTransport` is thereby **deprecated but retained**: it is read by the migration and MUST NOT
  be declared alongside `providers`, since two descriptions of how a model is reached is one more
  than can be true.
- **FR-077**: More than one provider MUST be supported behind the existing `ModelClient` boundary
  (FR-029), with no second seam, and a role's route MUST be able to span **more than one funding
  account** — which is what makes failover buy availability rather than only variety.

  **A provider outside the current model family is the stronger form of this requirement and is
  out of scope** (Clarifications, 2026-09-20). It is what would buy *independence*; two providers
  of one family on two accounts buy *availability*, which is the property pull request #9 actually
  lost. The distinction is R-029's and it is load-bearing: this feature delivers the second and
  not the first, and says so rather than implying both. One prompt builder and one
  response parser MUST continue to serve every provider, extending FR-057 for the same reason it
  was written: the injection guard (FR-036) and the response contract MUST NOT be able to drift
  between routes.
- **FR-078**: Failover MUST be restricted to **capacity** failures, and MUST NOT occur on
  **contract** failures. The two classes MUST be distinguishable in the record, not merged into a
  generic call failure.
  - *Capacity* — session limit, rate limit, exhausted credit, provider unreachable, deadline
    (FR-066) — says nothing about the reviewed revision. The next provider in the route MAY be
    asked.
  - *Contract* — a response that misses the schema (FR-059), a refused tool (FR-064), an absent
    verdict (FR-007) — is a statement about this run or this content. Asking a different provider
    would be shopping for a verdict, and a gate that keeps asking until something approves is not a
    gate. It fails the revision exactly as it does today.
- **FR-079**: Failover MUST NOT change how many verdicts a role produces. Exactly one verdict per
  role per revision, from exactly one provider, and the record MUST name which — a verdict whose
  author is unrecorded cannot be weighed later against that provider's track record (Principle VII).
  The naming MUST appear in the check-run output, not only in a local log: that output is already
  the authoritative record the ledger is rebuilt from (`reconstruct.ts`), and attribution that
  lives only on the host is lost to anyone reading the pull request and to any later
  reconstruction.
- **FR-080**: An exhausted route MUST fail closed. When every provider in a role's route has
  returned a capacity failure, the role produces a missing verdict and the gate fails, with a stated
  reason naming each provider tried and its failure class. Principle IV applies unchanged: the
  service MUST NOT resolve exhaustion by enabling billing, raising a limit, or dropping a required
  role. The system degrades to stopped.
- **FR-081**: Spend MUST be attributed to the **provider** that incurred it, and **every budget and
  reserve MUST be per funding account**. The single project-wide total is superseded rather than
  kept above them: FR-031's one number was written when every token came from one account, and it
  silently adds a token drawn against an exhausted balance to one drawn against a fresh
  subscription, so a healthy total can conceal the exact exhaustion FR-047's reserve exists to
  prevent. Tokens from different accounts are different resources and MUST NOT be summed into a
  limit. FR-031 and FR-047 are superseded in this respect and not rewritten (Principle IX).

  **Attribution and limits sit at different levels, deliberately.** A provider is a vendor and a
  model family; an account is what gets billed or throttled. One account can serve several
  providers — a vendor offering more than one model family through one credential is the ordinary
  case, not a corner — and when it does, those providers draw on **one** metered resource. Budgets
  therefore attach to the account, because that is the thing that can actually run out. Attribution
  stays at the provider, because that is the thing whose judgement is later weighed (Principle VII)
  and whose draw must be readable on its own (SC-003).

  Budgeting per provider instead would recreate the failure this requirement exists to prevent:
  two providers on one account would carry two independent budgets whose sum exceeds what the
  account holds, and each would pass its own reserve check while the shared quota was exhausted.
  Principle IV requires every metered resource to carry a budget with a reserve; the metered
  resource is the account.

  The reserve keeps its meaning: `review` remains the only actor permitted to draw into it, now
  checked against the reserve of the **account** being charged. A ledger entry MUST carry both its
  provider and its account; an entry carrying neither cannot be attributed, and an entry without an
  account cannot be checked against any reserve.

  **What is lost, and what is not.** No declared number caps total spend any more. The total is
  still *bounded* — by the sum of the per-account budgets — and still *reportable*, since
  attribution makes both the per-provider and per-account sums computable at any feature boundary.
  What an operator can no longer do is set a ceiling below that sum. Principle IV's protection
  therefore comes from the individual budgets being set deliberately rather than from one backstop,
  which is a weaker guarantee and is recorded as such.

  **Migration.** A settings file predating this feature declares one transport and one budget. It
  MUST be read as the single-provider, single-account configuration it describes, with the former
  global budget and reserve becoming that account's own. No operator action, and SC-005 holds.
- **FR-082**: No required reviewer role MAY run on the provider the authoring identity uses, unless
  an operator overrides this with a reason recorded in version control. Principle VI makes
  independence structural rather than conventional; a reviewer drawing on the same model that wrote
  the diff is independent in identity and not in judgement.

  **On this repository the authoring provider is Claude Code**, so this requirement binds from the
  first run rather than waiting for an authoring loop to exist. Claude Code writes the code and
  every required reviewer role runs elsewhere. The operating settings MUST name the authoring
  provider explicitly — an independence rule that infers who the author was cannot be validated at
  preflight, and one that is not validated at preflight is discovered after the spend.

  **What this costs, stated because it is the direct consequence of the rule.** Excluding the
  authoring provider from every route removes it as a fallback. A route that today could have
  ended at Claude Code now ends at whatever non-authoring providers are declared, so the quota
  resilience of SC-001 requires **at least two** of them; with exactly one, this feature improves
  review independence and does not improve gate availability. Which of the two properties is worth
  more is an operator's call, and FR-082's override is where they make it — in version control,
  with a reason, rather than by a provider silently reappearing in a route.
- **FR-083**: Every provider MUST discharge the containment FR-058 and FR-063 establish — no tools,
  no inherited settings, no access to the orchestrator's working tree, an allowlisted environment,
  an empty working directory, and neutralisation of any credential belonging to a provider other
  than the one being invoked. A provider MUST NOT be addable without stating how it satisfies each;
  reviewed content is untrusted data whichever vendor reads it (Principle V).
- **FR-084**: Every credential a declared route depends on MUST be verified as a startup
  prerequisite, before any spend, alongside the checks already made for permissions and branch
  protection. A route naming an unconfigured provider MUST fail preflight rather than surface as a
  failed review after the first two have been paid for. This holds for a last-resort entry as much
  as a first one: a fallback that has never been verified is not a fallback, and the moment it is
  reached is the moment nothing else is left to try.
- **FR-085**: Routing and failover MUST be exercisable end-to-end with scripted providers alone.
  Principle II permits exactly one substitution in the e2e layer — the model boundary — and a
  failover path that can only be demonstrated by exhausting a real vendor's quota is a path that
  will not be tested.

- **FR-086**: A review attempt MUST be bounded at **5 minutes**, applied to each provider's attempt
  separately rather than to the role as a whole. This supersedes the 15-minute bound FR-066 set
  when the reviewer had one route; spec 003 is not rewritten (Principle IX) and this requirement is
  where the live value lives. Expiry remains a capacity failure, so it advances the route (FR-078)
  rather than ending the role.

  Per-attempt is safe here only because of the arithmetic: at 5 minutes a three-provider route
  bounds a role at 15, against the 30-minute promise `maxQueueWaitSeconds` makes to everything
  queued behind it. Because the safety is arithmetic, preflight MUST check it rather than assume
  it — a configuration whose longest route, multiplied by this bound, could exceed
  `maxQueueWaitSeconds` MUST fail before any review starts.

  **What it costs, stated because it is a real cost and it lands unevenly.** Five minutes is a
  tightening, and FR-066 chose fifteen with a large diff at high effort on a slow host in mind. A
  review that would have finished in eight minutes now expires. On a route with a second provider
  that expiry is a failover and costs latency; on a route of one — which is what FR-082 currently
  produces on this repository, with Claude Code excluded as the author — it is a missing verdict
  and a failed gate. The tighter bound therefore bites hardest in exactly today's configuration.
  It is recorded here so that a rise in missing verdicts after this ships is read as this decision
  rather than as a fault in the new provider.
## Key entities

- **Provider** — a named way of reaching one model family, carrying its funding source (metered or
  subscription), its credential requirement, and its containment declaration. Distinct from a
  *transport*, which is how a provider is reached.
- **Route** — an ordered, non-empty list of providers belonging to one reviewer role. Advanced only
  on a capacity failure; exhausted rather than restarted.
- **Failure class** — `capacity` or `contract`. Determines whether a route advances, and is recorded
  with the attempt.

## Success criteria

- **SC-001**: With two or more non-authoring providers **drawing on different funding accounts**, a
  review round that today produces no verdict because one provider's quota is exhausted produces
  one instead, with no operator action and no change to what the gate requires. Measured against
  #9's record: 2 rounds in 9 lost this way, target 0. **With exactly one declared, this criterion
  is not met and is not claimed** — FR-082 removes the author's provider as a fallback, and a route
  of one cannot fail over. **Nor is it met by two providers sharing one account**: different model
  families on one credential improve independence and not availability, because one session limit
  ends both.
- **SC-002**: Every verdict on record names the provider that produced it, and every recorded
  attempt names its failure class. 100% of run records, not a sample.
- **SC-003**: Remaining budget is readable **per account, and spend per provider**, at every
  feature boundary, so that an account approaching exhaustion is visible before it stops a review
  rather than because it did. The two levels are both required: the account is what runs out, and
  the provider is what the draw is attributable to (FR-081).
- **SC-004**: A response that misses the schema fails the revision without any second provider being
  asked — demonstrated in the e2e layer, against scripted providers, with no real quota involved.
- **SC-005**: An operating settings file written before this feature runs unchanged, and its run
  record reports the same effective behaviour it reported before.
- **SC-006**: **Unproven rather than demonstrated.** The seam is built so that adding a further
  provider needs only a declaration and its containment statement — no change to the reviewer
  roles, the gate, or the prompt and parser — but no provider was added under this scope, so
  nothing exercises the claim. It is recorded as a design property awaiting its first real test
  rather than as a criterion this change meets.

- **SC-007**: **Not met, and not claimed.** Every provider reachable here is the family that
  authors the code, so no `authoringProvider` is declared and FR-082's check has no subject. The
  check is built and tested so that it binds the moment a second family exists; until then a
  reviewer is independent in identity — the App is not the author — and not in judgement. Stated
  as unmet rather than quietly dropped, because a success criterion nobody can demonstrate is
  worse than one openly deferred.
## What this does not do

- **It does not route authoring work.** No authoring client exists in this repository: `ModelClient`
  has one method, `review`. Pointing a second vendor at code *generation* — the "Gemini writes,
  Claude plans" arrangement — requires the autonomous authoring loop
  ([docs/requirements/autonomous-iteration-loop.md](../../docs/requirements/autonomous-iteration-loop.md)),
  which is unbuilt and is its own sequence of specs. What this feature fixes is the other side of
  that separation: authoring stays where it is, on Claude Code, and review moves off it (FR-082).
  Naming the authoring provider in settings is the whole of what this spec does about authoring.
- It does not add parallel features, auto-merge, or any change to concurrency. `maxConcurrentAgents`
  and `maxConcurrentReviews` keep their meanings and their values.
- It does not change the reviewer roles, the severity scale, the blocking threshold, or the size
  caps.
- It does not make a provider substitutable mid-round. A role that has begun with one provider
  finishes with it or fails.
- It does not reduce what a review costs. Cheaper review is a separate spec; this one makes the
  spend legible per account, which that spec will need and does not have.

**On packaging.** Principle X's cap is 400 changed lines and this will not fit under it in one
pull request. The split that each half can pass the feature gates on its own: the routing seam,
failure classification, per-provider accounting and scripted-provider e2e first — complete and
useful with a single-entry route — then the first additional provider and its containment
declaration second. Stacked halves that only work together would violate Principle I rather than
comply with Principle X.

## Assumptions

- **No new metered spend.** Principle IV governs: any provider added here is funded by a
  subscription or free tier the operator already holds. A provider that can only be reached with a
  metered credential is out of scope for this feature.
- **Candidate providers are Antigravity and Cursor.** Both were confirmed driveable headless
  during planning; Antigravity ships first (research R-020). The `gemini` CLI named in earlier
  drafts is a **deprecated** surface superseded by Antigravity's `agy`, and is not a candidate.
  **A product with no non-interactive interface a daemon can drive cannot be a provider** — that
  test stands for every provider added later.
- **Review does not run on the authoring provider.** Claude Code writes the code here; every
  required reviewer role runs on another provider (FR-082). The two roles MAY share that provider
  as long as it is not the author's — separating them from each other is a further step this
  feature permits and does not require, because pinning a required role to a provider whose review
  quality has not been measured trades gate quality for independence, and the point of independence
  is a better gate.
- **Review quality on a new provider is a risk this feature accepts and must measure.** Moving both
  required roles off the only provider whose review output this project has ever seen is a larger
  change than adding a fallback would have been. Planning MUST say how the new provider's review
  quality is established before it becomes the gate — replaying reviewed pull requests whose
  findings are already on record is the obvious method and the one this repository can afford.
- Reviewer roles remain `security` and `implementation`.
- The GitHub App remains the sole reviewing identity regardless of which provider produced the
  verdict. Provider diversity is about judgement, not about who may write a check run (FR-002).
- The existing scripted double remains the e2e substitution, extended to stand in for several
  providers rather than replaced.
