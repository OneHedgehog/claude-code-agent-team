# GitHub access for agents working on this repository

How an agent working *on* this repository reaches GitHub, and why its token is deliberately weaker
than the review service's own identity.

This is developer and operator setup. It is not the independent review service's feature document —
that is [independent-review-service.md](independent-review-service.md), which ships with the feature
itself (Principle IX). If you arrived here first, the [README](../README.md) is the entry point.

## The repositories

| Role | Repository | State |
|---|---|---|
| **Target** — what this working tree pushes to, and what the service reviews | [`OneHedgehog/claude-code-agent-team`](https://github.com/OneHedgehog/claude-code-agent-team) | **Public**, default branch `main`, protected. Wired as `origin` over SSH. |
| **Fixture** — private repo the e2e suite drives (R-015) | not created | Human prerequisite; see [What stays human](#what-stays-human) |

### ~~Blocker: branch protection is unavailable on the target~~ — resolved

**Resolved by making the target repository public.** Kept here because it is why
[`branch-protection.ts`](../src/github/branch-protection.ts) classifies two different `403`s instead
of one.

While `OneHedgehog` was on **GitHub Free** with the target **private**, both the branch protection
and the rulesets endpoints returned:

```
403  Upgrade to GitHub Pro or make this repository public to enable this feature.
```

That is a *plan* limitation, not a token permission — the same token read metadata, contents, pull
requests, issues, actions, and checks on the repository without complaint. It blocked the feature's
central premise: quickstart prerequisite 3 requires branch protection making the reviewer check run
required, FR-051 verifies exactly that before every review, and a missing required check maps to
`failure` + escalate + zero spend, so the service would have refused to review anything, forever.

**Current state, verified 2026-08-24**: the repository is public, `/branches/main/protection`
returns `200`, and `main` is protected — but `required_status_checks.contexts` and `.checks` are
both empty, so `independent-review` is not yet a required check. Adding that context is the one
remaining human step; see [prerequisites.md §5](prerequisites.md#5-branch-protection).

The lesson this left in the contract: reading a `403` on the protection endpoint as "the
installation lacks `administration: read`" is incomplete — a `403` also means the plan does not
offer the feature, and the two are distinguished in the message the gate reports. See
[contracts/github-surface.md](../specs/001-independent-review-service/contracts/github-surface.md).

## Two identities, and why they must stay apart

| Identity | Is | Holds | Used for |
|---|---|---|---|
| **Reviewing identity** | A GitHub App installation | `checks: write`, `pull_requests: write`, `contents: write`, `issues: write`, `administration: read` | Reporting the merge gate, posting findings, resolving its own threads |
| **Authoring identity** | A fine-grained PAT | Repository permissions below — never `checks: write`, never `administration: write` on the target | Agent-driven pushes, opening pull requests, driving the end-to-end suite |

The separation is required by FR-002 and FR-003, and asserted by SC-007: an authoring identity that
attempts to report the merge gate must be refused.

**GitHub enforces the important half for us.** Check runs can only be created or updated by a GitHub
App — a user token gets a `403` no matter what permissions it carries
([contracts/github-surface.md](../specs/001-independent-review-service/contracts/github-surface.md)).
So a PAT structurally cannot satisfy the gate. Keeping `checks` read-only is therefore about making
the intent legible, not about closing a hole that would otherwise be open.

The consequence worth internalising: **no PAT unblocks the end-to-end suite.** Every e2e task asserts
on a check-run conclusion, so the App must exist and be installed before any of them run.

## Token permissions

Create a **fine-grained** token at
[github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens),
scoped to the two repositories, with an expiry of 7 or 30 days — never "no expiration".

### Account permissions: none

Leave every account permission unset. Nothing in this system touches your profile, email addresses,
SSH or GPG keys, gists, followers, or plan. Organization permissions are likewise unnecessary while
both repositories are personally owned.

The single exception, and only if you observe it failing: a client that identifies itself with
`GET /user` may need **Profile: Read**. Start at zero and add it in response to a real error rather
than in anticipation of one.

### Repository permissions

| Permission | Target repo | Fixture repo | Why |
|---|---|---|---|
| Metadata | Read | Read | Mandatory; auto-selected with any other permission |
| Contents | Read and write | Read and write | Push the baseline; create test branches and commits |
| Pull requests | Read and write | Read and write | Open pull requests, read diffs, post the author-side replies the waiver scenarios need |
| Workflows | Read and write | Read and write | Required to commit anything under `.github/workflows/` |
| Checks | **Read** | **Read** | The e2e harness must read the gate's conclusion to assert on it |
| Issues | Read | Read and write | Verify escalation issues; the fixture also needs teardown |
| Administration | **none** | Read and write | Toggling branch protection is the *fixture* for the missing-protection scenario; on the target it would let the gate be removed |
| Actions | none | Read | Optional. Was for inspecting workflow-run timing in the queue-wait scenarios; under R-017 the wait is measured from the enqueuing tick, and there is no workflow run to read |

**The Workflows trap**: without `Workflows: Read and write`, GitHub rejects any push that touches
`.github/workflows/**` — and it rejects the entire push, not just that file. If you would rather keep
workflow files under human control, leave the permission off and commit `ci.yml` yourself. (There
is only `ci.yml`: the reviewer workflow was deleted under R-017, and the service runs as a local
process instead.)

**Tuning**: grant this set, then narrow on evidence. When something returns `403`, the endpoint in
the error names the missing permission exactly. Starting tight and widening on a specific failure
converges on a minimal token; starting broad never does.

## Storing and using the token

The token reaches the GitHub MCP server through an environment variable that is expanded at launch,
never written to disk in plaintext:

```bash
./scripts/claude-github.sh --set   # prompts once; stores it in the macOS keychain
./scripts/claude-github.sh         # reads it back and starts Claude Code
```

`.mcp.json` holds only the placeholder, which is why it is safe to commit:

```json
"Authorization": "Bearer ${GITHUB_MCP_PAT}"
```

Verify the keychain entry without revealing it — `security find-generic-password -s github-mcp-pat`
prints attributes only. Adding `-w` prints the secret; don't.

To rotate: generate a new token, run `--set` again (it overwrites), restart. To revoke: delete it at
[github.com/settings/tokens](https://github.com/settings/tokens).

## What this does and does not contain

The keychain keeps the token out of shell history and out of the repository. It does **not** put the
token beyond an agent's reach: `exec claude` passes its environment to every process it spawns,
including the agent's own shell, so anything that shell can read, the agent can read.

Containment therefore rests on the token itself — two repositories, no Administration on the target,
a short expiry — rather than on where it is stored. This is stated plainly because the alternative is
believing in a wall that isn't there. Deny rules in `.claude/settings.json` can block accidental
disclosure paths such as `env` and `printenv`, and they are worth having, but they stop mistakes
rather than intent.

## What stays human

Neither the agent nor its token provisions these, by design — an identity that can create itself or
write its own branch protection can remove its own gate:

- Creating the GitHub App, installing it on both repositories, and placing its private key in the
  runner's environment or keychain
- Creating the private fixture repository
- Configuring branch protection to require the merge gate

The service verifies the last of these before every review (FR-051) and never writes it.
