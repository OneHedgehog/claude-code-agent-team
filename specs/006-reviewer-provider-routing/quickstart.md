# Quickstart: Reviewer Provider Routing

**Feature**: 006-reviewer-provider-routing | **Date**: 2026-09-20

How to configure routes and prove failover works. Scenario numbering continues
[001's quickstart](../001-independent-review-service/quickstart.md), which ends at 29. Nothing here
duplicates [data-model.md](data-model.md) or [contracts/](contracts/).

---

## Prerequisites

Everything 001 requires, unchanged, plus:

1. **The authoring provider named in settings.** On this repository it is Claude Code. FR-082
   binds from the first run; an independence rule that infers the author cannot be validated at
   preflight.
2. **A credential for every provider in every declared route**, verified at preflight before any
   spend (FR-084) — including last-resort entries.
3. **For the Antigravity provider**: an authenticated OAuth token. The binary is `agy` — **not** the
   deprecated `gemini` CLI, which is still installed on this host and still answers (R-020). Check
   without spending anything:

   ```bash
   test -s ~/.gemini/antigravity-cli/antigravity-oauth-token && echo "token present"
   ```

   `GEMINI_API_KEY` and `GOOGLE_API_KEY` must stay **unset** — the OAuth token is the funding path
   (R-020), and an environment key would shadow it the same way `ANTHROPIC_API_KEY` shadows the
   Anthropic profile.

Read the model catalogue before pinning `--model`. **This is not optional**: the catalogue serves
`claude-sonnet-4-6` and `claude-opus-4-6-thinking` alongside the Gemini and GPT-OSS entries, so an
unpinned model can put a required reviewer role on the authoring family while the vendor label
still reads `antigravity` (R-021). Preflight rejects an unpinned one.

```bash
agy models
```

Pin a Gemini or GPT-OSS entry, and note that **effort lives in the model identifier** —
`gemini-3.1-pro-high` and `gemini-3.1-pro-low` are separate entries, and `--effort` is deliberately
not passed (R-020).

Then confirm it is driveable headless before wiring it into a route:

```bash
agy --print "reply with the single word: ready" --output-format json --mode plan
```

Both commands need a writable state directory and a loopback port, so they will not run inside a
restrictive sandbox (R-028). That is a property of the provider, not a fault.

## Setup

Build as usual:

```bash
npm ci && npm run build
```

## Configuring a route

Routes live in the operating settings beside `requiredReviewerRoles`. The shape is in
[data-model.md](data-model.md); the rules preflight enforces are the table in the same file.

Three things are declared, not one: **accounts** carry the budgets and reserves, **providers**
name a vendor, a pinned model and the account they draw on, and **routes** order providers per
role. The split matters — one account can serve several providers, and budgeting the provider
instead of the account would let two of them pass independent reserve checks while their shared
quota was gone (FR-081).

A file that declares **no** routes keeps working unchanged as the single-entry route it already
describes (FR-076, SC-005). Migration is automatic and needs no operator action: the former
`tokenBudget` and `reviewerTokenReserve` become that one **account's** own, and the synthesised provider draws on it.

## Run a review on a route

Unchanged from 001 — the target is always explicit, and there is no working-directory fallback:

```bash
node dist/cli.js --target owner/name --checkout /path/to/checkout --pull-request 42
```

The run record now names the provider that produced each verdict, and each failed attempt with its
failure class.

## Test suites

The gate CI, which must pass before anything else:

```bash
npm run check
```

The end-to-end suite. Routing and failover run here against **scripted providers at the leaves**,
so no path in this suite requires a real vendor's quota (FR-085, R-023):

```bash
npm run test:e2e
```

## Validation scenarios

Each drives the real flow with scripted clients substituted for individual providers and the
routing composite left real. Assertions cover which provider was asked, what the record named, and
how the gate concluded — never generated wording (FR-030).

| # | Scenario | Expected | Covers |
|---|---|---|---|
| 30 | Route `[A, B]`; **A** refuses with a session limit | **B** is asked; one verdict; record names **B** as author and **A** as a `capacity` failure | Spec 1 · SC-001 |
| 31 | Route `[A, B]`; **A** returns a response missing the review schema | **B** is NOT asked; missing verdict; gate fails with the schema violation as its stated reason | Spec 2 · SC-004 |
| 32 | Every provider in the route returns a capacity failure | Gate fails closed; reason names each provider and its class; no provider invented, no limit raised, no required role dropped | Spec 3 · FR-080 |
| 33 | Settings declaring only `modelTransport`, no routes | Runs exactly as before; run record reports the same effective behaviour | Spec 4 · SC-005 |
| 34 | Route names a provider whose credential is absent | Preflight fails before any model call, naming the provider and the missing credential; zero tokens spent | Spec 5 · FR-084 |
| 35 | One role ran on **A**, the other on **B** | Each provider's draw is readable separately; neither appears only inside a combined total | Spec 6 · SC-003 |
| 36 | Settings name the authoring provider, and a route places it under a required role | Preflight fails naming the violation | Spec 7 · SC-007 |
| 37 | Same as 36, with an override carrying a recorded reason | Preflight passes; the override and its reason appear in the run record | Spec 7 · FR-082 |
| 38 | Route `[A, B]`; **A** still running at the 300 s bound | **A** is cancelled rather than abandoned; its spend is charged at no less than the prompt it sent; **B** is asked | Spec 8 · FR-067 · FR-086 |
| 39 | A route whose attempts at 300 s each could outlast `maxQueueWaitSeconds` | Preflight fails before any review starts | Spec 9 · R-026 |
| 40 | A route listing the same provider twice | Declaration error at preflight, not honoured | Edge cases |
| 41 | An empty route, or a required role with no route | Declaration error at preflight; never an implicit fallback to a default provider | Edge cases |
| 42 | A credential that expires between preflight and the model call | Treated as a `capacity` failure; the route advances | Edge cases |
| 43 | One role's route exhausts while the other role already produced a verdict | Run still fails closed; the successful role's verdict does not carry the gate | Edge cases |
| 44 | A route naming an aggregator configured to serve the **authoring** model family | Preflight fails — the FR-082 check compares families, not vendor labels | R-021 |
| 45 | A ledger written before this feature, with entries carrying no `provider` or `account` | Read as the migrated provider's spend against the migrated account; totals unchanged | R-024 |
| 46 | A provider declaration with an empty `models` map, or a `family` that disagrees with a pinned model | Preflight fails; no fall-through to the vendor's default | R-021 |
| 46b | A provider whose `models` map has no entry for the configured `modelEffort` — e.g. `medium` against a Pro declaration offering only high and low | Preflight fails, naming the effort and the provider; never a silent downgrade to the model that is present | FR-060, R-020 |
| 47 | A route whose two providers share one `account` | Permitted and recorded; both draw on that account's single budget and reserve, the run record reports the route as independent but not quota-resilient, and SC-001 is **not** claimed | R-029 · FR-081 |
| 48 | A settings file declaring both `modelTransport` and `providers` | Preflight fails; the alias is retained for migration only | FR-076 |
| 49 | Two providers on one account, whose combined draw crosses that account's reserve | The second is refused at the reserve, not permitted because its own provider looks unspent | FR-081 · Principle IV |

Scenario 44 is the one that looks redundant beside 36 and is not: it is the case where a vendor
label passes an independence check while the model family behind it does not. Scenario 46 is the
same hazard one step earlier — a declaration that never names a family at all.

Scenario 47 asserts a *report*, not a refusal. Two families behind one account is a genuinely
useful configuration for independence and a useless one for availability, and the record has to say
so rather than let the settings file imply resilience it does not have.

## Establishing the new provider's review quality (R-027)

Before Antigravity carries a required role on the target, replay pull requests whose findings are
already on record and compare. `#9` is the richest source — nine rounds, with two that produced no
verdict at all.

This is a measurement read by a human, not a gate. It is deliberately outside CI: an eval wired
into the merge path is a flaky gate, and a flaky gate gets disabled within a week (Principle II).

**The promotion bar**: the provider must surface **every recorded blocking finding** in the
replayed rounds — a single miss blocks promotion — and its additional findings must be judged
defensible rather than noise by a human, whose decision and reasoning are recorded. What it cannot establish is stated in
[research.md](research.md#r-027): a provider that replays well has been shown not to be obviously
worse, not to be equivalent — and "a well-formed response of no substance" is not detectable by
this method or any other in scope.

## Reading a run afterwards

Per-provider spend and each attempt's failure class are in the check-run output, not only the local
log (FR-079, R-025) — so `reconstruct.ts` rebuilds the same per-provider totals from GitHub alone,
and anyone reading the pull request can see which provider produced the verdict.
