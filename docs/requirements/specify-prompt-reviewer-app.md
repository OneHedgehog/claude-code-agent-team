# `/speckit-specify` prompt — Feature 001: Independent Review Service

Paste everything in the block below after `/speckit-specify`.

---

Build the independent review service for this repository: a GitHub App plus a GitHub Actions
workflow that reviews every pull request and gates its merge.

**Context.** This repository is an autonomous multi-agent coding system. The review service is
the first component built and becomes the merge gate for everything built after it — including
itself, from its second pull request onward. The project constitution is at
`.specify/memory/constitution.md`; Principle VI governs this feature directly, and Principles
II, IV, VII, and IX constrain it.

**What it does.**

- Triggers on every pull request (`on: pull_request`), running in GitHub Actions under a GitHub
  App identity that is distinct from any authoring identity.
- Runs two reviewer roles against the diff: a security reviewer and an implementation reviewer.
- Posts findings as review comments anchored to specific lines, each carrying a severity, with
  blocking and non-blocking clearly distinguished.
- Concludes each role with an explicit review state — approve, or request changes. A silent
  pass is never an approval.
- Sets a status check that only the App identity can set, so a merge cannot proceed without it.
  The orchestrator must not be able to satisfy this gate itself.
- Re-reviews from scratch when new commits are pushed. A prior verdict never carries forward,
  and any push invalidates prior approvals.
- Refuses to approve a pull request authored by its own identity.

The implementation reviewer additionally checks constitutional compliance on the diff: tests
present for new behavior, an end-to-end test for the feature, and a feature document under
`docs/` that matches the change (Principle IX).

**Constraints.**

- The service operates against an explicit target repository, supplied as a parameter. Version
  one supports exactly one target — the repository the service itself lives in — but the
  constitution, operating settings, and repository paths MUST be resolved through that
  parameter rather than read from the process working directory. Multi-repository support is
  out of scope; hardcoding a single repository is equally out of scope.
- Runs on a self-hosted runner on the developer machine. Model credentials come from the local
  environment or keychain and never from GitHub Actions secrets.
- The model call sits behind a substitutable interface so that end-to-end tests drive the whole
  flow with a scripted double, asserting deterministically on states entered, comments posted,
  and verdicts reached — never on generated wording (Principle II).
- Reports token spend per review against the configured budget, and stops rather than
  overspending (Principle IV).
- If the reviewer cannot run at all, that is a failed gate, not an absent one. A pull request
  must never become mergeable because the reviewer was unavailable.
- Structured JSON logs; every review traceable to a run identifier (Principle VII).

**Success looks like.**

- A pull request introducing a hardcoded credential receives a blocking security comment on the
  offending line and a request-changes verdict.
- A clean pull request receives approving verdicts from both roles and a green check.
- A pull request that changes behavior without updating its `docs/` document receives a blocking
  finding from the implementation reviewer.
- Pushing a commit after approval leaves the pull request unmergeable until re-review completes.
- With branch protection configured, a pull request whose reviewer check has not reported cannot
  be merged by any automated actor.

**Out of scope.** The orchestrator loop, automatic merging, isolated checkouts and parallel
execution, and evaluation suites. Each is a later feature that depends on this one.

**Record as a spec note.** This feature is the single exception to Principle VI, because the
reviewers it creates cannot review the pull request that creates them. Its own first pull
request is human-reviewed; it reviews itself from the second onward. This exception is narrow,
applies only to this feature, and expires once the service is merged.
