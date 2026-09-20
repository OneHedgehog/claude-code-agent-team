# Contract: `ModelClient` under routing — the delta

**Feature**: 006-reviewer-provider-routing | **Date**: 2026-09-20

This is a **delta** to
[001's `ModelClient` contract](../../001-independent-review-service/contracts/model-client.md),
which remains in force. Nothing here removes an obligation from it. FR-077 requires that adding a
provider introduce no second seam: one prompt builder and one response parser continue to serve
every provider, so the injection guard (FR-036) and the response contract cannot drift between
routes.

## What does not change

`review(request: ReviewRequest): Promise<ReviewResponse>` remains the single substitutable
boundary. Every field of `ReviewRequest` remains untrusted data. A client that cannot produce a
verdict still rejects rather than degrading into an approval (FR-007).

## Additions

### `FailureClass`

```ts
/** Whether a failure says anything about the reviewed revision (FR-078). */
export type FailureClass = "capacity" | "contract";
```

`capacity` says nothing about the revision — the next provider MAY be asked. `contract` is a
statement about this run or this content — it fails the revision exactly as it does today, and no
further provider is asked.

### `ModelError` carries its class

```ts
export class ModelError extends Error {
  override readonly name = "ModelError";
  readonly usage: ModelUsage;
  /** Required. An unclassified failure cannot be routed on (FR-078). */
  readonly failureClass: FailureClass;
  /** The provider that failed. Named in the record, never inferred (FR-079). */
  readonly provider: string;
}
```

**Classification is the implementation's obligation, not the router's.** Only the client that made
the call knows whether a response arrived. A router that guessed from an error message would be
reintroducing the generic call failure FR-078 forbids.

Implementations classify per R-022: a subprocess that fails to spawn, exits without output, cannot
reach its endpoint, or exceeds the attempt bound is `capacity`; a response that arrives and misses
the schema, refuses a tool, or carries no verdict is `contract`.

### `ReviewResponse` names its author

```ts
export interface ReviewResponse {
  readonly findings: readonly FindingDraft[];
  readonly verdict: "approve" | "request-changes";
  readonly replyJudgements: readonly ReplyJudgement[];
  readonly usage: ModelUsage;
  /** Required. Which provider produced this verdict (FR-079). */
  readonly provider: string;
}
```

A verdict whose author is unrecorded cannot be weighed later against that provider's track record
(Principle VII). This reaches the check-run output, not only the run record (R-025).

### `RoutingModelClient`

```ts
export class RoutingModelClient implements ModelClient {
  constructor(routes: Readonly<Record<RoleName, readonly ModelClient[]>>);
  review(request: ReviewRequest): Promise<ReviewResponse>;
}
```

It is itself a `ModelClient`, so nothing above the model boundary changes.

**Obligations**:

1. Select the route by `request.role`. A role with no route is unreachable here — preflight
   rejected it (FR-084).
2. Ask providers in order. Advance **only** on `ModelError` with `failureClass === "capacity"`.
3. Rethrow a `contract` failure immediately, without asking a further provider.
4. Return the first `ReviewResponse` received, with `provider` set. **Exactly one verdict per role
   per revision, from exactly one provider** (FR-079) — failover never changes the count.
5. Bound each attempt separately at 300 s (FR-086). An expiry is a `capacity` failure and advances
   the route. The expired attempt is **cancelled rather than abandoned**, and its spend is charged
   at no less than the prompt it sent (FR-067).
6. On exhaustion, throw a `RouteExhaustedError` whose message names **every** provider tried and
   its failure class, and whose `usage` is the sum of all attempts (FR-080).
7. Accumulate usage across attempts and attribute each attempt's draw to the provider that incurred
   it (FR-081). A failed attempt still spent.

```ts
export class RouteExhaustedError extends ModelError {
  readonly attempts: readonly {
    readonly provider: string;
    readonly failureClass: FailureClass;
    readonly usage: ModelUsage;
  }[];
}
```

**The router MUST NOT**: invent a provider absent from the route, raise a limit, drop a required
role, retry a `contract` failure elsewhere, or substitute a provider mid-attempt. Principle IV
applies unchanged — the system degrades to stopped.

## The testing boundary (FR-085, R-023)

The e2e layer substitutes **the leaves, not the router**. Scripted clients stand in for individual
providers; the routing logic under test is the real one. Principle II permits exactly one
substitution, at the model boundary, and the thing substituted must not be the thing being tested —
otherwise failover would only be demonstrable by exhausting a real vendor's quota, which is a path
that will not be tested.

`ScriptedModelClient` therefore extends to script a `FailureClass` per call, so scenarios 1–3 and 8
of the spec run with no real quota involved.

## Provider-specific: the `cli` transport

A `cli` provider spawns a vendor binary and parses its JSON output. It discharges FR-083 at the
spawn, not in the dependency tree: explicit environment rather than `process.env`, an empty working
directory, no tool access, and every other provider's credential unset in the child. The first such
provider is Antigravity, invoked as `agy` (R-020); its exact flags are in
[data-model.md](../data-model.md#containmentdeclaration-as-antigravity-discharges-it).
