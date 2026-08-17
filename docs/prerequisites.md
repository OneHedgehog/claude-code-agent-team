# Prerequisites

Everything a human must set up before the [independent review service](independent-review-service.md)
can run. **None of it can be done by the service itself** — an identity that can provision its own
gate, its own runner, or its own credentials can also remove them, so each of these is deliberately
out of reach and stays a human step.

This is the operational checklist. The *why* behind each choice lives in
[independent-review-service.md](independent-review-service.md); the short version an agent needs in
context lives in [CLAUDE.md](../CLAUDE.md).

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
| 1 | [GitHub App](#1-github-app) | **Not created** |
| 2 | [Model API key](#2-model-api-key) | **Not provisioned** |
| 3 | [Fork CI blocking](#3-fork-ci-blocking) | **Done** |
| 4 | [Self-hosted runner](#4-self-hosted-runner) | **Not registered** |
| 5 | [Branch protection](#5-branch-protection) | Available, **not configured** |
| 6 | [Fixture repository](#6-fixture-repository) | **Not created** |

Nothing below blocks `npm run check`, which is green today. They block the service *running* against
a real pull request, and all 28 `tests/e2e/**` tasks.

### Order to do them in

Items 1, 4 and 5 are circular if approached naively:

1. Create the App (**1**) and install it on the repository.
2. Put the App ID and private key where the runner can read them (**2**).
3. Register the runner with the `agents-host` label (**4**).
4. Open one throwaway pull request so the App posts a check run named `independent-review` **once**.
5. *Then* add `independent-review` to `main`'s required status checks (**5**).

Step 4 exists because GitHub only offers a status-check context in the branch-protection picker
after it has seen that context at least once. You can type the name manually and skip it, but the
round-trip is the reliable way to confirm the App is really posting under the name the service
expects.

---

## 1. GitHub App

The **reviewing identity**. Deliberately not the PAT: GitHub enforces that **only GitHub Apps can
create check runs**, so no personal access token can report this gate at any scope. That is what
makes the author/reviewer separation structural rather than a convention this project maintains
(FR-002, FR-022).

Create at [github.com/settings/apps/new](https://github.com/settings/apps/new):

| Field | Value |
|---|---|
| **GitHub App name** | Globally unique. See the naming warning below |
| **Homepage URL** | The repository URL — a required field, not otherwise used |
| **Webhook → Active** | **Uncheck.** The service is driven by GitHub Actions, not webhooks; leaving it on forces you to supply a webhook URL |
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

Neither the CLI nor a profile exists yet. To create one:

```bash
brew install anthropics/tap/ant
xattr -d com.apple.quarantine "$(brew --prefix)/bin/ant"
ant auth login
```

`ant auth status` then shows which credential source and profile is active.

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

### Consequence for the code

[`AnthropicModelClient`](../src/model/anthropic.ts) **cannot use a profile as written.** Its
constructor throws `MissingCredentialError` on an empty key, and `readModelCredential` only knows
the environment and the keychain. Supporting a profile means making the credential *optional* so a
bare client construction is allowed. Not yet done.

### What the App still needs

Independent of the model credential, the runner needs the App's identity from step 1:

| Variable | Secret? | Source |
|---|---|---|
| `REVIEW_APP_PRIVATE_KEY` | Yes | The `.pem` from step 1 — `security add-generic-password -s review-app-private-key -w` |
| `REVIEW_APP_ID` | No | The numeric App ID |

> **These must not be restated in the workflow as `${{ env.NAME }}`.** That expression reads the
> *workflow's* env context, which does not expose the runner host's environment — it resolves to an
> empty string and then overrides the inherited value with it. `run:` steps inherit the host
> environment directly, which is why [`review.yml`](../.github/workflows/review.yml) does not
> mention them at all.

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

**Done.** Two layers, because one of them is not enough.

**The control** — [`review.yml`](../.github/workflows/review.yml) is gated on:

```yaml
if: github.event.pull_request.head.repo.full_name == github.repository
```

The reviewer job checks out the pull request's own code and runs `npm ci` and `npm run build`
against it on a self-hosted runner. On a public repository without this guard, anyone opening a pull
request gets arbitrary code execution on the runner host. GitHub's own guidance is that self-hosted
runners belong to private repositories; this condition is what makes one safe on a public repo.

**Defence in depth** — the repository's fork pull-request approval policy:

```
first_time_contributors  →  all_external_contributors
```

The old value was the public-repo default, under which a *returning* outside contributor's workflows
run with no approval at all. In the UI: **Settings → Actions → General → Fork pull request workflows
from outside collaborators**.

Approval is a human clicking a button, and one misclick would be enough — so it backs up the `if`
rather than replacing it. The `if` cannot be misclicked.

**`ci.yml` is deliberately left open to forks.** It runs on `ubuntu-latest` with `contents: read`, so
a fork pull request gets an ephemeral GitHub-hosted VM and a read-only token. That is the ordinary
safe configuration, and blocking it would cost pull-request validation for no real gain.

**The consequence, which is correct but surprising:** a fork's pull request gets no review, so the
gate is never reported and branch protection keeps it un-mergeable. Un-mergeable and quiet beats
mergeable. A fork contributor's change reaches `main` by a maintainer taking it onto a branch in this
repository, where it is reviewed like anything else.

---

## 4. Self-hosted runner

Registered on the developer machine, labelled **`agents-host`** — [`review.yml`](../.github/workflows/review.yml)
targets `[self-hosted, agents-host]`, so the label must match exactly or the job queues forever.

Set the runner's **job slot count to the host-wide concurrency cap**. Reviewer jobs take an ordinary
slot and are never given a dedicated runner: Principle VIII's cap "counts any CI or reviewer job
executing on the same host", and an exempted reviewer would be the one job able to thrash the machine
it is protecting (FR-041).

Read [§3](#3-fork-ci-blocking) before registering this. A self-hosted runner on a public repository
is the highest-risk item on this page.

---

## 5. Branch protection

Add **`independent-review`** — the value of `MERGE_GATE_CHECK_NAME` in
[`check-run.ts`](../src/github/check-run.ts) — to `main`'s required status checks.

Available now that the repository is public; a private repository on GitHub Free has neither branch
protection nor rulesets. `main` is currently unprotected, so `/branches/main/protection` returns
`404 Branch not protected` and the service will correctly fail its own prerequisite check with a
reason naming the branch.

See [the ordering note](#order-to-do-them-in) — the context has to be seen once before GitHub offers
it in the picker.

The service **verifies this and never writes it.** That is the whole reason the App holds
`administration: read` and not `write`.

---

## 6. Fixture repository

A separate repository the end-to-end suite drives (R-015). It **cannot be the target repository**:
quickstart scenario 26 needs a branch where the gate is deliberately *not* required, which cannot
coexist with the target's own protection.

The App from step 1 must be installed on it too.

**TBD — visibility.** `tasks.md` specifies a *private* fixture, but most e2e scenarios need the gate
to actually **be** a required check, and a private repository on GitHub Free cannot have branch
protection. So the fixture must either be public as well, or the account moves to a paid plan. Not
yet decided.

---

## Open questions

| Question | Affects |
|---|---|
| Which account or billing entity provides the Anthropic key | [§2](#2-model-api-key) |
| The App's name, and therefore its `<slug>[bot]` login | [§1](#1-github-app), FR-004 self-review |
| Fixture repository visibility — public, or a paid plan | [§6](#6-fixture-repository) |
| Real values for `tokenBudget` and `reviewerTokenReserve` | [`.agents/settings.json`](../.agents/settings.json) |
