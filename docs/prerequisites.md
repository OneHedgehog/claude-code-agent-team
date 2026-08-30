# Prerequisites

Everything a human must set up before the [independent review service](independent-review-service.md)
can run. **None of it can be done by the service itself** — an identity that can provision its own
gate, its own runner, or its own credentials can also remove them, so each of these is deliberately
out of reach and stays a human step.

This is the operational checklist. The *why* behind each choice lives in
[independent-review-service.md](independent-review-service.md); the short version an agent needs in
context lives in [CLAUDE.md](../CLAUDE.md); and the [README](../README.md) is the entry point that
routes between all three.

## Authorisation is yours

**An agent checks for a credential and asks; it never authorises.** Before starting work that needs
one, an agent must verify the credential is present and — if it is not — stop and ask, rather than
beginning the work and surfacing the gap partway through.

An agent must never run an authentication flow on your behalf: not `ant auth login`, not
`gh auth login`, not a browser sign-in, not entering a token anywhere. It gives you the exact
command and waits.

This is the same discipline the service itself applies. FR-051 verifies every prerequisite *before*
spending a token, because a prerequisite discovered mid-run has already cost money and left partial
state behind. The rule above extends that from the service to the agents building it.

## Status

| # | Prerequisite | State |
|---|---|---|
| 1 | [GitHub App](#1-github-app) | **Done.** App `4627916`, installation `155031737`, all six permissions verified 2026-08-30 |
| 2 | [Model credential](#2-model-credential) | **Done.** OAuth profile; inference verified 2026-08-30 |
| 3 | [Fork CI blocking](#3-fork-ci-blocking) | **Done** |
| 4 | ~~[Self-hosted runner](#4-self-hosted-runner)~~ | **Removed 2026-08-20 (R-017)** |
| 5 | [Branch protection](#5-branch-protection) | **Done 2026-08-30.** `required_status_checks.contexts` is `["independent-review"]` |
| 6 | [Fixture repository](#6-fixture-repository) | **Done.** Seeded 2026-08-27, App installed, `main`'s gate required 2026-08-28 |

All six are now satisfied, so nothing here blocks the service from running against a real pull
request. What remains is *installing* it — the daemon is not yet loaded under `launchd`, and until it
is, `main` is closed: see [§5](#5-branch-protection).

### Order to do them in

Items 1 and 5 are circular — and not merely if approached naively:

1. Create the App (**1**) and install it on the repository.
2. Put the App ID and private key where the service can read them (**2**), on the developer machine.
3. Add `independent-review` to `main`'s required status checks **through the API** (**5**).

The intuitive ordering — open a throwaway pull request, let the App post the context once, then pick
it out of the branch-protection UI — cannot work on any repository. `reviewPullRequest` returns at
the FR-051 prerequisite check *before* it reaches `openGate`
([`composition.ts`](../src/composition.ts)), so while the gate is not required the service posts no
check run at all and GitHub never learns the context exists. The context cannot appear before it is
already required.

The API breaks the circle because it accepts a context GitHub has never seen, which the settings
UI's picker — it searches only contexts seen in the last week — will not offer. The command is in
[§5](#5-branch-protection).

---

## 1. GitHub App

The **reviewing identity**. Deliberately not the PAT: GitHub enforces that **only GitHub Apps can
create check runs**, so no personal access token can report this gate at any scope. That is what
makes the author/reviewer separation structural rather than a convention this project maintains
(FR-002, FR-022).

**Verified 2026-08-30 — done.** App ID `4627916`, installation `155031737` on both the target and
the fixture, with all six permissions below present and `administration` correctly at `read`.
`./scripts/github-app-token.sh --check` reprints this at any time without minting a token.

Create at [github.com/settings/apps/new](https://github.com/settings/apps/new):

| Field | Value |
|---|---|
| **GitHub App name** | Globally unique. See the naming warning below |
| **Homepage URL** | The repository URL — a required field, not otherwise used |
| **Webhook → Active** | **Uncheck.** The service reconciles state by polling (R-017/R-018); it consumes no events. Leaving this on forces you to supply a webhook URL |
| **Where can this GitHub App be installed?** | Only on this account |

**Repository permissions** — exactly what [`src/github/auth.ts`](../src/github/auth.ts) verifies at
startup. Anything missing fails the run before any model spend, with a reason naming it (FR-003):

| Permission | Level | Why |
|---|---|---|
| Checks | Read and write | The merge gate itself (FR-021, FR-022) |
| Pull requests | Read and write | Posting findings and verdicts (FR-006, FR-010) |
| Contents | Read and write | Only for the GraphQL `resolveReviewThread` mutation — a recorded least-privilege tension |
| Issues | Read and write | Escalations (FR-035) |
| Administration | **Read only** | Verifying branch protection (FR-051) |
| Metadata | Read only | Mandatory; GitHub adds it automatically |

**Administration must never be `write`.** An identity that can change branch protection can remove
its own gate, which would make the whole feature theatre. The service verifies and reports; it never
configures.

Subscribe to events: **none**. There are no webhooks.

After creating: note the **App ID**, click **Generate a private key** (the `.pem` downloads once and
cannot be re-downloaded), then **Install App** on the target repository.

### Storing it, and minting tokens

[`scripts/github-app-token.sh`](../scripts/github-app-token.sh) holds the App's credentials and
mints short-lived installation tokens on demand:

```bash
./scripts/github-app-token.sh --set-app-id <id>
./scripts/github-app-token.sh --set-key < ~/Downloads/your-app.private-key.pem
./scripts/github-app-token.sh --check
```

`--check` prints the installation ID and the granted permissions — useful for confirming the
permission table above against what GitHub actually granted — and deliberately prints no token.
Running it with no arguments prints an installation token, which expires in an hour and is never
stored.

Consume it so the value never reaches a transcript or shell history:

```bash
T="$(./scripts/github-app-token.sh)" curl -s -H "Authorization: Bearer $T" https://api.github.com/repos/OWNER/REPO/pulls
```

The private key lives at `~/.config/github-app/review-app.pem`, mode `0600`, and the script refuses
to run if the permissions are looser. **Not** the keychain, unlike the PAT: `security -w` silently
truncates a piped value at 128 characters and a 2048-bit PEM base64s to roughly 2,300, so it would
be stored corrupted with no error. Passing it as an argument instead avoids the truncation but
exposes the private key to `ps`. A `0600` file is how ssh and TLS hold private keys, and openssl
reads it directly.

> One error message to know: GitHub answers a *well-formed* JWT signed by an unrecognised key with
> `A JSON web token could not be decoded` — the same text it uses for a genuinely malformed token.
> A nonexistent App ID, a key belonging to a different App, and a skewed clock are indistinguishable
> from the response, so the script names all three rather than sending you after one.

> **Naming warning.** The App's slug becomes its bot login, `<slug>[bot]`, and that string is what
> [`self-review.ts`](../src/review/self-review.ts) compares the pull request author against for
> FR-004. If the configured reviewing-identity name and the real slug disagree, the self-authored
> refusal silently never fires — independence collapses while every check still reports green. Pick
> the name once and make sure the configuration matches it.

---

## 2. Model credential

**Decision (2026-08-17): authenticate through an OAuth profile, not a static API key.**
`ant auth login` stores a profile under `~/.config/anthropic/` that the SDKs read automatically —
a bare `new Anthropic()` works with no environment variable set, so there is no long-lived secret
sitting in the environment or the keychain.

Rejected: Amazon Bedrock and Google Vertex AI, both of which need a cloud account and so are
prohibited by Principle IV without a constitutional amendment.

**Verified working 2026-08-17, re-verified 2026-08-30.** A bare `new Anthropic()` — no argument, no
environment variable — authenticates through the profile and runs inference. Scopes:
`user:developer user:inference user:profile`.

> **An expiry in `ant auth status` is not a failure.** On 2026-08-30 it reported the access token as
> having expired 57 hours earlier; the very next SDK call succeeded, because the refresh happens on
> first use rather than on a timer. The token prefix changing between two `ant auth status` calls is
> the tell. Only a hard-expired *refresh* token needs `ant auth login` — and an agent never runs it.

To recreate it on another machine:

```bash
brew install anthropics/tap/ant
xattr -d com.apple.quarantine "$(brew --prefix)/bin/ant"
ant auth login
```

`ant auth status` shows the active credential source, the profile, and the token expiry. Access
tokens are short-lived (~8h) and refresh automatically.

> **An agent must never run `ant auth login` on your behalf** — see [Authorisation is yours](#authorisation-is-yours) below.

### The shadowing trap

Credentials resolve in this order, first match wins:

```
ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN → the active OAuth profile → Workload Identity Federation → the default profile on disk
```

**`ANTHROPIC_API_KEY` beats the profile — and beats it even when set to the empty string**, in
which case requests authenticate with an empty key rather than falling through. Keep all three
of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_PROFILE` unset on the runner unless
you mean to use one. All three are currently unset on this machine.

### How the code resolves it

[`resolveModelCredential`](../src/model/anthropic.ts) returns a `ModelCredential` carrying its
`source` — `environment`, `keychain`, or `oauth-profile` — rather than a bare key string, because a
profile credential legitimately carries **no key**: the SDK reads the profile itself, so the secret
never enters the service's process.

It checks the three sources in the SDK's own resolution order, deliberately. Reporting a profile
while `ANTHROPIC_API_KEY` is set would name a source the SDK is about to ignore.

**Absence is a startup prerequisite failure, not a runtime one.** `checkPrerequisites` verifies a
credential exists alongside the permission and branch-protection checks, so a missing one fails with
a stated reason and **zero spend** rather than surfacing as a `401` partway through a review — the
same discipline FR-051 applies to everything else. The adapter still refuses a source that promises
a key and supplies an empty one; it just no longer treats "no key" as automatically wrong.

### What the App still needs

Independent of the model credential, the service needs the App's identity from step 1. It reads it
from disk, not from the environment: `~/.config/github-app/app-id` and `review-app.pem`, both
managed by [`scripts/github-app-token.sh`](../scripts/github-app-token.sh). See
[§1](#storing-it-and-minting-tokens) for why the private key is a `0600` file rather than a keychain
entry — the keychain silently truncates it.

**Known limitation.** OAuth refresh tokens hard-expire rather than sliding with use, so an
unattended runner will eventually start failing auth and need a fresh `ant auth login`. Workload
Identity Federation is the documented answer for non-interactive workloads and is the likely end
state — it needs org-level federation setup that does not exist yet.

**TBD.** Which Anthropic account or billing entity backs the profile. Model spend is metered against
`tokenBudget` in [`.agents/settings.json`](../.agents/settings.json), currently `20000000` with a
`5000000` reviewer reserve — placeholders chosen before any usage data existed. Revisit both once a
first review has actually run.

### Related: the authoring PAT

Not a prerequisite for the service, but part of the same credential picture. `GITHUB_MCP_PAT` lives
in the macOS keychain and is the **authoring** identity used by agent tooling — it must never become
the reviewing identity. Only [`scripts/claude-github.sh`](../scripts/claude-github.sh) puts it in the
environment; see [CLAUDE.md](../CLAUDE.md).

---

## 3. Fork CI blocking

**Done, and mostly no longer needed** — recorded rather than deleted, because the reasoning is what
justifies the current arrangement.

**The control that used to matter.** `review.yml` — deleted 2026-08-20 under R-017 — was gated on
`github.event.pull_request.head.repo.full_name == github.repository`. It checked out the pull
request's own code and ran `npm ci` and `npm run build` against it on a self-hosted runner, so on a
public repository without that guard, anyone opening a pull request got arbitrary code execution on
the runner host.

**Why it is gone.** There is no runner and no reviewer workflow. The service reads the reviewed code
as data — a diff and a file listing — and the only program it runs against a checkout is `git`, with
arguments it chose itself ([`worktree.ts`](../src/worktree.ts)). The guard had nothing left to
protect, and its deliberate consequence went with it: **a fork's pull request is now reviewed like
any other.**

**Defence in depth, still in force** — the repository's fork pull-request approval policy:

```
first_time_contributors  →  all_external_contributors
```

The old value was the public-repo default, under which a *returning* outside contributor's workflows
run with no approval at all. In the UI: **Settings → Actions → General → Fork pull request workflows
from outside collaborators**.

This is left in place. It costs nothing, and it is the ordinary hardening for a public repository
whatever the reviewer's topology happens to be.

**`ci.yml` is deliberately left open to forks.** It runs on `ubuntu-latest` with `contents: read`, so
a fork pull request gets an ephemeral GitHub-hosted VM and a read-only token. That is the ordinary
safe configuration, and blocking it would cost pull-request validation for no real gain.

---

## 4. ~~Self-hosted runner~~ — removed 2026-08-20 (R-017)

**No runner is registered, and none is needed.** The service is a long-lived local process under
`launchd`, not a workflow on a runner. This item is kept rather than deleted because it is
cross-referenced, and because what replaced it is worth stating in the same place.

The host-wide concurrency cap was going to be the runner's job-slot count. It is now
`host.maxConcurrentAgents` in `<target>/.agents/settings.json`, enforced by a filesystem lease under
`${XDG_STATE_HOME:-~/.local/state}/agents/slots/` that every agent job on the machine acquires
before starting and releases when it stops ([`host-lease.ts`](../src/host-lease.ts), R-019). That is
**configuration, not a human prerequisite** — and it is a stronger guarantee than the runner gave,
because it counts every agent on the host rather than every job on one runner.

Principle VIII's cap "counts any CI or reviewer job executing on the same host", and an exempted
reviewer would be the one job able to thrash the machine it is protecting (FR-041). Installing the
service is documented in
[quickstart.md](../specs/001-independent-review-service/quickstart.md#install-the-service-r-017).

---

## 5. Branch protection

Add **`independent-review`** — the value of `MERGE_GATE_CHECK_NAME` in
[`check-run.ts`](../src/github/check-run.ts) — to `main`'s required status checks.

Available now that the repository is public; a private repository on GitHub Free has neither branch
protection nor rulesets.

**Verified 2026-08-30 — done.** `required_status_checks.contexts` is `["independent-review"]`, so
`isGateRequired` returns `true` and the service passes this prerequisite. Recorded 2026-08-24 and now
superseded: the branch was protected but `contexts` and `.checks` were both empty, which the service
correctly failed its own prerequisite check on. Also set: `enforce_admins`, `dismiss_stale_reviews`,
`required_conversation_resolution`, strict up-to-date branches, one required approving review, and
neither force pushes nor deletions.

It must be set through the API, for the reason in [the ordering note](#order-to-do-them-in). `strict`
is passed explicitly because a `PATCH` omitting it would drop the up-to-date-branch requirement:

```bash
T="$(security find-generic-password -s github-mcp-pat -w)"; curl -s -X PATCH -H "Authorization: Bearer $T" -H "Accept: application/vnd.github+json" https://api.github.com/repos/OneHedgehog/claude-code-agent-team/branches/main/protection/required_status_checks -d '{"strict":true,"checks":[{"context":"independent-review"}]}'
```

Success prints `"checks": [{"context": "independent-review", ...}]`. A `403` is the PAT lacking
`Administration: write`, which it is legitimate for it not to hold — see [the note on the two
403s](../CLAUDE.md).

**Know the way back out before you set it.** From this moment `main` is unmergeable until the
service reports the check green on each head SHA, and `enforce_admins` means you cannot override it
as owner. Removing the requirement is the only escape:

```bash
T="$(security find-generic-password -s github-mcp-pat -w)"; curl -s -X PATCH -H "Authorization: Bearer $T" -H "Accept: application/vnd.github+json" https://api.github.com/repos/OneHedgehog/claude-code-agent-team/branches/main/protection/required_status_checks -d '{"strict":true,"checks":[]}'
```

The same command sets the fixture's gate — it is how [§6](#6-fixture-repository)'s 6d was done —
with the repository path changed.

The service **verifies this and never writes it.** That is the whole reason the App holds
`administration: read` and not `write`.

### The bootstrap exception, 2026-08-30

The gate could not review its own introduction, and this is the record of what was done about it.

[#1](https://github.com/OneHedgehog/claude-code-agent-team/pull/1) carried the whole service --
composition root, daemon, host lease, worktree, e2e suite, specs, docs. The service reviewed it and
**refused it correctly**: 11,935 changed lines against a `maxReviewableDiffSize` of 2,000 (FR-037),
no review attempted, **zero model tokens spent**, the reason stated on the pull request, and
escalation issue #2 opened. Its first real run was a refusal of its own author, which is the system
working.

That refusal is not escapable, and deliberately so. FR-043's `## Size justification` clears the
400-line discipline cap; FR-037 has no such escape, because a diff too large to review is not made
reviewable by explaining itself. So the pull request introducing FR-037 was necessarily larger than
FR-037 permits.

**Dropping the required check would not have been enough.** `main` also requires one approving
review, and GitHub does not permit approving your own pull request -- unsatisfiable for a sole
author regardless of the gate. The minimal override was therefore `enforce_admins`: disabled,
merged as admin, re-enabled. The gate's configuration -- the required context and the review count
-- was never changed, so the exception is recorded as an admin bypass rather than as a weakened
gate.

**Verified after restoring:** `enforce_admins.enabled` is `true`, `required_status_checks.checks` is
`["independent-review"]`, `required_approving_review_count` is `1`.

**This is not a precedent.** It applies once, to the change that introduced the gate. A later pull
request over the reviewable limit gets split, which is what FR-037 asks for and what the seven
commits on that branch were already shaped for.

---

## 6. Fixture repository

A separate repository the end-to-end suite drives (R-015). It **cannot be the target repository**:
quickstart scenario 26 needs a branch where the gate is deliberately *not* required, which cannot
coexist with the target's own protection.

The App from step 1 must be installed on it too.

**The repository is [`OneHedgehog/fixture-repo-ad`](https://github.com/OneHedgehog/fixture-repo-ad)**,
created 2026-08-27.

**Visibility resolved 2026-08-27 — public.** A private repository on GitHub Free cannot have branch
protection, and most e2e scenarios need the gate to actually **be** a required check; the fixture is
therefore public, like the target. Every "private fixture" in the spec artefacts was corrected to
match on the same date.

**Progress, verified 2026-08-28 — complete:**

| # | Step | State |
|---|---|---|
| 6a | Seed `main` with enough real code that a diff is reviewable | **Done.** Constitution, settings, `src/`, `tests/`, `docs/`; zero runtime dependencies |
| 6b | Install the App from [§1](#1-github-app), same permissions | **Done.** Installation `155031737`, the same one covering the target; all six permissions present |
| 6c | Open one throwaway pull request so the App posts `independent-review` once | **Skipped deliberately** — see below |
| 6d | Add `independent-review` to `main`'s required checks | **Done 2026-08-28.** `required_status_checks.contexts` is `["independent-review"]`. Set through the API rather than the settings UI: the picker searches checks seen in the last week, and this one had never run |
| 6e | Create a second long-lived branch with **no** protection | **Done.** `unprotected-base` |

Step 6e is why the fixture cannot be the target repository, and keeping it as a standing branch is
cheaper than reconfiguring protection midway through the suite.

**Why 6c is skipped.** It is unreachable, here and on the target alike: the service posts no check
run until the gate is already required, so the context can never be seen first. See [the ordering
note](#order-to-do-them-in). The fixture has a second reason on top of that one — most scenarios
need the gate required *before* the service runs at all. Set it with the `PATCH` in
[§5](#5-branch-protection), against the fixture's path.

**What the seed contains, and why none of it is decorative.** The service resolves the *target's*
constitution, so `.specify/memory/constitution.md` is read unguarded by the composition root and its
absence is a crash rather than a diagnostic. `.agents/settings.json` carries the `reviewService`
section. `docs/` must exist for the documented-behaviour rule to match against. `main` is
deliberately clean: a finding raised against the baseline would contaminate every scenario branching
from it, so each scenario's flaw belongs in its own diff.

---

## Open questions

| Question | Affects |
|---|---|
| Which account or billing entity provides the Anthropic credential | [§2](#2-model-credential) |
| The App's name, and therefore its `<slug>[bot]` login | [§1](#1-github-app), FR-004 self-review |
| Real values for `tokenBudget` and `reviewerTokenReserve` | [`.agents/settings.json`](../.agents/settings.json) |
