import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseArgs } from "../../src/cli.js";

import {
  composeService,
  estimateReviewTokens,
  ledgerPath,
  reviewPullRequest,
  type ComposeOptions,
} from "../../src/composition.js";
import { createTarget } from "../../src/config/target.js";
import { REQUIRED_INSTALLATION_PERMISSIONS } from "../../src/github/auth.js";
import { checkPrerequisites } from "../../src/review/prerequisites.js";
import { MERGE_GATE_CHECK_NAME } from "../../src/github/check-run.js";
import { InMemoryLedgerStore, createLedger } from "../../src/ledger/tokens.js";
import { validateSettings, type LoadedSettings } from "../../src/config/settings.js";
import { MAX_OUTPUT_TOKENS } from "../../src/model/anthropic.js";
import { createLogger } from "../../src/observability/logger.js";
import type { ModelClient, ReviewResponse } from "../../src/model/client.js";
import { AgentSdkModelClient } from "../../src/model/agent-sdk.js";

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
/**
 * The repository's own settings, with the transport pinned to `api`.
 *
 * These tests exercise the credential-resolving path and the adapter the root builds from it, which
 * is a different transport from the one this repository happens to operate on today. Reading the
 * file keeps the budgets and caps honest; pinning the transport keeps an operational choice from
 * silently changing what is under test.
 */
const SETTINGS: LoadedSettings = (() => {
  const file = JSON.parse(readFileSync(`${process.cwd()}/.agents/settings.json`, "utf8")) as Record<
    string,
    Record<string, unknown>
  >;

  return validateSettings({
    ...file,
    reviewService: { ...file["reviewService"], modelTransport: "api" },
  });
})();

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
    // Pinned, so the repository's own operational transport cannot change what these tests build.
    settings: SETTINGS,
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

describe("both transports are composed, whichever one the repository operates on", () => {
  /** The repository's own settings with the transport named explicitly, rather than read. */
  function settingsFor(modelTransport: "api" | "agent-sdk"): LoadedSettings {
    const file = JSON.parse(
      readFileSync(`${process.cwd()}/.agents/settings.json`, "utf8"),
    ) as Record<string, Record<string, unknown>>;

    return validateSettings({
      ...file,
      reviewService: { ...file["reviewService"], modelTransport },
    });
  }

  /**
   * Composes with no credential reachable anywhere, and reports what was built.
   *
   * Parameterised rather than branching on the settings file. An earlier revision read the file and
   * asserted one thing under `agent-sdk` and another under `api`, which meant neither branch was
   * guaranteed to run: flipping the setting silently returned the other path to zero coverage, with
   * a green suite. Both cases run here on every checkout, whatever the file says.
   */
  async function composedWith(modelTransport: "api" | "agent-sdk") {
    const { model: _substituted, ...withoutModel } = stubs(emptyCalls(), {
      settings: settingsFor(modelTransport),
    });

    let keychainReads = 0;

    const adapters = await composeService({
      ...withoutModel,
      graphqlClient: noThreads(),
      readKeychain: () => {
        keychainReads += 1;

        return null;
      },
      env: { HOME: "/tmp/does-not-exist", ANTHROPIC_CONFIG_DIR: "/tmp/does-not-exist" },
    });

    return { adapters, keychainReads };
  }

  it("builds the agent client on agent-sdk, and never looks for a credential", async () => {
    const { adapters, keychainReads } = await composedWith("agent-sdk");

    // The specific class, not merely "something was built". `expect(model).toBeDefined()` is
    // satisfied by `unavailableModel` too, and so distinguishes none of the three constructions.
    expect(adapters.model).toBeInstanceOf(AgentSdkModelClient);
    // No credential is resolved on this path -- the harness authenticates itself -- so FR-051 must
    // see a source rather than an absence, or every run would stop on a missing credential.
    expect(adapters.modelCredential).toEqual({ source: "agent-sdk", apiKey: null });
    expect(keychainReads).toBe(0);
  });

  it("resolves a credential on api, and stops when there is none", async () => {
    const { adapters, keychainReads } = await composedWith("api");

    expect(adapters.model).not.toBeInstanceOf(AgentSdkModelClient);
    expect(adapters.modelCredential).toBeNull();
    expect(keychainReads).toBeGreaterThan(0);
  });

  it("passes the prerequisite check on the agent transport, which holds no credential", () => {
    // The credential check exists so an absent one costs zero tokens (FR-051). A transport that
    // needs no credential must not read as an absent one, or it would stop every run.
    const result = checkPrerequisites({
      granted: Object.fromEntries(
        Object.entries(REQUIRED_INSTALLATION_PERMISSIONS).map(([name, level]) => [name, level]),
      ),
      protection: { kind: "protected", requiredContexts: [MERGE_GATE_CHECK_NAME] },
      gateName: MERGE_GATE_CHECK_NAME,
      baseBranch: "main",
      modelCredential: { source: "agent-sdk", apiKey: null },
    });

    expect(result.modelCredentialPresent).toBe(true);
    expect(result.satisfied).toBe(true);
  });
});
