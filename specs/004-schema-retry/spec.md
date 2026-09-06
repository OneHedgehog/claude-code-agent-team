# Feature Specification: Asking Again When a Reply Misses the Schema

**Feature Branch**: `retry-schema-violation`

**Created**: 2026-09-06

**Status**: Proposed

**Input**: Feature 003 disclosed that the subscription transport makes a malformed response rejected
rather than impossible. The disclosure was accurate; the rate was not known. It cost roughly a third
of role-calls, which left two pull requests approved on their merits and unmergeable in practice.

## Why this is its own spec

Review raised this against the first revision, and it was right: feature 003's spec is merged, and
Principle IX says a spec "records what was intended, at the time it was intended, and is never
rewritten". Appending a requirement to it so that this code has something to trace to inverts the
direction Principle I requires, and leaves 003's spec no longer a truthful account of what 003
shipped.

So this is a feature. It has its own bound, its own telemetry, its own refusals and its own tests.
FR-059 stays exactly as written — it described the behaviour 003 shipped, and it was correct.

## What was learned after 003 merged

FR-059 records the trade-off: `api` constrains generation with `output_config.format`, so malformed
output is impossible; `agent-sdk` asks for the schema in words and validates on arrival, so
malformed output is rejected. What no one could state at the time was how often that happens.

Across feature 003's own nine review rounds, **roughly a third of role-calls were lost to schema
violations** — `must NOT have additional properties`, `must have required property 'path'`, `data
must be object`. Because a gate needs *both* roles to comply on the same revision, more rounds
failed for that reason than passed.

That compounds with FR-046. A round that fails with no findings leaves nothing to reply to and no
revision to change, so the pull request cannot be looked at again. Two pull requests reached exactly
that state: an approving reviewer, no open blocking finding, and no legitimate way to ask again.

A disclosed weakness that costs a third of throughput is a defect in practice whatever it is in
principle. This feature is the correction.

## Requirements

- **FR-069**: A reply that fails schema validation MUST be asked for once more before the review is
  recorded as having produced no verdict.
- **FR-070**: The retry MUST be bounded at one further ask. A model that misses the schema twice —
  given the schema, and told its first reply was discarded — will not be talked round by a third,
  and every attempt spends.
- **FR-071**: The second ask MUST carry the correction and MUST NOT carry the rejected reply. Prose
  fed back as context is prose invited again.
- **FR-072**: Only a schema violation MUST be retried. An unauthenticated host, a subscription
  limit, an expired deadline and a refused tool are states an identical second ask cannot improve,
  and retrying a limit makes it worse. An **empty** response is not a schema violation for this
  purpose: it is what a harness killed at the deadline or interrupted by a refused tool produces,
  and routing those into a second ask is precisely what this requirement forbids.
- **FR-073**: Both attempts MUST be charged, because both were spent (FR-031).
- **FR-074**: The wall-clock bound of FR-066 MUST cover the whole review rather than each attempt.
  A retry consumes the remainder. A per-attempt bound would silently double the fifteen minutes an
  operator schedules around, and once the bound has expired there is no remainder to ask into, so
  no further attempt is made.
- **FR-075**: A retry MUST be recorded (`model.schema_retry`). An operator watching that rate climb
  is watching the transport's disclosed weakness get worse, and it is the only number that says so.

## What this does not do

It narrows the gap between the transports; it does not close it. `api` still makes malformed output
impossible, and `agent-sdk` still fails closed when two asks both miss — a review that cannot
produce a verdict still produces none, and still fails the gate (FR-007).

The predicate keys on the parser's message rather than on a new error subclass, because
`parseReviewResponse` is shared with the API transport and giving it a new error type would change
that path too. Miscategorising fails in the safe direction: an unrecognised failure is asked once
more and then reported exactly as it would have been.

## Success criteria

- **SC-012**: A review whose first reply misses the schema completes on the second ask.
- **SC-013**: Both attempts are charged to the ledger.
- **SC-014**: A test fails if any of the four named non-schema causes is retried.
- **SC-015**: Two attempts share one wall-clock bound, and a test fails if a retry is granted a
  fresh one.
