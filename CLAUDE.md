# CLAUDE.md

Operational facts an agent needs before touching GitHub in this repository. Rationale and setup
instructions live in [docs/github-access.md](docs/github-access.md); this file is the short version
that has to be in context.

## Repositories

| Role | Repository | State |
|---|---|---|
| **Target** — what this tree pushes to, and what the review service reviews | `OneHedgehog/claude-code-agent-team` | Private, empty, default branch `main`, wired as `origin` |
| **Fixture** — private repo the e2e suite drives (R-015) | not created | Human prerequisite |

Neither the spec nor the contracts name these; they say "the target repository". This table is the
mapping.

## Blocked: the merge gate cannot be required yet

The target repository is **private on GitHub Free**, so it has neither branch protection nor
rulesets. Both endpoints return `403 Upgrade to GitHub Pro or make this repository public to enable
this feature.`

FR-051 verifies the reviewer check run is a *required* check before every review, and a missing
required check maps to `failure` + escalate + zero spend. Built as specified today, the service
would refuse to review anything, permanently.

**Do not implement the merge gate until this is resolved** — by making the repository public,
upgrading to Pro, or moving it to an organization on Team or above. Raise it rather than working
around it.

## Two 403s that mean different things

Never read a `403` as "missing permission" without checking the message:

| Message | Cause |
|---|---|
| `Resource not accessible by personal access token` | The grant really is missing |
| `Upgrade to GitHub Pro or make this repository public…` | The plan does not offer the feature; the grant may well be held |

Verified on the target repo: the PAT **holds** `administration: read` (`/keys`, `/autolinks`,
`/actions/permissions`, `/actions/runners` all `200`) and still gets `403` on
`/branches/main/protection`. See [contracts/github-surface.md](specs/001-independent-review-service/contracts/github-surface.md).

## Reaching GitHub

`.mcp.json` passes `Authorization: Bearer ${GITHUB_MCP_PAT}`, and only
[`./scripts/claude-github.sh`](scripts/claude-github.sh) populates that variable — it reads the PAT
from the macOS keychain (`github-mcp-pat`) and `exec`s claude.

Started any other way, the variable is empty and **no `mcp__github__*` tools appear at all**, which
looks like a missing server rather than an unauthenticated one. If GitHub tools are absent, check
`$GITHUB_MCP_PAT` first and ask the user to relaunch via the script. `gh` is not installed; there is
no fallback.

The PAT is the **authoring** identity. It is not, and must not become, the reviewing identity — only
GitHub Apps can write check runs (FR-002, FR-003, SC-007). Never print the token.

## Known PAT gaps

- `repository_hooks: read` — not granted (`/hooks` → 403). No contract call needs it.
- Write permissions are unverified; confirming them means creating real branches, PRs, or issues.
  Ask before probing writes.
