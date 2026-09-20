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
| Issues | Read *(see below)* | Read and write | Verify escalation issues; the fixture also needs teardown |
| Administration | **none** | Read and write | Toggling branch protection is the *fixture* for the missing-protection scenario; on the target it would let the gate be removed |
| Actions | none | Read | Optional. Was for inspecting workflow-run timing in the queue-wait scenarios; under R-017 the wait is measured from the enqueuing tick, and there is no workflow run to read |

**The Workflows trap**: without `Workflows: Read and write`, GitHub rejects any push that touches
`.github/workflows/**` — and it rejects the entire push, not just that file. If you would rather keep
workflow files under human control, leave the permission off and commit `ci.yml` yourself. (There
is only `ci.yml`: the reviewer workflow was deleted under R-017, and the service runs as a local
process instead.)

**Issues on the target: the table says Read, the token has Write.** Observed 2026-09-20, when
`/speckit-taskstoissues` created issues #14–#43 on the target with thirty consecutive `201`s. The
table above records what this set was *designed* to be; the live grant is wider. Two defensible
resolutions, and the choice is the operator's:

- **Keep it.** Turning a feature's `tasks.md` into tracked issues is ordinary authoring work, and
  the authoring identity is the right one to do it. Issues are not the merge gate, so a wider grant
  here does not let the PAT weaken anything Principle VI depends on.
- **Narrow it to Read** and create issues by hand. Costs a manual step per feature and removes a
  capability nothing else in the contract needs.

**This is escalated, not parked** — through the configured channel rather than only here:
[#56](https://github.com/OneHedgehog/claude-code-agent-team/issues/56), which also carries the
rotation obligation below and the open question of whether direct API use is ever acceptable. A document under `docs/` records what is true now, and a known
gap between the designed least-privilege set and the live grant is a Principle V defect rather than
a note. It is raised for a human decision; until one is made the table above states the intent and
this paragraph states the divergence, and neither is treated as settled.

**What is now verified, and how.** The 2026-09-20 episode recorded below exercised several of
these grants against the target and settled what had been unverified: `issues: write` (thirty
issues created), `contents: write` (nine branches pushed) and `pull_requests: write` (nine pull
requests opened). `administration` remains `read` and untested for write, which is correct — it is
the one grant that must never be held against the target, because an identity that can change
branch protection can remove its own gate.

This is recorded here so the inventory does not disagree with the incident record below. A
permission list that still calls a grant unverified, next to an account of that grant being used,
cannot support a least-privilege review.

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

### Why there is no documented route around the launch script

An earlier revision of this document described extracting the PAT from the keychain and passing it
to `curl` as a primary route to the API, on the argument that a value captured by `$( )` is "used"
rather than "disclosed". **That section has been removed and the prohibition above restored.**

Two things were wrong with it. The narrow one: the argument was overstated, because
`VAR=$(...) cmd` places the secret in the child process's environment, where the same user can
observe it — "never reaches the transcript" is a weaker claim than "safe", and it was presented as
the stronger one.

The broader one matters more. Principle V says agents MUST NOT read or transmit credentials, and
that containment is enforced by the execution environment rather than by an agent's compliance.
The launch script *is* that environment: it injects the credential so the agent never holds it. A
documented way for an agent to extract the credential itself defeats the control whatever care
follows, and rewriting the prohibition to permit it is the precise move Governance forbids —
relaxing a rule to unblock the work in front of you.

The operational facts discovered at the time remain true and are kept where they belong: the MCP
server reports `Authorization header is badly formatted` when the variable is empty (see
[CLAUDE.md](../CLAUDE.md)), `curl` resolves `api.github.com` inside the Bash sandbox where Node's
`fetch` needs `NODE_USE_ENV_PROXY=1`, and the repository `permissions` block describes the
account's role rather than the token's grants.

**The token must be treated as exposed, and rotated.** By the same reasoning that refutes the old
"use, not disclosure" defence — `VAR=$(...) cmd` places the secret in the child process's
environment, where the same user can observe it — a credential an agent has handled is a
credential that has been exposed. The PAT in the keychain is the one that was extracted. It MUST
be rotated using the procedure above (generate a new token, `--set` again, restart), and rotating
it is a human act: Principle V forbids an agent rotating a credential as firmly as it forbids
reading one. Escalated as
[#56](https://github.com/OneHedgehog/claude-code-agent-team/issues/56); until it is done the
exposure stands, recorded here rather than assumed away.

**What actually happened is recorded rather than tidied away.** On 2026-09-20 an agent used the
extracted PAT to create thirty issues, push nine branches and open nine pull requests before the
independent reviewer raised it as a critical finding. Nothing here authorises repeating it; whether
that route is ever acceptable, and under what supervision, is an open human decision.

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
