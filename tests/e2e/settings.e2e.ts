import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SettingsError } from "../../src/config/settings.js";

import {
  bothApprove,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  runReview,
  type FixtureClient,
} from "./harness/index.js";

/**
 * Quickstart scenario 28 (tasks.md T109): the three ways a settings file can differ from the one
 * this service wrote down, and the three different answers (FR-050, FR-054).
 *
 * `.agents/settings.json` is shared by every agent working on the repository, and the asymmetry
 * that makes that workable is easy to state and easy to get backwards:
 *
 *   - a **sibling agent's section** is ignored. It is not this service's to validate, and a service
 *     that rejected it would make adding a second agent a breaking change to the first;
 *   - an **unrecognized key inside `reviewService`** stops the run. A typo in a budget and a
 *     setting that was never applied are indistinguishable from the outside, and the one that
 *     matters — a budget silently ignored — looks exactly like everything working;
 *   - an **absent optional setting** takes its documented default *and reports it*, so a value
 *     nobody chose is still a value everybody can see.
 *
 * All three are driven through the real file: the settings under test ship in the pull request, so
 * the run reads them from the target's checkout exactly as it does in production rather than from
 * an object a test handed it.
 */

/** The fixture's settings with a sibling agent's section added and `modelEffort` still absent. */
function withSibling(text: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;

  return `${JSON.stringify(
    { ...parsed, orchestrator: { humanApprovalRequired: true, maxParallelTasks: 3 } },
    null,
    2,
  )}\n`;
}

/** The same file with a plausible typo inside this service's own section. */
function withUnknownOwnKey(text: string): string {
  const parsed = JSON.parse(text) as { reviewService: Record<string, unknown> };

  return `${JSON.stringify(
    {
      ...parsed,
      reviewService: { ...parsed.reviewService, tokenBudgt: 20_000_000 },
    },
    null,
    2,
  )}\n`;
}

describe("shared settings", () => {
  let client: FixtureClient;
  let settingsText: string;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
    settingsText = await client.readBaseFile(".agents/settings.json");
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("ignores a sibling section and applies the documented default (scenario 28)", async () => {
    const [tests, document] = await Promise.all([
      client.readBaseFile("tests/greeting.test.js"),
      client.readBaseFile("docs/greeting.md"),
    ]);

    // The premise: `modelEffort` really is absent from the file, so the value the run reports is a
    // default rather than a setting.
    const parsed = JSON.parse(settingsText) as { reviewService: Record<string, unknown> };
    expect(parsed.reviewService["modelEffort"]).toBeUndefined();

    const pullRequest = await client.openPullRequest({
      label: "scenario-28-sibling",
      title: "Add a sibling agent's settings section",
      body: "Staged for scenario 28. A test and a document ship with the change.",
      files: [
        { path: ".agents/settings.json", content: withSibling(settingsText) },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("the fixture still greets", () => {\n  assert.equal(typeof greet("a"), "string");\n});\n`,
        },
        {
          path: "docs/greeting.md",
          content: `${document}\nA sibling agent's settings sit beside this service's.\n`,
        },
      ],
    });

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    // The sibling section neither stopped the run nor reached this service's settings.
    expect(run.outcome.stoppedBeforeSpending).toBe(false);
    expect(run.adapters.settings.settings).not.toHaveProperty("humanApprovalRequired");
    expect(run.adapters.settings.host.maxConcurrentAgents).toBe(2);

    // The documented default was applied, and is reported as the effective value (FR-054).
    expect(run.adapters.settings.settings.modelEffort).toBe("high");
    expect(run.adapters.settings.effectiveOptionalSettings["modelEffort"]).toBe("high");

    // Reported all the way down: the roles were actually asked at that effort, so the reported
    // value is the one in force rather than a label beside it.
    expect(run.model.received).toHaveLength(2);
    expect(run.model.received.every((request) => request.effort === "high")).toBe(true);

    // `escalationChannel.label` is the other optional setting, and it is defaulted the same way.
    expect(run.adapters.settings.effectiveOptionalSettings["escalationChannel.label"]).toBe(
      run.adapters.settings.settings.escalationChannel.label,
    );

    expect(run.outcome.gate.conclusion).toBe("success");
  });

  it("stops the run on an unrecognized key inside its own section (scenario 28)", async () => {
    const pullRequest = await client.openPullRequest({
      label: "scenario-28-typo",
      title: "Introduce a typo in a budget setting",
      body: "Staged for scenario 28's refusal.",
      files: [{ path: ".agents/settings.json", content: withUnknownOwnKey(settingsText) }],
    });

    // The run does not start at all: settings are read while the service is being composed, which
    // is ahead of every platform write as well as every model call.
    const failure = await runReview({ client, pullRequest, script: bothApprove() }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SettingsError);
    expect((failure as SettingsError).problems.join("; ")).toContain("tokenBudgt");

    // Nothing was written anywhere: no gate opened, no review submitted, nothing spent.
    expect(await client.listGateRuns(pullRequest.headSha)).toHaveLength(0);
    expect(await client.readReviewStates(pullRequest.number)).toHaveLength(0);
  });
});
