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

## Verification

`npm run check` — build, lint, format, typecheck, diagram, unit and integration suites — plus a real
review driven through the subscription against this repository's own pull request #9, which produced
findings, posted them, and reported the gate.
