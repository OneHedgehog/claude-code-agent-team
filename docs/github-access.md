# GitHub access for agents working on this repository

How an agent working *on* this repository reaches GitHub, and why its token is deliberately weaker
than the review service's own identity.

This is developer and operator setup. It is not the independent review service's feature document —
that is `docs/independent-review-service.md`, which ships with the feature itself (Principle IX).

## The repositories

| Role | Repository | State |
|---|---|---|
| **Target** — what this working tree pushes to, and what the service reviews | [`OneHedgehog/claude-code-agent-team`](https://github.com/OneHedgehog/claude-code-agent-team) | Private, empty, default branch `main`. Wired as `origin`. |
| **Fixture** — private repo the e2e suite drives (R-015) | not created | Human prerequisite; see [What stays human](#what-stays-human) |

### Blocker: branch protection is unavailable on the target

`OneHedgehog` is on **GitHub Free** and the target repository is **private**. Both the branch
protection and the rulesets endpoints return:

```
403  Upgrade to GitHub Pro or make this repository public to enable this feature.
```

This is a *plan* limitation, not a token permission — the same token reads metadata, contents, pull
requests, issues, actions, and checks on this repository without complaint.

It blocks the feature's central premise. Quickstart prerequisite 3 requires branch protection making
the reviewer check run required, and FR-051 verifies exactly that before every review. Under the
contract's own conclusion mapping a missing required check is `failure` + escalate + zero spend, so
the service would refuse to review anything, forever. Resolve before implementation, by one of:

- **Make the target repository public** — free, and branch protection becomes available immediately
- **Upgrade to GitHub Pro** — keeps the repository private
- **Move it into an organization** on Team or above

Note for [contracts/github-surface.md](../specs/001-independent-review-service/contracts/github-surface.md):
that document reads a `403` on the protection endpoint as "the installation lacks
`administration: read`". That diagnosis is incomplete — a `403` also means the plan does not offer
the feature, and the two need distinguishing in the message the gate reports.

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
| Actions | none | Read | Optional — only if the harness inspects workflow-run timing for the queue-wait scenarios |

**The Workflows trap**: without `Workflows: Read and write`, GitHub rejects any push that touches
`.github/workflows/**` — and it rejects the entire push, not just that file. If you would rather keep
workflow files under human control, leave the permission off and commit `ci.yml` and `review.yml`
yourself.

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
