import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseArgs } from "../../src/cli.js";

import {
  composeService,
  estimateReviewTokens,
  ledgerPath,
  reviewPullRequest,
  type ComposeOptions,
} from "../../src/composition.js";
import { createTarget } from "../../src/config/target.js";
import { MERGE_GATE_CHECK_NAME, type CheckRunSummary } from "../../src/github/check-run.js";
import { runDaemon, type OpenPullRequest } from "../../src/daemon.js";
import { InMemoryLedgerStore, createLedger } from "../../src/ledger/tokens.js";
import { validateSettings, type LoadedSettings } from "../../src/config/settings.js";
import { MAX_OUTPUT_TOKENS } from "../../src/model/anthropic.js";
import { createLogger } from "../../src/observability/logger.js";
import type { ModelClient, ReviewResponse } from "../../src/model/client.js";

/**
 * The composition root, constructed and driven (FR-026, FR-027, tasks.md T135).
 *
 * Phase 11 named this gap precisely — "every adapter was built behind an interface and nothing
 * ever constructed one" — and then shipped T127 with no test at all, so a recurrence would be as
 * invisible as the first occurrence was. Every module below the root has unit tests that pass
 * whether or not anything ever wires them together; this file is the one place that asks whether
 * the wiring exists.
 *
 * An integration test rather than an end-to-end one: the platform edges are stubbed, but the real
 * settings schema, the real adapters, and the real review flow all run.
 */

const TARGET = createTarget({
  owner: "OneHedgehog",
  name: "claude-code-agent-team",
  // The repository's own checkout, so the real `.agents/settings.json` and the real constitution
  // are read. A fixture settings file would test the fixture rather than the file the service
  // actually ships against.
  checkoutPath: process.cwd(),
});

/**
 * The settings the run will actually apply, read once from the same file the run reads.
 *
 * Named here rather than hard-coded so the allowance tests below can sit *exactly* on the
 * configured reserve. A literal would test a number this repository is free to change, and would
 * pass for the wrong reason the moment it did.
 */
const SETTINGS: LoadedSettings = validateSettings(
  JSON.parse(readFileSync(`${process.cwd()}/.agents/settings.json`, "utf8")) as unknown,
);

const HEAD = "c0ffee".padEnd(40, "0");

const DIFF = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  "+const b = 2;",
  " export default a;",
].join("\n");

/** Records every call the run made, so the assertions can ask what was actually reached. */
interface Calls {
  checkRunsCreated: number;
  checkRunsConcluded: { conclusion?: string }[];
  reviewsSubmitted: string[];
  issuesCreated: number;
  comments: number;
}

function stubs(calls: Calls, overrides: Partial<ComposeOptions> = {}): ComposeOptions {
  const model: ModelClient = {
    review: (): Promise<ReviewResponse> =>
      Promise.resolve({
        verdict: "approve",
        findings: [],
        replyJudgements: [],
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
  };

  return {
    target: TARGET,
    runId: "run-composition",
    // The real `resolveModelCredential` runs against this: FR-051 checks the credential's
    // *presence* before any spend, so a run with no credential at all stops here rather than at a
    // 401 — which is exactly what the third test below asserts.
    env: { HOME: "/tmp/does-not-exist", ANTHROPIC_API_KEY: "not-a-real-key-for-tests" },
    readKeychain: () => null,
    model,
    logger: createLogger({ runId: "run-composition", write: () => undefined }),
    ledger: createLedger({
      target: "OneHedgehog/claude-code-agent-team",
      limits: {
        tokenBudget: 20_000_000,
        reviewerTokenReserve: 5_000_000,
        platformApiBudget: 400,
        platformApiReserve: 50,
      },
      store: new InMemoryLedgerStore(),
    }),
    // The one credential-shaped seam. Composing must never read a private key to be testable, or
    // the thing under test is the developer's machine.
    installationToken: () =>
      Promise.resolve({
        token: "ghs_stub",
        permissions: {
          checks: "write",
          pull_requests: "write",
          contents: "write",
          issues: "write",
          administration: "read",
        } as const,
        // Whatever mints a token knows which App it minted for, and FR-004 compares against that
        // App's login rather than against anything derivable from the repository.
        appSlug: "reviewer-app",
      }),
    octokit: fakeOctokit(calls),
    ...overrides,
  };
}

/**
 * A stand-in for the Octokit instance the root would otherwise construct. Only the endpoints the
 * run reaches are implemented; anything else throwing is the point, because reaching an
 * unimplemented one would mean the run took a path this test does not describe.
 */
function fakeOctokit(calls: Calls): ComposedOctokit {
  const rest = {
    checks: {
      create: () => {
        calls.checkRunsCreated += 1;
        return Promise.resolve({ data: { id: 4242 } });
      },
      update: (params: { conclusion?: string }) => {
        calls.checkRunsConcluded.push({ ...params });
        return Promise.resolve({ data: {} });
      },
      listForRef: () => Promise.resolve({ data: { check_runs: [] } }),
    },
    pulls: {
      get: (params: { mediaType?: unknown }) =>
        Promise.resolve(
          params.mediaType === undefined
            ? {
                data: {
                  number: 7,
                  title: "Add a constant",
                  body: "A small change.",
                  user: { login: "a-human", type: "User" },
                  head: { sha: HEAD },
                  base: { ref: "main" },
                  draft: false,
                },
              }
            : { data: DIFF },
        ),
      createReview: (params: { event: string }) => {
        calls.reviewsSubmitted.push(params.event);
        return Promise.resolve({ data: { id: 1 } });
      },
      list: () => Promise.resolve({ data: [], headers: { etag: 'W/"listing"' } }),
    },
    repos: {
      getBranchProtection: () =>
        Promise.resolve({
          status: 200,
          data: { required_status_checks: { contexts: [MERGE_GATE_CHECK_NAME] } },
        }),
    },
    // A healthy allowance by default, so every other test here takes FR-040's `proceed` path
    // explicitly rather than by falling through an unreadable-signals catch.
    rateLimit: {
      get: () =>
        Promise.resolve({
          data: {
            resources: {
              core: {
                limit: 5_000,
                remaining: 4_900,
                reset: Math.floor(Date.now() / 1000) + 3_600,
              },
            },
          },
        }),
    },
    issues: {
      listForRepo: () => Promise.resolve({ data: [] }),
      create: () => {
        calls.issuesCreated += 1;
        return Promise.resolve({ data: { number: 1 } });
      },
      update: () => Promise.resolve({ data: {} }),
      createComment: () => {
        calls.comments += 1;
        return Promise.resolve({ data: {} });
      },
    },
  };

  // The real type is enormous and generated; the run touches the handful of endpoints above, and
  // narrowing to them is what keeps this a test of the wiring rather than of Octokit.
  return { rest } as unknown as ComposedOctokit;
}

/** Review threads are GraphQL-only, so the root takes a `graphql` client rather than Octokit. */
function noThreads(): ComposedGraphql {
  const client = (): Promise<unknown> =>
    Promise.resolve({
      repository: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    });

  client.defaults = () => client;

  return client as unknown as ComposedGraphql;
}

/**
 * The two seams' non-optional types. `ComposeOptions` makes both optional, and under
 * `exactOptionalPropertyTypes` an optional property's type does not include `undefined` — so a
 * helper returning `ComposeOptions["octokit"]` would be returning something the option rejects.
 */
type ComposedOctokit = NonNullable<ComposeOptions["octokit"]>;
type ComposedGraphql = NonNullable<ComposeOptions["graphqlClient"]>;

function emptyCalls(): Calls {
  return {
    checkRunsCreated: 0,
    checkRunsConcluded: [],
    reviewsSubmitted: [],
    issuesCreated: 0,
    comments: 0,
  };
}

describe("the composition root constructs every concrete adapter without throwing (FR-026)", () => {
  it("builds the whole graph", async () => {
    const adapters = await composeService({ ...stubs(emptyCalls()), graphqlClient: noThreads() });

    expect(adapters.checkRuns).toBeDefined();
    expect(adapters.pullRequests).toBeDefined();
    expect(adapters.reviews).toBeDefined();
    expect(adapters.threads).toBeDefined();
    expect(adapters.branchProtection).toBeDefined();
    expect(adapters.escalation).toBeDefined();
    expect(adapters.model).toBeDefined();
    expect(adapters.logger).toBeDefined();
    expect(adapters.ledger).toBeDefined();
  });

  it("resolves the target's real operating settings through the target parameter", async () => {
    const adapters = await composeService({ ...stubs(emptyCalls()), graphqlClient: noThreads() });

    expect(adapters.settings.settings.requiredReviewerRoles).toContain("security");
    // The three keys R-017 and R-019 added, without which the daemon has no interval and no cap.
    expect(adapters.settings.settings.pollIntervalSeconds).toBeGreaterThan(0);
    expect(adapters.settings.settings.maxConcurrentReviews).toBeGreaterThan(0);
    expect(adapters.settings.host.maxConcurrentAgents).toBeGreaterThan(0);
  });

  it("composes without a model credential rather than failing before the prerequisite check", async () => {
    // FR-051's whole point: an absent credential is reported with a reason and zero spend, not
    // raised as a construction error nobody can attribute.
    const { model: _substituted, ...withoutModel } = stubs(emptyCalls());

    const adapters = await composeService({
      ...withoutModel,
      graphqlClient: noThreads(),
      readKeychain: () => null,
      env: { HOME: "/tmp/does-not-exist", ANTHROPIC_CONFIG_DIR: "/tmp/does-not-exist" },
    });

    expect(adapters.modelCredential).toBeNull();
    expect(adapters.model).toBeDefined();
  });

  it("addresses its local state at the target rather than at the working directory (FR-027)", () => {
    const path = ledgerPath({ HOME: "/home/someone" }, TARGET);

    expect(path).toContain("OneHedgehog__claude-code-agent-team");
    expect(path).toContain("/home/someone");
  });
});

describe("a review reaches the platform through the root (FR-026, FR-027)", () => {
  it("opens the gate, submits a verdict, and concludes the check run", async () => {
    const calls = emptyCalls();
    const adapters = await composeService({ ...stubs(calls), graphqlClient: noThreads() });

    const outcome = await reviewPullRequest(adapters, 7, { runId: "run-composition" });

    expect(calls.checkRunsCreated).toBe(1);
    expect(calls.checkRunsConcluded).toHaveLength(1);
    expect(outcome.headSha).toBe(HEAD);
    expect(outcome.stoppedBeforeSpending).toBe(false);

    // `REQUEST_CHANGES` rather than `APPROVE`, and that is the wiring working rather than failing:
    // the diff adds a line to `src/` with no test and no `docs/` update, which the implementation
    // reviewer's rules block on without ever consulting the model. A run that approved it would
    // mean the rules had not been composed in at all.
    expect(calls.reviewsSubmitted).toContain("REQUEST_CHANGES");
  });

  it("reserves what a review actually consumes, not a slice of an unrelated number", () => {
    // The regression this replaces: the reservation was `reviewerTokenReserve / 4` -- 1,250,000 per
    // role for a review that spends tens of thousands -- so a run could be refused for failing to
    // reserve millions it was never going to use. The estimate is now the prompt plus the response
    // ceiling, and the prompt is dominated by the diff, which is already in hand.
    const small = estimateReviewTokens(0, MAX_OUTPUT_TOKENS);
    const large = estimateReviewTokens(400_000, MAX_OUTPUT_TOKENS);

    expect(large).toBeGreaterThan(small);
    // Whatever else it is, it always covers everything the response may emit (Principle IV).
    expect(small).toBeGreaterThanOrEqual(MAX_OUTPUT_TOKENS);
    // And it stays in the range a review actually costs rather than the millions it replaced.
    expect(small).toBeLessThan(1_000_000);
  });

  it("asks the model for the model's ceiling, which no budget arithmetic derives", async () => {
    let seen = -1;
    const model: ModelClient = {
      review: (request) => {
        seen = request.maxTokens;

        return Promise.resolve({
          verdict: "approve",
          findings: [],
          replyJudgements: [],
          usage: { inputTokens: 10, outputTokens: 10 },
        });
      },
    };

    const adapters = await composeService({
      ...stubs(emptyCalls(), { model }),
      graphqlClient: noThreads(),
    });

    await reviewPullRequest(adapters, 7, { runId: "run-composition" });

    expect(seen).toBe(MAX_OUTPUT_TOKENS);
  });

  it("spends against the ledger, so a run's cost is recorded rather than merely incurred", async () => {
    const adapters = await composeService({ ...stubs(emptyCalls()), graphqlClient: noThreads() });

    await reviewPullRequest(adapters, 7, { runId: "run-composition" });

    expect(adapters.ledger.total("tokens")).toBeGreaterThan(0);
  });

  it("stops with a stated reason and zero spend when the gate is not a required check (FR-051)", async () => {
    const calls = emptyCalls();
    const octokit = fakeOctokit(calls) as unknown as {
      rest: { repos: { getBranchProtection: () => Promise<unknown> } };
    };
    octokit.rest.repos.getBranchProtection = () =>
      Promise.resolve({ status: 404, data: { message: "Branch not protected" } });

    const adapters = await composeService({
      ...stubs(calls),
      graphqlClient: noThreads(),
      octokit: octokit as unknown as ComposedOctokit,
    });

    const outcome = await reviewPullRequest(adapters, 7, { runId: "run-composition" });

    expect(outcome.stoppedBeforeSpending).toBe(true);
    expect(outcome.tokensConsumed).toBe(0);
    expect(outcome.gate.conclusion).toBe("failure");
    expect(outcome.gate.reason ?? "").toContain("main");
    // No check run was ever opened, because nothing got as far as reviewing.
    expect(calls.checkRunsCreated).toBe(0);
    // The stop is escalated on both surfaces, neither substituted for the other (FR-035).
    expect(calls.issuesCreated).toBe(1);
    expect(calls.comments).toBe(1);
  });

  /** Replaces the allowance the fake reports, which is the only input FR-040's decision reads. */
  function withAllowance(calls: Calls, remaining: number, resetInSeconds: number): ComposedOctokit {
    const octokit = fakeOctokit(calls) as unknown as {
      rest: { rateLimit: { get: () => Promise<unknown> } };
    };

    octokit.rest.rateLimit.get = () =>
      Promise.resolve({
        data: {
          resources: {
            core: {
              limit: 5_000,
              remaining,
              reset: Math.floor(Date.now() / 1000) + resetInSeconds,
            },
          },
        },
      });

    return octokit as unknown as ComposedOctokit;
  }

  it("waits unreported when the platform allowance reaches its reserve (FR-040)", async () => {
    const calls = emptyCalls();

    // At the reserve, with a reset comfortably inside `maxRateLimitWaitSeconds`. The allowance
    // costs nothing and refills, so this is the one budget that must not fail the pull request.
    const adapters = await composeService({
      ...stubs(calls),
      graphqlClient: noThreads(),
      octokit: withAllowance(calls, SETTINGS.settings.platformApiReserve, 120),
    });

    const outcome = await reviewPullRequest(adapters, 7, { runId: "run-composition" });

    // `unreported` is the one non-failing conclusion in the system, and it is never `success`,
    // `neutral`, or `skipped` — branch protection holds the merge because the check has not
    // reported at all.
    expect(outcome.gate.conclusion).toBe("unreported");
    expect(outcome.stoppedBeforeSpending).toBe(true);
    expect(outcome.tokensConsumed).toBe(0);

    // Nothing was posted, and no gate was opened to be left hanging.
    expect(calls.checkRunsCreated).toBe(0);
    expect(calls.reviewsSubmitted).toEqual([]);

    // A pause nobody is told about is indistinguishable from a service that has stopped.
    expect(calls.issuesCreated).toBe(1);
    expect(calls.comments).toBe(1);
  });

  it("fails the gate when the rate-limit wait exceeds the configured maximum (FR-040)", async () => {
    const calls = emptyCalls();

    const adapters = await composeService({
      ...stubs(calls),
      graphqlClient: noThreads(),
      // The same reserve reached, but the reset is further away than the operator agreed to wait.
      octokit: withAllowance(
        calls,
        SETTINGS.settings.platformApiReserve,
        SETTINGS.settings.maxRateLimitWaitSeconds + 600,
      ),
    });

    const outcome = await reviewPullRequest(adapters, 7, { runId: "run-composition" });

    expect(outcome.gate.conclusion).toBe("failure");
    expect(outcome.gate.reason ?? "").not.toBe("");
    expect(outcome.tokensConsumed).toBe(0);
    expect(calls.checkRunsCreated).toBe(0);
    expect(calls.issuesCreated).toBe(1);
    expect(calls.comments).toBe(1);
  });

  it("refuses a pull request authored by the App itself, whatever the repository is called (FR-004)", async () => {
    // The regression this pins is a comparison against the wrong pair of names. The reviewing
    // identity is the *App's* login, and it has nothing to do with the repository's name: here
    // they differ, which is the ordinary case and the one a name-derived identity gets wrong.
    // With the wrong pair, the check silently never fires — the run proceeds, reviews the App's
    // own work, and only GitHub's own refusal to let an author request changes on their own pull
    // request stops it, several API calls and a full model spend later.
    const calls = emptyCalls();
    const octokit = fakeOctokit(calls) as unknown as {
      rest: { pulls: { get: (params: { mediaType?: unknown }) => Promise<unknown> } };
    };

    const underlying = octokit.rest.pulls.get.bind(octokit.rest.pulls);
    octokit.rest.pulls.get = async (params: { mediaType?: unknown }): Promise<unknown> => {
      const response = (await underlying(params)) as { data: Record<string, unknown> };

      return params.mediaType === undefined
        ? { data: { ...response.data, user: { login: "reviewer-app[bot]", type: "Bot" } } }
        : response;
    };

    const adapters = await composeService({
      ...stubs(calls),
      graphqlClient: noThreads(),
      octokit: octokit as unknown as ComposedOctokit,
    });

    expect(adapters.reviewingIdentity).toBe("reviewer-app[bot]");
    expect(adapters.reviewingIdentity).not.toContain(TARGET.name);

    const outcome = await reviewPullRequest(adapters, 7, { runId: "run-composition" });

    expect(outcome.stoppedBeforeSpending).toBe(true);
    expect(outcome.tokensConsumed).toBe(0);
    expect(outcome.gate.conclusion).toBe("failure");
    expect(calls.checkRunsCreated).toBe(0);
    expect(calls.reviewsSubmitted).toEqual([]);
    expect(calls.issuesCreated).toBe(1);
    expect(calls.comments).toBe(1);
  });
});

describe("cli.ts reaches a review through the root and nowhere else", () => {
  it("exports a main the shell entry point calls, rather than reviewing at import time", async () => {
    const cli = await import("../../src/cli.js");

    expect(typeof cli.main).toBe("function");
    expect(typeof cli.parseArgs).toBe("function");
  });

  it("refuses to guess a target, so importing the module can never review anything", () => {
    // The guard that makes the assertion above meaningful: with no `--target` there is no run at
    // all, which is the constitution's Scope clause in one line.
    expect(() => parseArgs(["--pull-request", "7"])).toThrow();
  });
});

describe("settings the root loads are the settings the schema publishes", () => {
  it("validates this repository's own settings file against the published schema", () => {
    const loaded: LoadedSettings = validateSettings(
      JSON.parse(readFileSync(`${process.cwd()}/.agents/settings.json`, "utf8")) as unknown,
    );

    expect(loaded.settings.maxConcurrentReviews).toBeLessThanOrEqual(
      loaded.host.maxConcurrentAgents,
    );
  });
});

describe("what the root wires to the real adapter (Principle II)", () => {
  /** A transport that answers with one finding whose location tries to leave the checkout. */
  function messagesReturning(path: string) {
    return {
      // eslint-disable-next-line @typescript-eslint/require-await
      async create(): Promise<unknown> {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                findings: [
                  {
                    rule: "r",
                    severity: "low",
                    blocking: false,
                    location: { pullRequestLevel: false, path, line: 1, side: "RIGHT" },
                    description: "d",
                  },
                ],
                verdict: "approve",
                replyJudgements: [],
              }),
            },
          ],
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      },
    };
  }

  it("records location.rejected when the real adapter refuses a path", async () => {
    // Substituting `model` would test neither the adapter nor this wiring. Deleting the
    // `onRejectedLocation` argument in the root must fail a test, and this is that test.
    const records: string[] = [];
    const logger = createLogger({ runId: "run-wiring", write: (line) => records.push(line) });

    const { model: _unused, ...withoutModel } = stubs(emptyCalls(), { logger });
    const adapters = await composeService({
      ...withoutModel,
      messages: messagesReturning("../../etc/passwd"),
      graphqlClient: noThreads(),
    });

    await reviewPullRequest(adapters, 7, { runId: "run-wiring" });

    const rejected = records
      .map((line) => JSON.parse(line) as { event: string; location?: unknown })
      .filter((record) => record.event === "location.rejected");

    // One per role: both reviewers call the model, and both are handed the same bad location.
    expect(rejected).toHaveLength(2);
    for (const record of rejected) {
      expect(record.location).toEqual({
        path: "../../etc/passwd",
        reason: "path is empty, rooted, or contains a `..` segment",
      });
    }
  });

  it("says nothing when the adapter accepts the path", async () => {
    const records: string[] = [];
    const logger = createLogger({ runId: "run-wiring", write: (line) => records.push(line) });

    const { model: _unused, ...withoutModel } = stubs(emptyCalls(), { logger });
    const adapters = await composeService({
      ...withoutModel,
      messages: messagesReturning("src/cli.ts"),
      graphqlClient: noThreads(),
    });

    await reviewPullRequest(adapters, 7, { runId: "run-wiring" });

    expect(
      records
        .map((line) => JSON.parse(line) as { event: string })
        .filter((r) => r.event === "location.rejected"),
    ).toEqual([]);
  });
});

describe("the daemon's heartbeat (Principle VII)", () => {
  /** Runs exactly one tick body: `runDaemon` consults `running()` once to enter and once to loop. */
  function oneTick(): () => boolean {
    let calls = 0;

    return () => {
      calls += 1;

      return calls === 1;
    };
  }

  /** Adapters from the root, with the two reads a tick makes replaced. */
  async function adaptersListing(
    listing: { pullRequests: OpenPullRequest[] | null; etag: string | null },
    // Typed rather than `unknown[]`: the predicate reads these fields, and a cast here would keep
    // the file compiling while the stub drifted away from what the daemon actually consumes.
    gateRuns: (ref: string) => CheckRunSummary[] = () => [],
  ) {
    const base = await composeService({
      ...stubs(emptyCalls(), { logger: sharedLogger }),
      graphqlClient: noThreads(),
    });

    return {
      ...base,
      listOpenPullRequests: () => Promise.resolve(listing),
      checkRuns: {
        ...base.checkRuns,
        listForRef: (params: { ref: string }) => Promise.resolve(gateRuns(params.ref)),
      },
    };
  }

  /** Slot directories this block created, removed when it finishes rather than left in TMPDIR. */
  const slotDirectories: string[] = [];

  function slotsDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "slots-"));
    slotDirectories.push(directory);

    return directory;
  }

  afterAll(() => {
    for (const directory of slotDirectories) rmSync(directory, { recursive: true, force: true });
  });

  /** A concluded, passing gate run for `ref`. Complete, so the predicate reads real fields. */
  function passingGateRun(ref: string): CheckRunSummary {
    return {
      id: 1,
      name: MERGE_GATE_CHECK_NAME,
      headSha: ref,
      status: "completed",
      conclusion: "success",
      completedAt: "2026-09-01T00:00:00Z",
      output: { title: "Independent review passed", text: null },
    };
  }

  let records: string[] = [];
  let sharedLogger = createLogger({ runId: "run-daemon", write: () => undefined });

  function capture() {
    records = [];
    sharedLogger = createLogger({ runId: "run-daemon", write: (line) => records.push(line) });
  }

  function heartbeats() {
    return records
      .map((line) => JSON.parse(line) as { event: string; tick?: Record<string, unknown> })
      .filter((record) => record.event === "tick.completed");
  }

  it("omits an unchanged skip list on the next tick, and keeps the counts", async () => {
    capture();
    // Three tick bodies over the same steady set; the first two are what this asserts. The counts prove the loop is alive on both; repeating
    // the identical list into the record stream every tick is disk spent on nothing (Principle IV).
    const adapters = await adaptersListing(
      { pullRequests: [{ number: 31, headSha: "e".repeat(40) }], etag: 'W/"steady"' },
      (ref) => [passingGateRun(ref)],
    );

    let ticks = 0;

    await runDaemon({
      target: TARGET,
      compose: () => Promise.resolve(adapters),
      running: () => {
        ticks += 1;

        return ticks <= 3;
      },
      sleep: () => Promise.resolve(),
    });

    const [first, second] = heartbeats();

    expect(first?.tick).toEqual({
      unchanged: false,
      considered: 1,
      selected: 0,
      skipped: [{ pullRequest: 31, reason: "gate-run-did-not-fail" }],
    });
    // Same set, so the list is not repeated -- but the heartbeat still fires.
    expect(second?.tick).toEqual({ unchanged: false, considered: 1, selected: 0 });
  });

  it("writes the list again when the set actually changes", async () => {
    capture();
    // Suppression firing was tested; suppression *releasing* was not. Inverting the comparison, or
    // assigning `lastSkipped` before it, would suppress the list forever after the first tick and
    // every other test here would still pass.
    let tick = 0;
    const listings = [
      { pullRequests: [{ number: 41, headSha: "a".repeat(40) }], etag: 'W/"one"' },
      {
        pullRequests: [
          { number: 41, headSha: "a".repeat(40) },
          { number: 42, headSha: "b".repeat(40) },
        ],
        etag: 'W/"two"',
      },
    ];

    const base = await composeService({
      ...stubs(emptyCalls(), { logger: sharedLogger }),
      graphqlClient: noThreads(),
    });
    const adapters = {
      ...base,
      listOpenPullRequests: () => {
        tick += 1;

        return Promise.resolve(
          listings[Math.min(tick, listings.length) - 1] as (typeof listings)[0],
        );
      },
      checkRuns: {
        ...base.checkRuns,
        listForRef: (params: { ref: string }) => Promise.resolve([passingGateRun(params.ref)]),
      },
    };

    let calls = 0;

    await runDaemon({
      target: TARGET,
      compose: () => Promise.resolve(adapters),
      running: () => {
        calls += 1;

        return calls <= 3;
      },
      sleep: () => Promise.resolve(),
    });

    const [first, second] = heartbeats();

    expect(first?.tick).toMatchObject({
      skipped: [{ pullRequest: 41, reason: "gate-run-did-not-fail" }],
    });
    expect(second?.tick).toMatchObject({
      considered: 2,
      skipped: [
        { pullRequest: 41, reason: "gate-run-did-not-fail" },
        { pullRequest: 42, reason: "gate-run-did-not-fail" },
      ],
    });
  });

  it("leaves the remembered set alone on a 304, which examined nothing", async () => {
    capture();
    // A `304` learned nothing about what is being skipped. Recording an empty signature would both
    // claim `skipped: []` falsely and reset suppression, making the next changed tick look
    // identical to the one before it. Five tick bodies run; the first three are what this asserts.
    const steady = { pullRequests: [{ number: 51, headSha: "c".repeat(40) }], etag: 'W/"s"' };
    const responses = [steady, { pullRequests: null, etag: 'W/"s"' }, steady];
    let index = 0;

    const base = await composeService({
      ...stubs(emptyCalls(), { logger: sharedLogger }),
      graphqlClient: noThreads(),
    });
    const adapters = {
      ...base,
      listOpenPullRequests: () => {
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;

        return Promise.resolve(response as (typeof responses)[0]);
      },
      checkRuns: {
        ...base.checkRuns,
        listForRef: (params: { ref: string }) => Promise.resolve([passingGateRun(params.ref)]),
      },
    };

    let calls = 0;

    await runDaemon({
      target: TARGET,
      compose: () => Promise.resolve(adapters),
      running: () => {
        calls += 1;

        return calls <= 5;
      },
      sleep: () => Promise.resolve(),
    });

    const [first, unchanged, third] = heartbeats();

    expect(first?.tick).toMatchObject({ skipped: [{ pullRequest: 51 }] });
    // The 304 reports what it saw -- nothing -- and does not claim the set is now empty.
    expect(unchanged?.tick).toEqual({ unchanged: true, considered: 0, selected: 0 });
    // And the set it never learned about is still remembered, so this is still a repeat.
    expect(third?.tick).toEqual({ unchanged: false, considered: 1, selected: 0 });
  });

  it("records the 304 tick, which is the case that motivates the heartbeat", async () => {
    // The idling daemon answers `304` tick after tick. That path carries the `unchanged` field and
    // is the reason the record is claimed to cost nothing against FR-040, and it was untested.
    capture();
    const adapters = await adaptersListing({ pullRequests: null, etag: 'W/"unchanged"' });

    await runDaemon({
      target: TARGET,
      compose: () => Promise.resolve(adapters),
      running: oneTick(),
      sleep: () => Promise.resolve(),
    });

    expect(heartbeats()).toHaveLength(1);
    // No `skipped`: a 304 examined no listing, so it reports what it saw rather than asserting that
    // nothing is being passed over.
    expect(heartbeats()[0]?.tick).toEqual({ unchanged: true, considered: 0, selected: 0 });
  });

  it("reports one skip entry per passed-over pull request, with its reason", async () => {
    capture();
    // Both have a concluded, passing gate run for their head, so both are skipped without a
    // thread read -- which exercises the projection and the reason strings the document lists.
    const adapters = await adaptersListing(
      {
        pullRequests: [
          { number: 11, headSha: "a".repeat(40) },
          { number: 12, headSha: "b".repeat(40) },
        ],
        etag: 'W/"listing"',
      },
      (ref) => [passingGateRun(ref)],
    );

    await runDaemon({
      target: TARGET,
      compose: () => Promise.resolve(adapters),
      running: oneTick(),
      sleep: () => Promise.resolve(),
    });

    expect(heartbeats()[0]?.tick).toEqual({
      unchanged: false,
      considered: 2,
      selected: 0,
      skipped: [
        { pullRequest: 11, reason: "gate-run-did-not-fail" },
        { pullRequest: 12, reason: "gate-run-did-not-fail" },
      ],
    });
  });

  it("counts a selection as well as a skip, so `selected` is observed non-zero", async () => {
    capture();
    // One pull request with no gate run for its head (selected under clause (a)) and one with a
    // concluded passing run (skipped). Every other test asserts `selected: 0`, so a heartbeat that
    // hard-wired that field, or read the wrong collection, would still pass all of them.
    const selectedSha = "c".repeat(40);
    const adapters = await adaptersListing(
      {
        pullRequests: [
          { number: 21, headSha: selectedSha },
          { number: 22, headSha: "d".repeat(40) },
        ],
        etag: 'W/"mixed"',
      },
      (ref) => (ref === selectedSha ? [] : [passingGateRun(ref)]),
    );

    await runDaemon({
      target: TARGET,
      compose: () => Promise.resolve(adapters),
      running: oneTick(),
      sleep: () => Promise.resolve(),
      // A selected pull request is actually run, and running one takes a host lease from a
      // directory shared by every agent on the machine. Redirected so the test neither depends on
      // that directory nor competes with anything else holding a slot in it.
      env: { XDG_STATE_HOME: slotsDirectory() },
    });

    expect(heartbeats()[0]?.tick).toEqual({
      unchanged: false,
      considered: 2,
      selected: 1,
      skipped: [{ pullRequest: 22, reason: "gate-run-did-not-fail" }],
    });
  });
});
