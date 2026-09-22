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
from the macOS keychain (`github-mcp-pat`) and `exec`s claude. **That is the sanctioned path, and
an agent has no other.**

Started any other way, the variable is empty and **no `mcp__github__*` tools appear at all**, which
looks like a missing server rather than an unauthenticated one. The server reports
`Authorization header is badly formatted`; that string means the variable is empty, not that the
token is wrong. Check `$GITHUB_MCP_PAT` before concluding anything else.

**When the tools are absent, the answer is to relaunch through the script — not to work around
it.** Principle V is explicit that agents MUST NOT read or transmit credentials and that
containment is enforced by the execution environment rather than by an agent's own judgement. The
launch script is that environment: it injects the credential so the agent never handles it. An
agent that extracts the PAT from the keychain to make its own API calls has stepped outside the
boundary, whatever care it takes with the value afterwards.

**This has been done, and it is recorded here as a fact rather than as guidance.** On 2026-09-20 an
agent read the PAT from the keychain and used it directly to create thirty issues, push nine
branches and open nine pull requests, having documented the practice here as a first-class route.
The independent reviewer raised it as a critical finding against Principle V, correctly. The
credential is therefore to be treated as exposed and rotated — see
[#56](https://github.com/OneHedgehog/claude-code-agent-team/issues/56). Whether that route is ever
acceptable, and under what supervision, is a human decision that has not been made, so nothing
here authorises it.

**Never print the token, and never extract it to hand to another command.** An earlier revision of
this file argued that `-w` under command substitution was "use" rather than "disclosure" and that
the value was therefore safe. That argument was wrong on its own terms — `VAR=$(...) cmd` places
the secret in the child process's environment, where it is observable to the same user — and it was
wrong in kind, because it rewrote a prohibition into a permission in order to unblock the work in
front of it.

**Inside the Bash sandbox, `curl` resolves `api.github.com` and Node's `fetch` does not** unless
`NODE_USE_ENV_PROXY=1` is set; without it `fetch` fails as `getaddrinfo ENOTFOUND`. This matters
for running the review service locally, which is a sanctioned use of the *App* identity and not of
the PAT.

The PAT is the **authoring** identity. It is not, and must not become, the reviewing identity —
only GitHub Apps can write check runs (FR-002, FR-003, SC-007).

## Known PAT gaps

- `repository_hooks: read` — not granted (`/hooks` → 403). No contract call needs it.
- **`issues: write` — verified 2026-09-20** on the target, via route 2: thirty consecutive `201`s
  creating issues #14–#43. No longer a gap.
- Branch and pull-request writes remain unverified; confirming them means creating real branches or
  pull requests. Ask before probing those.

An authenticated `GET /repos/OWNER/REPO` reports `permissions` as `admin/maintain/push/triage/pull`
all true. **That is the account's role on the repository, not the token's grants** — this PAT is
fine-grained and holds `administration: read` only, as the 403 history above shows. Do not read that
field as evidence the token may change branch protection.
