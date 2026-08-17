# CLAUDE.md

Operational facts an agent needs before touching GitHub in this repository. Rationale and setup
instructions live in [docs/github-access.md](docs/github-access.md); this file is the short version
that has to be in context.

## Check credentials up front; never authorise

**Before starting work that needs a credential, verify it is present. If it is not, stop and ask —
do not begin and discover the gap partway through.**

Never run an authentication flow on the user's behalf: not `ant auth login`, not `gh auth login`,
not a browser sign-in, not entering a token anywhere. Give the exact command and wait.

This mirrors FR-051, which verifies every prerequisite before spending a token, because a
prerequisite discovered mid-run has already cost money and left partial state.

## Model credential: an OAuth profile, not an API key

The chosen path is `ant auth login`, which stores a profile under `~/.config/anthropic/` that the
SDKs read automatically. **Verified working 2026-08-17**: a bare `new Anthropic()` — no argument, no
environment variable — authenticates and runs inference. Scopes `user:developer user:inference
user:profile`.

Access tokens are short-lived (~8h) and refresh automatically; the *refresh* token hard-expires
eventually, at which point `ant auth login` must be re-run. `ant auth status` shows the active
source and expiry.

`ANTHROPIC_API_KEY` **shadows the profile — including when set to the empty string**, which
authenticates with an empty key instead of falling through. Resolution order:
`ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → active profile → Workload Identity Federation →
default profile on disk. All three variables are currently unset; keep them that way.

`AnthropicModelClient` cannot use a profile as written — its constructor requires a non-empty key.
See [docs/prerequisites.md](docs/prerequisites.md) §2.

## Repositories

| Role | Repository | State |
|---|---|---|
| **Target** — what this tree pushes to, and what the review service reviews | `OneHedgehog/claude-code-agent-team` | **Public**, default branch `main`, wired as `origin` over SSH |
| **Fixture** — repo the e2e suite drives (R-015) | not created | Human prerequisite |

Neither the spec nor the contracts name these; they say "the target repository". This table is the
mapping.

## The merge gate: unblocked, not yet configured

The target repository was private on GitHub Free, which offers neither branch protection nor
rulesets, so FR-051 built as specified would have refused every review permanently. **That is
resolved — the repository is public**, `/branches/main/protection` reaches the feature, and
`src/github/branch-protection.ts` plus `src/review/prerequisites.ts` are implemented.

What remains is configuration, not code. `main` is currently **unprotected**, so the endpoint
returns `404 Branch not protected` and the service will fail its own prerequisite check with a
reason naming the branch. To make the gate real, a human adds `independent-review` — the value of
`MERGE_GATE_CHECK_NAME` — to the branch's required status checks. The service verifies this and
never writes it: an identity that can change branch protection can remove its own gate.

**The fixture repository needs the same treatment.** Most e2e scenarios need the gate to *be*
required; only quickstart scenario 26 needs it absent. A private fixture on GitHub Free would hit
the original wall again.

## Two 403s that mean different things

Never read a `403` as "missing permission" without checking the message:

| Message | Cause |
|---|---|
| `Resource not accessible by personal access token` | The grant really is missing |
| `Upgrade to GitHub Pro or make this repository public…` | The plan does not offer the feature; the grant may well be held |

Observed on this repository while it was private: the PAT **held** `administration: read` (`/keys`,
`/autolinks`, `/actions/permissions`, `/actions/runners` all `200`) and still got `403` on
`/branches/main/protection`. The distinction still matters for any private target, and
`classifyProtectionResponse` encodes it. See
[contracts/github-surface.md](specs/001-independent-review-service/contracts/github-surface.md).

## Reaching GitHub

`.mcp.json` passes `Authorization: Bearer ${GITHUB_MCP_PAT}`, and only
[`./scripts/claude-github.sh`](scripts/claude-github.sh) populates that variable — it reads the PAT
from the macOS keychain (`github-mcp-pat`) and `exec`s claude.

Started any other way, the variable is empty and **no `mcp__github__*` tools appear at all**, which
looks like a missing server rather than an unauthenticated one. If GitHub tools are absent, check
`$GITHUB_MCP_PAT` first and ask the user to relaunch via the script. `gh` is not installed; there is
no fallback, so **without the script there is no way to open a pull request** — only to push.

The token being in the keychain is not the same as it being in the environment: `.mcp.json`
interpolates the variable when the MCP server starts. For a one-off read-only API call outside that
path, resolve it inline so the value never enters the transcript:

```bash
T="$(security find-generic-password -s github-mcp-pat -w)" \
  curl -s -H "Authorization: Bearer $T" https://api.github.com/repos/OWNER/REPO
```

The PAT is the **authoring** identity. It is not, and must not become, the reviewing identity — only
GitHub Apps can write check runs (FR-002, FR-003, SC-007). Never print the token.

## Known PAT gaps

- `repository_hooks: read` — not granted (`/hooks` → 403). No contract call needs it.
- Write permissions are unverified; confirming them means creating real branches, PRs, or issues.
  Ask before probing writes.
