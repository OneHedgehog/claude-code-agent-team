# Feature Specification: A Subscription-Backed Model Transport

**Feature Branch**: `agent-sdk-transport`

**Created**: 2026-09-05

**Status**: Approved with two recorded waivers

**Input**: The reviewer had one route to the model and it was metered. When the credits behind it
ran out, the gate stopped and `main` closed behind a reviewer that could not run — including to the
change that would fix it. This adds a second route that does not depend on a metered balance, and
records the two constitutional waivers that permitting it required.

## Why this is a spec

Two reasons, both raised by the service against the pull request that implements this.

A new operating setting, a second transport, and a deliberately weakened response contract are new
requirements rather than restatements of FR-029 or FR-032. Principle I requires every change to
trace to a spec; without this file a future reader of FR-029 finds no obligation matching the code.

And the change carries two waivers. Principle VI requires a waived finding to have "a recorded,
human-approved reason", and Principle IX puts that record in `specs/`, which is never rewritten,
rather than in `docs/`, which is rewritten whenever operations change.

## Requirements

- **FR-055**: The service MUST support more than one transport to the model, selected by the
  `modelTransport` operating setting, and MUST report the effective value with each run (FR-054).
- **FR-056**: `api` MUST remain the default. Selecting a transport changes which account is billed
  and how strongly the response contract is enforced; neither may change without an operator saying
  so.
- **FR-057**: Both transports MUST share one prompt builder and one response parser, so the
  injection guard (FR-036) and the response contract cannot drift between them.
- **FR-058**: The `agent-sdk` transport MUST run with no tools and no inherited settings. Reviewed
  content is untrusted data (Principle V); a reviewer able to read files or run commands is no
  longer treating it as such, and one inheriting the operator's own instructions reviews the same
  revision differently on two machines (Principle VII).
- **FR-059**: A response that does not satisfy the schema MUST become a missing verdict and a failed
  gate on either transport (FR-007). The `agent-sdk` transport asks for the schema in the prompt
  rather than constraining generation, so validation is the only enforcement it has.

## Waiver 1 — a dependency that is not permissively licensed

The constitution requires that "every third-party dependency MUST be justified in the plan and MUST
be permissively licensed". `@anthropic-ai/claude-agent-sdk` is published under
`© Anthropic PBC. All rights reserved.`, which is not a permissive identifier.

**Justification.** The dependency is the vendor's own client for the product the operator already
subscribes to; it is the supported route to that entitlement, and no permissively licensed
substitute reaches it. The alternative is not a different library, it is having no
subscription-backed transport at all.

**Approved by** [@OneHedgehog](https://github.com/OneHedgehog) on 2026-09-05, in the exchange that
directed this change: *"@anthropic-ai/claude-agent-sdk is fine."*

**Scope.** This waiver names one dependency for one purpose. It does not relax the licensing rule
for anything else, and a second proprietary dependency needs its own record.

## Waiver 2 — substituting a transport after a metered resource was exhausted

Principle IV states that exhaustion "MUST NOT be resolved by spending money, and MUST NOT be
resolved by weakening the system", and that an agent "MUST NOT substitute a degraded gate for an
unavailable one".

The service raised this as `critical` against its own author, correctly: the API credits ran out,
and the response contract on the new transport is weaker — malformed output moves from *impossible*
under `output_config.format` to *rejected* by the parser.

**Justification, as given by the operator.** The switch moves the reviewer onto an entitlement that
already exists rather than buying more of an exhausted one, so it resolves the outage by neither of
the two routes the principle forbids. The weakening is bounded and recorded: validation is
unchanged, a malformed answer still fails the gate, and `api` remains the default so no other
operator inherits the weaker contract.

**Approved by** [@OneHedgehog](https://github.com/OneHedgehog) on 2026-09-05: *"since we are
switching to existing license"*.

**What it does not license.** It does not permit an agent to make this substitution on its own.
Principle IV reserves the decision for a human, and the service was right to stop and escalate
rather than proceed — that behaviour is the reason this record exists rather than a silent
downgrade.

## Success criteria

- **SC-001**: With `modelTransport` unset, the service behaves exactly as before — same transport,
  same billing, same contract.
- **SC-002**: On `agent-sdk`, a review completes with no model credential resolvable from the
  environment, the keychain, or an OAuth profile.
- **SC-003**: A response that violates the schema fails the gate on both transports.
- **SC-004**: The `agent-sdk` transport grants no tools and inherits no settings, and a test fails
  if either changes.
