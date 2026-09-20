# Phase 0 Research: Routing Each Reviewer Role To Its Own Provider

**Feature**: 006-reviewer-provider-routing | **Date**: 2026-09-20

Continues the numbering established by
[001's research](../001-independent-review-service/research.md), which ends at R-019.

The spec left two things explicitly to planning: which provider ships first, and how that
provider's review quality is established before it becomes the gate. Both are settled below. The
rest are decisions the spec constrains without naming a mechanism, or gaps the spec's own wording
opens once a second provider is real.

---

## R-020: The first additional provider is Antigravity, invoked as `agy`

**Decision**: Google's Antigravity, invoked as `agy --print <prompt> --output-format json --mode
plan`, headless.

**Not the `gemini` CLI.** That name and service are deprecated; Antigravity supersedes them, and
the binary is `agy` (`~/.local/bin/agy`, a Mach-O arm64 executable). The `gemini` binary is still
on this host and still answers `--help`, which is exactly how a deprecated tool gets written into a
spec by someone reading the older surface. Recorded here so the wrong one is not reintroduced
later. The spec's own Assumptions already named "Google Gemini — via Antigravity or a command-line
interface"; this settles that either/or in favour of Antigravity.

**Rationale**: The spec's Assumptions make the gating test explicit — "A product with no
non-interactive interface a daemon can drive cannot be a provider" — and set two further
constraints: no new metered spend, and containment discharged per FR-083. `agy` satisfies all
three, verified by reading its interface rather than by assuming it:

| Requirement | Surface |
|---|---|
| Non-interactive | `-p, --print` (`--prompt` is an alias) — "Run a single prompt non-interactively and print the response" |
| Parseable response (FR-059) | `--output-format` with `text`, `json`, `stream-json` |
| **Schema enforced at the provider** | `--json-schema` — "enforce structured output", taking a schema string or file |
| **Per-attempt bound (FR-086)** | `--print-timeout` — a time limit for print mode; `0` waits until the turn completes |
| **Effort** | `--effort low\|medium\|high`, **and** effort baked into model ids (`…-high`, `…-low`). Two ways to say it; the pinned model wins — see below |
| No tools (FR-058, FR-083) | `--mode plan` (the read-only mode; the alternative is `accept-edits`). `--dangerously-skip-permissions` exists and MUST NOT be passed |
| Workspace scope | `--add-dir` is the only way a directory enters the workspace — omitting it is the closed default |
| Sandbox | `--sandbox` — "terminal restrictions enabled". **Passed** — see below |
| Funding (Principle IV) | OAuth — `~/.gemini/antigravity-cli/antigravity-oauth-token`, with `GEMINI_API_KEY` and `GOOGLE_API_KEY` both unset |

Three of these are better than the transport this repository has today, and change what the
provider is worth:

- **`--json-schema` moves contract enforcement to the provider.** The `agent-sdk` transport
  "constrains the response by instruction rather than by schema, so the parser is the only thing
  enforcing the contract" — [settings.schema.json](../../schemas/settings.schema.json) says so in
  its own description, and spec 004's retry exists because of it. Antigravity can be handed the
  review schema directly. The parser remains the authority (FR-077 permits no second seam), but a
  contract failure becomes markedly less likely on this route than on the incumbent one.
- **`--print-timeout` lets FR-086's bound be enforced at both ends** — by the router's own
  cancellation and by the provider itself.
- **`--effort` gives `ReviewRequest.effort` somewhere to land**, where a CLI transport previously
  had no mapping for it — **but the mapping is not one-to-one, and this needs deciding rather than
  assuming.** The catalogue bakes effort into the model identifier: `gemini-3.1-pro-high` and
  `gemini-3.1-pro-low` are separate entries, and `gemini-3.1-pro` alone is not offered. So effort
  is expressible twice, once in the pinned `--model` and once in `--effort`, and which wins is
  undocumented. **Decision**: express effort through the pinned model identifier only, and do not
  pass `--effort`. A provider declaration therefore pins one model per effort level it supports,
  and a request for an effort the declaration has no model for is a declaration error at preflight
  rather than a silent downgrade. Passing both and hoping they agree is the failure mode this
  avoids.

The funding shape matches what CLAUDE.md already documents for Anthropic: an OAuth token on disk
rather than a static key, nothing in the environment, nothing new to pay for. FR-084 must verify it
at preflight, and a token on disk is checkable without spending anything.

**`--sandbox` is passed.** A review is read-only work, so terminal restrictions cost it nothing,
and R-028 establishes that this child is heavier than a filter — it writes state and binds a port.
Principle V requires containment to be structural rather than a matter of the agent's compliance,
and a flag the vendor provides is structure available for free. It layers over the per-attempt
state directory rather than replacing it: neither alone covers what the other does.

**Alternatives considered**:

- **Cursor (`cursor-agent`)** — also viable, and kept as the *second* provider (SC-001 needs two).
  It has `-p, --print`, `--output-format json`, and `--mode ask|plan` for read-only. It is not
  first because it lacks the schema enforcement `--json-schema` gives, and because `-p` by default
  "has access to all tools, including write and shell", so its containment rests entirely on
  getting `--mode` right. Antigravity's default workspace is empty until `--add-dir` opens it,
  which is the same guarantee stated as a closed default rather than an opt-out.
- **The deprecated `gemini` CLI** — rejected. It is still installed and still answers, which is the
  hazard rather than an argument for it. Building a provider on a superseded surface buys a
  migration nobody asked for.
- **OpenClaw** — present on this host with a working non-interactive surface, and rejected as a
  *provider* because it is a gateway: it routes to a model family rather than being one. Its
  current session runs `claude-opus-4-8` via `modelProvider: anthropic`, which is the authoring
  family and therefore excluded by FR-082. It remains a candidate *transport* to a future provider,
  and a candidate escalation channel, which is a different feature.
- **A metered Gemini API key** — rejected by the spec's own Assumptions. The subscription/free-tier
  path exists and works; adding a billable credential to reach the same model family would be
  Principle IV spend for no capability.

---

## R-021: A provider is a vendor **and** a model family, never a vendor alone

**Decision**: A provider declaration carries both the vendor it is reached through and the model
family it resolves to. FR-082's independence check compares **families**, not vendor labels.

**Rationale**: This is the gap a second provider opens, and it is not theoretical. `cursor-agent
--model` accepts `gpt-5` and `claude-opus-4-8` alike — its own help text uses
`claude-opus-4-8[context=1m,effort=high,fast=false]` as the example. A route that declared `cursor`
under a required reviewer role, with the model left to a default or set to a Claude model, would
pass an independence check that compares vendor strings while the reviewer ran on precisely the
family that wrote the diff. FR-082 would be satisfied in name and violated in substance, and
Principle VI's whole point is that independence is structural rather than conventional.

The same trap exists for any aggregator, which is what makes this a rule rather than a note about
one product — **including the provider this feature ships first**. `agy` carries its own `--model`
flag and an `agy models` subcommand, so Antigravity is an aggregator too — and its catalogue does
include a Claude family, which the next paragraph settles. The check must compare the family a
route resolves to, never the vendor it is reached through. R-021 is therefore load-bearing for
provider #1, not a guard against a hypothetical second one.

**Settled, and not comfortably.** The catalogue was read on 2026-09-20 and Antigravity serves
**three families**:

| Family | Models offered |
|---|---|
| Gemini | `gemini-3.8-flash-{high,medium,low}`, `gemini-3.7-flash-*`, `gemini-3.6-flash-*`, `gemini-3.1-pro-{high,low}` |
| **Claude** | `claude-sonnet-4-6`, `claude-opus-4-6-thinking` |
| GPT-OSS | `gpt-oss-120b-medium` |

So the trap is live for the provider this feature ships first, not for a hypothetical later one. An
Antigravity provider whose `--model` is left to a default — or whose default changes in a later
release — can put a required reviewer role on the **authoring family** while its vendor label reads
`antigravity` and the independence check waves it through.

**Therefore `--model` MUST be pinned in every provider declaration, and preflight MUST reject an
unpinned one.** This is now an FR-082 obligation rather than configuration hygiene: an unpinned
model is a family nobody checked, and FR-082's own reasoning — "an independence rule that infers
who the author was cannot be validated at preflight" — applies identically to inferring who the
*reviewer* is.

**Alternatives considered**: Checking the vendor alone — rejected above. Inferring the family from
the vendor's default model — rejected because FR-082 requires the authoring provider to be *named
explicitly* for exactly this reason: "an independence rule that infers who the author was cannot be
validated at preflight."

---

## R-022: The capacity/contract line is drawn at "did a response arrive at all"

**Decision**:

| Observation | Class | Route advances? |
|---|---|---|
| Subprocess fails to spawn; exits without output; unreachable endpoint; attempt exceeds the FR-086 bound | **capacity** | yes |
| A response arrives and misses the schema (FR-059), refuses a tool (FR-064), or carries no verdict (FR-007) | **contract** | no |

**Rationale**: FR-078 enumerates capacity as "session limit, rate limit, exhausted credit, provider
unreachable, deadline" and contract as "a statement about this run or this content". Across a
subprocess boundary the honest discriminator between those two lists is whether the provider
managed to say anything at all. A process that never produced a parseable response has told us
nothing about the revision — it is *unreachable* in the sense FR-078 already names. A process that
answered, and answered wrongly, has made a statement, and asking someone else would be shopping for
a verdict.

**What this costs, and it is a real cost.** A genuinely broken provider — one that crashes on every
call — is classified as capacity and burns a failover slot on every role, every round, until an
operator notices. The record names it each time (FR-080), so it is visible rather than silent, but
nothing here auto-disables it. The alternative was worse: classifying an unexplained crash as
*contract* would fail the revision and put the provider's fault on the author's diff, which is a
lie in the authoritative record that FR-079 says the ledger is rebuilt from.

**Alternatives considered**: A third `unclassified` class that fails the role without advancing the
route — rejected because FR-078 says the two classes "MUST be distinguishable in the record, not
merged into a generic call failure", and a third bucket is how a generic call failure gets
reintroduced under a new name. Defaulting unknown failures to contract — rejected for the
misattribution above.

---

## R-023: Routing lives in a composite `ModelClient`, and the substitutable boundary stays the leaf

**Decision**: A `RoutingModelClient implements ModelClient` holds
`Record<RoleName, readonly ProviderClient[]>` and performs per-role failover. It is assembled in
[composition.ts](../../src/composition.ts). The roles, the gate, the ledger and the daemon are
untouched, exactly as in [003](../003-subscription-backed-transport/plan.md).

The part that matters for testing: **the e2e layer substitutes the leaves, not the router.** The
scripted doubles stand in for individual providers; the routing logic under test is the real one.

**Rationale**: FR-085 requires routing and failover to be exercisable end-to-end with scripted
providers alone, and Principle II permits exactly one substitution — the model boundary. If the
router were itself the substituted object, the e2e layer would replace the very logic FR-085 exists
to exercise, and failover would only be demonstrable by exhausting a real vendor's quota. Keeping
the boundary at the leaf satisfies both: one substitution, and the thing being substituted is not
the thing being tested.

**Alternatives considered**: Failover inside [role.ts](../../src/review/roles/role.ts) — rejected,
it lifts routing above the model boundary and puts provider concerns into the role logic that
Principle II keeps deterministic. A second seam beside `ModelClient` — rejected by FR-077, which
requires one prompt builder and one parser precisely so the injection guard cannot drift between
routes.

---

## R-024: Ledger entries carry a provider; pre-feature entries are attributed to the migrated one

**Decision**: `LedgerEntry` gains a required `provider` field **and a required `account` field**.
Entries already on disk without them are attributed to the single provider and account that the
migrated settings file declares.

Two fields rather than one, because FR-081 puts attribution and limits at different levels: the
provider is what the draw is attributed to, the account is what the reserve is checked against. An
entry carrying only a provider cannot be checked against any reserve once one account serves
several providers.

**Rationale**: FR-081 is explicit that "a ledger entry MUST therefore carry its provider; an entry
that does not cannot be checked against any reserve." The migration clause of the same requirement
already fixes the answer for settings — an old file "MUST be read as the single-provider
configuration it describes" — and the ledger is the same file's history. Reading old entries as
belonging to that provider is the only interpretation consistent with what the operator actually
spent.

The JSONL store is a cache whose authority is the check-run output
([tokens.ts](../../src/ledger/tokens.ts) says so, R-010), so a wrong guess here would be
recoverable. It is still worth getting right, because `reconstruct.ts` rebuilding a total that
disagrees with the cache is a confusing failure to diagnose.

**Alternatives considered**: An `unknown` provider bucket — rejected, it creates a budget nobody
declared and a reserve nobody can check against. Discarding pre-feature entries — rejected, it
resets spend at a feature boundary and hands the operator a budget that looks healthier than the
account is.

---

## R-025: Attribution is written into the check-run output, not only the run record

**Decision**: The per-run spend block in the check-run output gains one line per provider used,
naming the provider, its failure class where it failed, and its draw.
[reconstruct.ts](../../src/ledger/reconstruct.ts) parses them.

**Rationale**: FR-079 requires this in as many words — the naming "MUST appear in the check-run
output, not only in a local log" — and gives the reason: that output is the authoritative record
the ledger is rebuilt from, so attribution living only on the host is lost to anyone reading the
pull request and to any later reconstruction. SC-002 then holds against 100% of run records rather
than a sample, which is only checkable if the record is the durable one.

---

## R-026: The FR-086 arithmetic is a preflight invariant, sized against the shipped defaults

**Decision**: Preflight rejects any configuration where
`longest_route_length × 300s > maxQueueWaitSeconds`. With the shipped default of
`maxQueueWaitSeconds: 1800`, the longest permitted route is **6 providers**.

**Rationale**: FR-086 makes the per-attempt bound safe "only because of the arithmetic" and
therefore requires preflight to check it rather than assume it. The numbers confirm the spec's own
worked example: a three-provider route bounds a role at 15 minutes against a 30-minute promise, and
there is room for twice that before the promise breaks. This joins the cross-field invariants
already enforced in code immediately after schema validation, which
[settings.schema.json](../../schemas/settings.schema.json) documents in its `$comment` because JSON
Schema cannot express them.

The bound itself drops from the 900,000 ms constant in
line 59 of [agent-sdk.ts](../../src/model/agent-sdk.ts) to 300,000 ms, applied per attempt.

---

## R-027: Review quality is established by replaying pull requests whose findings are on record

**Decision**: Before Gemini carries a required role on the target, replay the reviewed pull
requests this repository already has verdicts for — #9's nine rounds most of all — through the new
provider offline, and compare its findings against the recorded ones. The comparison is reported
and read by a human; it is not a gate and does not run in CI.

**Rationale**: The spec's Assumptions require planning to say how this is established, and name
this method as "the obvious method and the one this repository can afford". The risk being managed
is stated there too and is not small: moving both required roles off the only provider whose review
output this project has ever seen is a larger change than adding a fallback would have been.

Principle II is why it stays out of CI: an eval wired into the merge path is a flaky gate, and a
flaky gate gets disabled within a week. The replay is a one-off measurement that informs a human
decision about whether to promote the provider, which is exactly the shape Principle II says such
comparisons should take.

**The promotion criterion, stated so the measurement has a consequence.** A provider is permitted
to carry a required reviewer role only if:

1. It surfaces **every recorded blocking finding** in the replayed rounds. A single miss blocks
   promotion — a reviewer that misses a defect the incumbent caught is not a gate, whatever its
   other output looks like.
2. Its **additional** findings are judged defensible rather than noise. This half is a human
   judgement and is recorded as one, with the decision and its reasoning written into `docs/`.

The asymmetry is deliberate. Criterion 1 is mechanical and blocking because a missed blocking
finding is the failure that matters; criterion 2 is human because "noise" cannot be measured
without reading the findings, and a numeric threshold invented here would be a false precision that
later readers would mistake for evidence.

**What this does not establish.** A provider that replays well on nine rounds of one repository's
history has been shown not to be obviously worse. It has not been shown to be equivalent, and the
spec's own edge case — "a well-formed response of no substance" — is not detectable by this method
or any other in scope. Criterion 1 in particular is a floor and not a ceiling: passing it means the
provider missed nothing already known, not that it would catch something new. That is recorded here
so a later disagreement about review quality starts from what was actually measured.

---

## R-028: A `cli` provider gets its own state directory, because `agy` is a server, not a filter

**Decision**: The `cli` transport gives each attempt a private state directory and a private log
path, passed explicitly, and never lets the child inherit the operator's own. Containment is
verified by running the provider with the operator's `~/.gemini` unreadable, not by assuming the
flags are sufficient.

**Rationale**: This was found by running `agy models` under the agent's own sandbox, where it
failed in a way that is more informative than a success would have been:

```text
Failed to redirect output for CLI: creating log file:
  open ~/.gemini/antigravity-cli/log/cli-….log: operation not permitted
Starting language server process with pid …
CLI failed to start - listen tcp 127.0.0.1:0: bind: operation not permitted
```

So `agy` is not a filter that reads a prompt and writes an answer. It **starts a language server**,
**binds a loopback port**, and **writes into `~/.gemini/antigravity-cli/`** — which holds logs,
crash reports, a `conversations` directory and a `conversation_summaries.db`.

Three consequences for FR-058 and FR-063, none of which the flag table alone would have surfaced:

1. **"No inherited settings" is not free.** A child left to its defaults reads and writes the
   operator's own Antigravity state. The reviewed diff is untrusted content, and its summary would
   land in the operator's conversation history.
2. **"An empty working directory" is not sufficient.** The process needs somewhere writable
   regardless; the question is whether that somewhere is per-attempt or shared. It must be
   per-attempt, and removed with the attempt.
3. **A loopback bind is part of the containment surface.** Principle V restricts egress, and a
   local listener is not egress — but it is a port on the host for the duration of the attempt, and
   it belongs in the containment declaration rather than being discovered later.

**What this costs.** The incumbent transports are a library call and an HTTP request. This one is a
subprocess that runs a server, and it is heavier than either. That weight buys the schema
enforcement and the independent model family, and it is recorded here so the comparison is on the
record rather than implied.

**Alternatives considered**: Letting the child use the operator's state directory — rejected on
point 1; it is the same class of mistake as letting a reviewer read the orchestrator's working
tree. Treating the loopback listener as out of scope because it is not egress — rejected: FR-083
requires a provider to state how it satisfies each containment obligation, and silence about a
listening socket is not a statement.

---

## R-029: Two families behind one account is independence without availability

**Decision**: A route MUST NOT count two providers that share a funding account as satisfying
SC-001. Preflight records when a route's providers share an account, and the run record reports it,
so the configuration is not mistaken for quota resilience it does not have.

**This research item changed the spec.** Drafting it surfaced that FR-081 put budgets at the
*provider* while justifying them by the *account* — so two providers on one account would have
carried two budgets whose sum exceeds what the account holds, each passing its own reserve check
while the shared quota was exhausted. That is a Principle IV conflict, not a wording preference,
and it was fixed where it belonged: FR-081 now attaches budgets and reserves to the account and
keeps attribution at the provider (spec Clarifications, session 2026-09-20). What remains here is
the half the spec does not cover — that a same-account pair must not be *reported* as meeting
SC-001.

**Rationale**: The catalogue read in R-021 makes a tempting configuration available. Antigravity
serves Gemini, Claude and GPT-OSS families through **one** OAuth token, so an operator can declare
two providers — say `antigravity/gemini-3.1-pro-high` and `antigravity/gpt-oss-120b-medium` — that
are genuinely different families, neither of them the author's. That configuration satisfies FR-082
twice over and buys real diversity of judgement: two required roles no longer share one family's
blind spots, which is half of what the spec is for.

It buys **nothing** for the other half. Both draw on the same account, so one session limit fails
both, the route exhausts, and the gate closes exactly as it does today. SC-001's measurement — two
of #9's nine rounds recovered — would not improve at all.

The spec keeps these apart and this decision keeps them apart too: FR-082 is about *who is
reviewing*, SC-001 is about *whether the gate can run*. A single vendor can deliver the first and
cannot deliver the second, and a configuration that looks like two providers in the settings file
is the easiest place to confuse them.

**What follows for this repository.** Shipping Antigravity alone — at any number of families —
improves independence and leaves gate availability where it is. Reaching SC-001 needs a second
*account*, which in practice means Cursor as the second provider rather than a second Antigravity
model. That is a larger step than pinning another model string, and it is stated here so the cheap
configuration is not mistaken for the whole feature.

**Alternatives considered**: Treating distinct families as sufficient for SC-001 — rejected; it
would let the success criterion be reported as met by a configuration that cannot survive the
outage the criterion was written about. Refusing same-account routes outright — rejected as too
strong: the configuration is genuinely valuable for independence, and an operator may reasonably
want it. It is recorded rather than forbidden.
