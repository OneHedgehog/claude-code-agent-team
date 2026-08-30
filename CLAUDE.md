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

`AnthropicModelClient` accepts a profile: the credential is resolved to a `ModelCredential` carrying
its `source`, and an `oauth-profile` credential legitimately carries no key, so only a source that
promises a key and then supplies an empty one is rejected. Presence is checked as a **startup
prerequisite** alongside permissions and branch protection, so an absent credential costs zero tokens
instead of surfacing as a `401` mid-review. See [docs/prerequisites.md](docs/prerequisites.md) §2.

## Repositories

| Role | Repository | State |
|---|---|---|
| **Target** — what this tree pushes to, and what the review service reviews | `OneHedgehog/claude-code-agent-team` | **Public**, default branch `main`, wired as `origin` over SSH |
| **Fixture** — repo the e2e suite drives (R-015) | [`OneHedgehog/fixture-repo-ad`](https://github.com/OneHedgehog/fixture-repo-ad) | **Public**, seeded 2026-08-27, App installed. Branches `main` — gate required since 2026-08-28 — and `unprotected-base`, deliberately left unprotected for quickstart scenario 26 |

Neither the spec nor the contracts name these; they say "the target repository". This table is the
mapping.

## The merge gate: configured and live

The target repository was private on GitHub Free, which offers neither branch protection nor
rulesets, so FR-051 built as specified would have refused every review permanently. **That is
resolved — the repository is public**, `/branches/main/protection` reaches the feature, and
`src/github/branch-protection.ts` plus `src/review/prerequisites.ts` are implemented.

**Verified 2026-08-30**: the gate is real. `main` is protected and
`required_status_checks.contexts` is `["independent-review"]`, so `isGateRequired` returns `true` and
the service passes this prerequisite. This supersedes the 2026-08-24 record, where the branch was
protected but `contexts` and `.checks` were both empty.

**What that means operationally, and it is not small.** `main` is now unmergeable until the service
reports `independent-review` green on each head SHA, and `enforce_admins` means nobody can override
it. The service is the only producer of that context — `review.yml` is gone and `ci.yml` publishes
different names — so while the daemon is not running, pull requests sit at *Expected — waiting for
status to be reported* indefinitely. The daemon is **not installed under `launchd` today**; until it
is, assume the target's `main` is closed. §5 of [docs/prerequisites.md](docs/prerequisites.md)
carries both the command that set this and the one that removes it again.

The service verifies branch protection and never writes it: an identity that can change branch
protection can remove its own gate. Setting it is a human step, done with a PAT — never with the
App's installation token, which holds `administration: read` only.

The rest of the protection is already set: `enforce_admins`, `dismiss_stale_reviews` — which matches
FR-017's push-invalidates-approvals rule — `required_conversation_resolution`, strict up-to-date
branches, one required approving review, and neither force pushes nor deletions.

**The fixture repository's gate is configured.**
[`OneHedgehog/fixture-repo-ad`](https://github.com/OneHedgehog/fixture-repo-ad) is **public** —
precisely because a private fixture on GitHub Free would hit the original wall again — seeded
2026-08-27, with the App installed (installation `155031737`, the same one that covers the target)
and two branches: `main`, and `unprotected-base` for quickstart scenario 26. Most e2e scenarios need
the gate to *be* required; only scenario 26 needs it absent, which is why the unprotected branch is a
standing fixture rather than a mid-suite reconfiguration.

**Verified 2026-08-28**: `main`'s `required_status_checks.contexts` is `["independent-review"]`, and
`unprotected-base` still answers `Branch not protected`, which is what scenario 26 needs. The e2e
suite runs: `npm run test:e2e` passes the harness smoke check 7/7 against the real fixture.

It was set through the API, not the settings UI. The picker there searches only checks seen in the
last week, and the usual round-trip — open a pull request so GitHub sees the context once — is
circular on the fixture, because the service emits that context only when it runs and most scenarios
need the gate required before it does. To set one on another repository:

```bash
T="$(security find-generic-password -s github-mcp-pat -w)" \
  curl -s -X PATCH -H "Authorization: Bearer $T" \
  https://api.github.com/repos/OWNER/REPO/branches/main/protection/required_status_checks \
  -d '{"checks":[{"context":"independent-review"}]}'
```

`Administration: write` is legitimate on the *fixture* — its protection state is the test fixture —
and must never be held against the target. The checklist is
[docs/prerequisites.md](docs/prerequisites.md) §6.

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
