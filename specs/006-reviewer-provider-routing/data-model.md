# Data Model: Routing Each Reviewer Role To Its Own Provider

**Feature**: 006-reviewer-provider-routing | **Date**: 2026-09-20

The spec's Key entities are *Provider*, *Route* and *Failure class*. **Account** is added here,
because FR-081 places budgets and reserves on the funding account rather than on the provider and
that thing needs a name. Each entity is below with the fields it carries, the rules that validate
it, and where it is enforced. Two existing shapes change — `LedgerEntry` and the settings limits —
and those are recorded as migrations rather than as new entities.

---

## Provider

A named way of reaching **one model family**, carrying its funding source, its credential
requirement, and its containment declaration. Distinct from a *transport*, which is how a provider
is reached.

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | Unique within the settings file. The label routes refer to and records name. |
| `models` | `Record<ModelEffort, string>` | The exact model identifier per effort level, **partial and required to be non-empty**. Not a single string: R-020 expresses effort through the pinned identifier rather than `--effort`, so one provider needs one model *per effort it serves*. **Never defaulted** — R-021: Antigravity's catalogue includes `claude-sonnet-4-6` and `claude-opus-4-6-thinking`, so an unpinned model can silently become the authoring family. |
| `family` | `string` | The model family `model` resolves to. **Required** — the FR-082 check compares families, not vendor labels, because an aggregator can serve the authoring family under another vendor's name. |
| `transport` | `"api" \| "agent-sdk" \| "cli"` | How the family is reached. `cli` is new and covers Antigravity. |
| `funding` | `"metered" \| "subscription"` | Recorded so Principle IV's no-new-metered-spend assumption is checkable rather than asserted. |
| `account` | `string` | Which funding account this provider draws on. Two providers sharing one account are independent in judgement and **not** in capacity (R-029), and SC-001 is not met by such a pair. |
| `credential` | `CredentialRequirement` | What preflight must find. Carries a `source` and, for `oauth-profile`, no key — the distinction CLAUDE.md already draws. |
| `containment` | `ContainmentDeclaration` | Required. FR-083: a provider MUST NOT be addable without stating how it satisfies each obligation. |

### Validation rules

- `name` unique; `family` non-empty; `account` names a declared account.
- **`models` non-empty.** An absent or empty map is a preflight failure, not a fall-through to the
  vendor's default. A default can change between vendor releases, and a family nobody pinned is a
  family the FR-082 check never saw (R-021).
- **`family` agrees with every entry in `models`.** A declaration claiming `family: gemini` while
  pinning `claude-sonnet-4-6` at any effort level is a declaration error — otherwise the
  independence check reads a label the invocation contradicts.
- **The configured `modelEffort` has an entry in `models`, for every provider on every route.**
  Absent, it is a preflight failure rather than a silent downgrade to whichever model the provider
  does carry. This is FR-060's obligation, not hygiene: `modelEffort` is reported as effective with
  each run (FR-054), and spec 003 established that "a transport that reports a value it does not
  apply defeats that requirement more thoroughly than not reporting it". A provider pinning one
  model while the record claims a different effort is exactly that failure.

  **The gap is live, not hypothetical.** `modelEffort` admits `low|medium|high|xhigh|max`; the
  catalogue read on 2026-09-20 offers `gemini-3.1-pro` at **high and low only** — no medium, no
  xhigh, no max. The shipped default is `high`, so the default configuration validates; `medium`
  and above do not, on Pro. An operator raising effort must either pin a family that offers it
  (`gemini-3.8-flash` carries medium) or be stopped at preflight. Being stopped is the correct
  outcome and the reason this rule is written down.
- When two providers in one role's route share an `account`, preflight records it and the run
  record reports it. It is permitted and it does **not** count toward SC-001 (R-029).
- `containment` must state all six FR-058/FR-063 obligations: no tools, no inherited settings, no
  access to the orchestrator's working tree, an allowlisted environment, an empty working
  directory, and neutralisation of every other provider's credential. A declaration missing any is
  a schema error, not a warning.

### `ContainmentDeclaration`, as Antigravity discharges it

The provider is Antigravity, invoked as `agy` (R-020 — **not** the deprecated `gemini` CLI).

| Obligation | Mechanism |
|---|---|
| No tools | `--mode plan`, the read-only mode. `--dangerously-skip-permissions` MUST NOT be passed, and no MCP server is configured for the child |
| No inherited settings | a private state directory per attempt, passed explicitly; the operator's `~/.gemini/antigravity-cli/` is never the child's (R-028) |
| No access to the working tree | `--add-dir` is simply not passed — an unopened workspace is the closed default |
| Allowlisted environment | explicit env, not `process.env` |
| Empty working directory | created per attempt, removed with it, together with the state directory and `--log-file` |
| Other credentials neutralised | `ANTHROPIC_*`, `CURSOR_API_KEY` and peers unset in the child |
| Vendor-side restriction | `--sandbox` is passed — terminal restrictions cost read-only review nothing, and a containment the vendor enforces is structural rather than a matter of our own compliance (Principle V) |

Two further obligations exist because `agy` runs a language server rather than behaving as a filter
(R-028), and FR-083 requires them stated rather than discovered:

| Surface | Declaration |
|---|---|
| **Loopback listener** | The child binds a localhost port for the duration of the attempt. Not egress, and therefore not a Principle V matter — but it is a host surface, and it is named here rather than left silent |
| **Local state written** | Logs, crash reports, conversations and `conversation_summaries.db`. All land in the per-attempt directory, so a reviewed diff's summary never reaches the operator's own history |

Response shape is additionally constrained at the provider by `--json-schema`, which the incumbent
`agent-sdk` transport has no equivalent for. The parser remains the authority (FR-077 permits no
second seam); the schema flag reduces how often it has to reject.

---

## Account

A funding source that gets billed or throttled. **This is where budgets live** (FR-081): one
account can serve several providers, and when it does they draw on one metered resource.

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | Unique. Providers reference it by this name. |
| `budget` | `number` | The account's ceiling. Supersedes the global `tokenBudget`. |
| `reserve` | `number` | `review` remains the only actor permitted to draw into it. |

### Validation rules

- `reserve < budget`. Joins the cross-field invariants enforced in code immediately after schema
  validation, alongside the ones [settings.schema.json](../../schemas/settings.schema.json) already
  documents in its `$comment`.
- Every account is referenced by at least one provider; every provider's `account` exists.

**Why not on the provider.** Budgeting per provider would let two providers on one account carry
two independent budgets whose sum exceeds what the account holds — each passing its own reserve
check while the shared quota was exhausted. That is the concealment FR-081 exists to prevent,
reintroduced one level up, and Principle IV requires the budget to sit on the thing that can
actually run out. Attribution stays at the provider (SC-002, SC-003, Principle VII); only the limit
moves.

---

## Route

An ordered, non-empty list of providers belonging to **one reviewer role**.

| Field | Type | Notes |
|---|---|---|
| `role` | `RoleName` | One of `requiredReviewerRoles`. |
| `providers` | `readonly string[]` | Provider names, in the order they are asked. |

### Validation rules

All are **preflight** failures — before any model call, per FR-084.

| Rule | Source | Reason |
|---|---|---|
| Non-empty | FR-076, edge cases | An empty route is a declaration error, "never an implicit fallback to some default provider". |
| Every named provider is declared | FR-084 | A route naming an unconfigured provider fails before spend. |
| Every provider's credential is present | FR-084 | Holds for a last-resort entry as much as a first: "a fallback that has never been verified is not a fallback". |
| No provider appears twice | edge cases | The second entry buys nothing — a capacity failure will not have cleared. |
| No provider's `family` equals the authoring provider's `family` | FR-082, R-021 | Unless an override with a recorded reason is present in settings. |
| `providers.length × 300s ≤ maxQueueWaitSeconds` | FR-086, R-026 | At the shipped default of 1800, the longest route is **6**. |
| Every role in `requiredReviewerRoles` has a route | edge cases | A role with no route is a declaration error. |

### Migration (FR-076, FR-081, SC-005)

A settings file predating this feature declares `modelTransport` and one budget and no routes. It
is read as the single-provider, single-account configuration it describes: one synthesised account
carrying the former `tokenBudget` and `reviewerTokenReserve`, one synthesised provider drawing on
it with that transport, and a single-entry route for every required role. No operator action, and
the run record reports the same effective behaviour it reported before.

`modelTransport` is retained as a **deprecated alias** read only by this migration. Declaring it
alongside `providers` is a declaration error at preflight — two descriptions of how a model is
reached is one more than can be true.

---

## Failure class

`capacity` or `contract`. Determines whether a route advances, and is recorded with the attempt.

| Class | Covers | Route advances |
|---|---|---|
| `capacity` | session limit, rate limit, exhausted credit, provider unreachable, attempt deadline | **yes** |
| `contract` | response misses the schema (FR-059), tool refused (FR-064), verdict absent (FR-007) | **no** |

The discriminator across a subprocess boundary is whether a parseable response arrived at all
(R-022). The two MUST remain distinguishable in the record and MUST NOT be merged into a generic
call failure.

---

## Attempt

One provider's turn within a role's route. Not named as an entity in the spec, but it is what the
record needs in order to satisfy FR-079 and SC-002.

| Field | Type | Notes |
|---|---|---|
| `provider` | `string` | Which provider was asked. |
| `index` | `number` | Position in the route. Distinct from `round`, which means the review round — FR-075's existing distinction. |
| `outcome` | `"verdict" \| FailureClass` | Exactly one attempt per role per revision ends in `verdict`. |
| `usage` | `ModelUsage` | Charged even on failure, at no less than the prompt sent (FR-067). |

### State transitions

```text
                  ┌─────────── capacity ──────────┐
                  │                               ▼
  [route start] ──┴─▶ attempt(i) ──┬── verdict ──▶ [role concluded, provider named]
                                   │
                                   ├── contract ──▶ [revision fails, stated reason]
                                   │
                                   └── capacity, i = last ──▶ [gate fails closed,
                                                               every provider and its
                                                               class named]
```

Invariants across all paths:

- **Exactly one verdict per role per revision, from exactly one provider** (FR-079). Failover never
  changes the count.
- A role that has begun with one provider **finishes with it or fails** — no mid-round substitution.
- An exhausted route never resolves by enabling billing, raising a limit, or dropping a required
  role (FR-080, Principle IV). The system degrades to stopped.
- A successful role's verdict does **not** carry the gate when another role's route is exhausted.

---

## Changed existing shapes

### `LedgerEntry` (R-024)

Gains a required `provider: string` **and a required `account: string`**. Entries already on disk
without them are attributed to the single provider and account named by the migrated settings — the
only reading consistent with what the operator actually spent.

Two fields, because the levels differ: `provider` is what the draw is attributed to, `account` is
what the reserve is checked against. An entry carrying only a provider cannot be checked against
any reserve once one account serves several providers.

### `Limits` (FR-081)

`tokenBudget` / `reviewerTokenReserve` are replaced by a **per-account** map. `platformApiBudget`
and `platformApiReserve` are **unchanged**: GitHub API requests come from one account and remain
one resource — which is the same principle this change applies to model tokens, arrived at from the
other direction.

The budget check resolves the account behind the provider being charged, then compares against that
account's reserve. Reporting resolves both: remaining budget per account, spend per provider
(SC-003).
