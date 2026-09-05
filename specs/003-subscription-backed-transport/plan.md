# Implementation Plan: A Subscription-Backed Model Transport

**Spec**: [spec.md](./spec.md) · **Branch**: `agent-sdk-transport` · **Created**: 2026-09-05

This document exists because the constitution requires every third-party dependency to be justified
*in the plan*, and this feature reached implementation with a spec and nothing between them. The
review raised that as a blocking finding; this is the answer, written after the fact and saying so.

## Approach

A second `ModelClient` behind the interface spec 001 already defined, selected by the
`modelTransport` setting. Both implementations share `buildReviewPrompt` and `parseReviewResponse`
(FR-057), so the injection guard and the response contract have one definition rather than two that
can drift.

Nothing above the model boundary changes. The composition root chooses which client to build; the
roles, the gate, the ledger and the daemon are untouched.

## The dependency

| | |
|---|---|
| Package | `@anthropic-ai/claude-agent-sdk@^0.3.261` |
| Licence | `SEE LICENSE IN README.md` — `© Anthropic PBC. All rights reserved.` |
| Permissive | **No.** Waived; see [spec.md](./spec.md) Waiver 1 |
| Alternative considered | None reaches the entitlement. The subscription is a Claude Code product entitlement, and this is the vendor's own client for it. The alternative is not a different library but no subscription-backed transport at all |

### Peers, declared explicitly

The SDK declares `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` and `zod` as **peer**
dependencies. An earlier revision relied on npm's automatic peer installation, which left them in
the lockfile as `"peer": true` and nowhere in `package.json`. An install performed with
`--legacy-peer-deps`, by a resolver that does not auto-install peers, or by a different package
manager would then produce a tree in which this transport cannot load — surfacing at review time, on
the transport adopted specifically so the gate keeps running. All three are now direct dependencies.

### The transitive surface, and why it is accepted

Installing the SDK takes the production tree to ~148 packages and pulls in an HTTP server stack —
`express` 5, `hono`, `@hono/node-server`, `cors`, `body-parser`, `express-rate-limit`, `jose` — plus
`@modelcontextprotocol/sdk`, `zod`, and a process-spawning group promoted from dev to runtime:
`cross-spawn`, `which`, `isexe`, `shebang-command`, `shebang-regex`, `path-key`, `debug`, `ms`.

That is a materially larger surface for a process that parses untrusted diffs, and it is accepted on
these grounds rather than waved past:

- **The server stack is MCP's, and no MCP server is configured.** It is reachable code, not running
  code: this transport passes no `mcpServers`, so nothing binds a port. It remains dependency-tree
  weight and a supply-chain surface, which is the honest cost.
- **The spawning group is what "runs Claude Code as a library" means.** The SDK starts a subprocess;
  `cross-spawn` and its helpers are how. There is no version of this feature without it.
- **The containment is at the call, not in the tree.** `tools: []`, `allowedTools: []`, a
  `canUseTool` that denies unconditionally, `settingSources: []`, and a `cwd` pointing at an empty
  temporary directory rather than the orchestrator's own checkout (FR-058). Egress restriction
  (Principle V) is unchanged: the subprocess talks to the same model endpoint this service already
  talks to.
- **`api` remains the default** (FR-056), so no operator inherits this surface by upgrading.

**What this does not claim.** The transitive packages are not audited line by line, and a
compromised release of any of them would run in this process. That risk is real and is the price of
the waiver; it is recorded here rather than left implicit.

## What could not be carried across

`ReviewRequest.maxTokens` has no equivalent in the harness — `maxTurns` bounds the conversation,
`maxBudgetUsd` bounds money, `maxThinkingTokens` is deprecated and bounds only thinking. Rather than
accept the field and silently ignore it, FR-061 states the limitation: on this transport a review is
bounded by one turn and by the budget check that authorised it, not by an output ceiling.

## What the harness actually needs, measured

Three claims about the SDK were load-bearing and unverified, so they were tested rather than read.
Each experiment ran a one-turn query and observed the answer.

| question | method | result |
|---|---|---|
| Does `env` **replace** the child's environment, or merge over `process.env`? | Planted a bogus `ANTHROPIC_BASE_URL` in the parent only | **Replaces.** With `env` set the child answered normally; with `env` omitted it failed to connect |
| Which variables does subscription auth need? | Removed them one at a time | `PATH`, `HOME` **and `USER`**. `{PATH, HOME}` answers `Credit balance is too low` — it falls back to a metered path |
| Does an empty `ANTHROPIC_API_KEY` shadow the subscription? | Passed `""` alongside a working set | **No.** It still authenticates. This is *not* true of the Anthropic SDK, where an empty key authenticates as an empty key (CLAUDE.md) |

The `USER` result is the one worth carrying forward: it looks cosmetic, it is not, and removing it
degrades the transport to the exhausted credits **silently** — the run still completes, and only the
error text says what happened. FR-063 exists because that failure is invisible.

Replacement being the measured behaviour would make omitting the API key sufficient. It is named
with an empty value anyway, so the neutralisation holds under a merging SDK too. Twice on this
feature a claim about someone else's contract has turned out weaker than it read, and an experiment
recorded here is only true of the version it was run against.

## Option names, as the SDK documents them

Three options carry the guarantees this feature claims, and each is a name in someone else's
package. Cited here so a later reader can check them against the SDK rather than against this
code's belief about it — pinned at `@anthropic-ai/claude-agent-sdk@0.3.261`.

| option | what the SDK says | why it matters here |
|---|---|---|
| `tools` | *"To restrict which tools are available, use the `tools` option"* | The one that actually withholds tools (FR-058) |
| `allowedTools` | *"tool names that are auto-allowed without prompting for permission"* | Pre-approval only. Asserting this alone was the first shipped defect |
| `canUseTool` | *"Called before each tool execution to determine if it should be allowed, denied, or prompt"* | The third refusal, independent of both |
| `env` | *"this value REPLACES the subprocess environment entirely — it is not merged with `process.env`"* | What makes an allowlist possible (FR-063). Measured, see above |
| `effort` | *"Controls how much effort Claude puts into its response"*, `'low' … 'max'` | The same dial `output_config.effort` spends on `api` (FR-060) |
| `thinking` | *"`{ type: 'adaptive' }`"*, and effort *"works with adaptive thinking to guide thinking depth"* | Effort without it configures half a dial |
| `abortController` | Standard `AbortController` | The only time bound this transport has |

`effort` and `thinking` are the weakest of these, and deliberately left so: nothing verifies that the
harness honours them beyond the option existing on the documented type. If either is ignored,
`modelEffort` is inert while still being reported (the FR-060 defect, one field over). It is cheap to
accept because nothing is at risk but depth — a review at the wrong effort is still a review, and
still validated — whereas the tool and environment options guard containment and billing, which is
why those get three refusals and an experiment rather than a citation.

## No task decomposition, and why

The workflow is spec → plan → tasks → implement, and no `tasks.md` was produced. Review asked for
either the file or a statement of why not; this is the statement, because a retrospective
decomposition invented after the work is fiction with a filename.

Principle VIII wants each task's file and resource footprint recorded and the parallel-safe ones
marked. This feature has one footprint: a single new adapter, the composition root that selects it,
and their tests. There is nothing to run in parallel and nothing that contends — a decomposition
would have one entry. That is why the stage was skipped, not an argument that the stage is
optional; a feature touching several subsystems would need it.

## Verification

`npm run check` — build, lint, format, typecheck, diagram, unit and integration suites — plus
`tests/e2e/agent-transport.e2e.ts`, which drives this transport end to end against the real fixture
repository with only the SDK's `query` scripted, and real
reviews driven through the subscription against this repository's own pull request #9. Two rounds so
far: round 1 against `ad40205` raised nine findings including the tool-guard defect, and round 2
against `4b9e086` cleared all seven inline findings and approved on the implementation role. Both
ran with no API credential resolvable, which is SC-002 exercised rather than asserted.
