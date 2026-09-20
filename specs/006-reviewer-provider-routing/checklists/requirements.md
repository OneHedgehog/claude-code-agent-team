# Specification Quality Checklist: Routing Each Reviewer Role To Its Own Provider

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-16
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

Three items passed only with a qualification, recorded here so a reviewer weighs the judgement
rather than the tick.

**"No implementation details" and "no implementation details leak in."** The spec names
`ModelClient`, `modelTransport`, `requiredReviewerRoles`, `maxConcurrentReviews`,
`maxQueueWaitSeconds`, `reconstruct.ts`, and a list of FR numbers. These are this project's own existing contracts and operating settings, not technology
choices being made here — the same convention specs 003 and 004 follow. No language, framework,
library, or vendor API is selected: the candidate providers appear in Assumptions as *candidates*,
and which one ships is explicitly deferred to planning research. The item is read as prohibiting
new implementation decisions, which the spec makes none of.

**"Written for non-technical stakeholders."** The stakeholder for this feature is the operator of
an autonomous review service. The spec avoids code and mechanism, but it does assume a reader who
knows what a reviewer role and a merge gate are. There is no audience for this document that does
not.

**Resolved in the 2026-09-19 clarification session** (was: two items deferred here, both now
answered in the spec's Clarifications section):

1. Role/author separation — **decided**: Claude Code authors, review runs elsewhere. FR-082 is
   active rather than dormant, and the cost of losing the author's provider as a fallback is
   recorded in FR-082 and in SC-001's conditional wording.
2. Attempt deadline under failover — **decided**: per attempt, shortened to 5 minutes (FR-086,
   superseding FR-066's value). Its uneven cost on a single-provider route is recorded.
3. Budget model — **decided**: the project-wide total is replaced rather than kept above (FR-081,
   superseding FR-031 and FR-047 in that respect). The loss of a declared overall ceiling is
   recorded rather than glossed. **Amended 2026-09-20**: the replacement limits sit on the funding
   **account**, not on the provider — planning found that one vendor can serve several families
   through one credential, so per-provider budgets would have let two providers pass independent
   reserve checks against one exhausted quota.

Whether a metered provider is acceptable was not asked: the spec says no, from Principle IV. An
operator willing to spend would want that revisited.

**Two lower-impact ambiguities were resolved by informed default rather than by spending a
question**, and both are written into requirements rather than left implicit: verdict attribution
goes into the check-run output rather than a local log (FR-079), and a last-resort provider must be
credential-verified at preflight like any other (FR-084).

**One dependency that planning must settle before anything else.** Whether Antigravity, and
whether Cursor, exposes a non-interactive interface a daemon can drive. If neither does, FR-077
cannot be satisfied by either candidate and the feature needs a different provider or a different
shape. This is research, not a specification gap, but it is load-bearing enough that a plan which
does not answer it first is not a plan.
