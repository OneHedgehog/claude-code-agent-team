# Implementation Plan: Asking Again When a Reply Misses the Schema

**Spec**: [spec.md](./spec.md) · **Branch**: `retry-schema-violation` · **Created**: 2026-09-06

## Approach

One further ask inside `AgentSdkModelClient.review`, and nothing above the model boundary changes.
The attempt loop lives in `review()`; the existing single-ask body becomes `#ask`. The roles, the
gate, the ledger and the daemon are untouched.

No new dependency, no new adapter, no new setting. The retry is not configurable: an operator who
could set it to zero would be choosing to lose a third of role-calls, and one who could set it to
five would be paying for asks that FR-070 explains will not help.

## Complexity Tracking

Two decisions depart from what the constitution would otherwise prefer. Both are recorded here
rather than left in code comments, because a departure nobody wrote down is a departure nobody can
review.

### The predicate keys on another module's error message, not on a type

`isSchemaViolation` matches `/(did not satisfy the review schema|was not JSON)/` against
`ModelError.message`. Principle III prefers types to string matching, and a `SchemaError` subclass
would be the typed answer.

**Why not.** `parseReviewResponse` is shared with the API transport (FR-057), and that sharing is
what keeps the injection guard and the response contract from drifting between the two paths. Giving
it a new error type changes the `api` path too — for a behaviour only `agent-sdk` needs — and the
whole reason the parser is shared is that neither transport gets to diverge quietly.

**What it costs.** If the parser's message is reworded, the retry stops firing and every test still
passes. That is a real trap, and it is why the majority arm (`did not satisfy the review schema`,
which is valid JSON of the wrong shape) has its own test rather than being covered incidentally by
the prose cases.

**Failure direction.** Safe. A miscategorised failure is asked once more and then reported exactly
as it would have been; a missed category means one fewer retry, not a wrong verdict.

### One wall-clock bound is shared across attempts

FR-066 gives a review fifteen minutes. The obvious implementation creates the `AbortController`
inside the ask, which is simpler and wrong: it gives a retried review two full budgets and silently
doubles the number an operator schedules around. The first revision of this feature did exactly
that, and review caught it.

So the controller is created once in `review()` and passed down, and the retry consumes the
remainder. The cost is that a first ask which nearly exhausts the bound leaves the retry little
room — the retry's value then depends on how the first attempt failed. That is the correct trade:
an operator's timeout promise is worth more than a retry's success rate.

## Footprint

One file carries the behaviour (`src/model/agent-sdk.ts`); the record needs a field in
`src/observability/logger.ts`, `schemas/review-record.schema.json` and one lambda in
`src/composition.ts`. Tests in `tests/unit/model/agent-sdk.test.ts` and one wiring case in
`tests/integration/composition.test.ts`.

Nothing is parallel-safe here in the sense Principle VIII means: it is a single sequential change to
one adapter and the record it emits.

## Verification

`npm run check`, plus the transport's own end-to-end scenarios against the real fixture. Beyond the
suite, this pull request is reviewed by the service through the transport it changes — which is also
how the rate that motivates it was measured.
