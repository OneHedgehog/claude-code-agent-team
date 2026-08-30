# agents-coding-team

An **independent review service**: a GitHub App and a local reconciling process that review every
pull request in a named target repository and gate its merge. Two reviewer roles — security and
implementation — read the diff, post line-anchored findings carrying severity and an explicit
blocking status, and each conclude with a stated verdict. A check run, which only a GitHub App can
create, carries the combined outcome.

The point is the gate. A review that produces advice nobody has to act on is a comment; a review
that must pass before a merge is a gate. Everything in here follows from that distinction —
including the parts that look excessive, like refusing to review at all when the check is not
actually required by branch protection.

> **Status.** Built and validated end to end. All three test layers pass, including the full
> end-to-end suite against a live fixture repository. **One human step is outstanding** before it
> can gate the target repository: adding `independent-review` to that repository's required status
> checks. The service verifies this and never writes it — an identity that could configure its own
> gate could remove it. See [Prerequisites](docs/prerequisites.md).

## Start here

| If you want to…                                   | Read                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Understand what it does and how it works          | [docs/independent-review-service.md](docs/independent-review-service.md) — the feature document, including the generated statechart |
| Set it up for real                                | [docs/prerequisites.md](docs/prerequisites.md) — the human checklist, in order, with the current state of each                      |
| Run it, or run one review by hand                 | [Quickstart](specs/001-independent-review-service/quickstart.md), and the commands below                                            |
| See what was validated, and what running it found | [Validation scenarios](docs/independent-review-service.md#validation-scenarios)                                                     |
| Work on this repository as an agent               | [CLAUDE.md](CLAUDE.md) — the short operational version, and [docs/github-access.md](docs/github-access.md) for the reasoning        |
| Read what was specified, and why                  | [specs/001-independent-review-service/](specs/001-independent-review-service/)                                                      |

## Commands

Install and build:

```bash
npm ci && npm run build
```

The gate CI runs, and the one to run locally before anything else — build, lint, format, types, the
statechart diagram check, unit tests, integration tests:

```bash
npm run check
```

The end-to-end suite, run on its own because it talks to GitHub, consumes a shared API allowance,
and takes minutes:

```bash
npm run test:e2e
```

Review one named pull request by hand. The target is always explicit — there is no default, and no
fallback to the working directory:

```bash
node dist/cli.js --target owner/name --checkout /path/to/checkout --pull-request 42
```

Run the reconciling daemon in the foreground, which is what to do while diagnosing:

```bash
npm run daemon -- --target owner/name --checkout /path/to/checkout
```

Ordinary operation is that daemon under `launchd`; [the feature
document](docs/independent-review-service.md#how-to-run-it) has the install and uninstall steps.

## Layout

| Path                              | What lives there                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/`                            | The service. `composition.ts` is the one place concrete adapters are constructed; `cli.ts` and `daemon.ts` are the two entry points |
| `tests/`                          | Three separated layers — `unit/`, `integration/`, `e2e/` — never conflated in one command                                           |
| `docs/`                           | What is **true now**. The feature document, the prerequisites checklist, agent access                                               |
| `specs/`                          | What was **intended when it was written**. Never rewritten                                                                          |
| `schemas/`                        | The published settings and record contracts the service validates against at runtime                                                |
| `.agents/settings.json`           | Operating settings, shared with any other agent working on the repository                                                           |
| `.specify/memory/constitution.md` | The rules the reviewers read and this repository is held to                                                                         |

### Why `docs/` and `specs/` both exist

They answer different questions and are deliberately allowed to disagree. A spec records what was
intended at the time it was written and is never edited afterwards, so the reasoning behind a
decision survives the decision changing. A document records what is true now.

When the two conflict, `docs/` is right about the present and `specs/` is right about the past. This
is Principle IX, and the service enforces it on other people's pull requests too: updating a spec
never satisfies the requirement to update a document.

## Ideas worth knowing before reading the code

- **Fail closed, never fail quiet.** Every inability to review — a missing credential, an exhausted
  budget, an oversized diff, a stalled round — produces a failing or unreported gate and an
  escalation. There is no code path that yields `neutral` or `skipped`, because GitHub treats those
  as non-failing, and a gate that reads as "no objection" is worse than no gate.
- **Two identities, structurally separate.** The service reviews as a GitHub App and can never
  author what it reviews. This is not a policy it follows: GitHub accepts a check-run write only
  from an App installation, so no personal access token can report this gate at any scope.
- **State lives on GitHub.** Local files are caches. Each round writes its own record into its
  check-run output, so a crashed process, a cleared disk, or a fresh clone all recover the same
  history — which is what makes the reconciling loop safe to kill at any moment.
- **The model boundary is one interface.** It is the only thing the end-to-end suite substitutes,
  and a lint rule forbids asserting on anything the model wrote.

## Contributing

Every change follows `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` →
`/speckit-implement`, on its own branch, ending in one pull request that the service reviews.

`npm run check` must be green, and it is exactly what CI runs — a check that exists only in CI is
prohibited, so a green local run means a green CI run.

## Licence

MIT.
