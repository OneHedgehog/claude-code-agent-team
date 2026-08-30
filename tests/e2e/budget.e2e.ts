import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateSettings, type LoadedSettings } from "../../src/config/settings.js";

import {
  bothApprove,
  createFixtureClient,
  fixtureEnvironment,
  ledgerDrawnToReviewerReserve,
  ledgerExhausted,
  requireFixtureEnvironment,
  runReview,
  type FixtureClient,
} from "./harness/index.js";

/**
 * Quickstart scenarios 14 and 15 (tasks.md T087): the budget, and the reserve inside it (FR-031,
 * FR-047, SC-009, SC-022).
 *
 * These two are a matched pair, and reading either alone gets the reserve backwards. Scenario 14 is
 * the ordinary budget stop: nothing is left, so nothing is spent and the gate fails before the
 * model is called. Scenario 15 is the case the reserve exists for — the budget is drawn down to the
 * reserve **by other agents**, and the review runs anyway.
 *
 * The word "anyway" is the requirement. Without a reserve, any other agent on the repository could
 * leave a pull request ungated simply by spending first, and it would do so silently: the reviewer
 * would stop with a perfectly truthful "budget exhausted" and the pull request would sit unreviewed
 * because somebody else's job was busy. FR-047 makes that unreachable by making `review` the one
 * actor permitted to draw into the last slice.
 *
 * So scenario 15's ledger is drawn down by a **non-review** actor, and the harness refuses to build
 * it any other way: an identical total spent by the reviewer itself would exercise the reserve from
 * the one actor allowed into it and prove nothing at all.
 *
 * Both ledgers are real `Ledger` instances over real entries, checked by the real `check()`. The
 * substitution is the *store*, not the accounting — spending twenty million tokens to arrive at the
 * condition would be an odd way to test that the service declines to spend them.
 */

describe("budgets and the reviewer reserve", () => {
  let client: FixtureClient;
  let loaded: LoadedSettings;
  let slug: string;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));

    // The fixture's own settings, read from the fixture and validated by the real loader, so the
    // budgets these ledgers are drawn against are the ones the run will actually check.
    loaded = validateSettings(JSON.parse(await client.readBaseFile(".agents/settings.json")));
    slug = `${client.environment.repository.owner}/${client.environment.repository.name}`;
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("stops before spending when the budget is exhausted (scenario 14)", async () => {
    const source = await client.readBaseFile("src/greeting.js");

    const pullRequest = await client.openPullRequest({
      label: "scenario-14-exhausted",
      title: "A change reviewed against an exhausted budget",
      body: "Staged for scenario 14.",
      files: [{ path: "src/greeting.js", content: `${source}\nexport const EXHAUSTED = true;\n` }],
    });

    const run = await runReview({
      client,
      pullRequest,
      script: bothApprove(),
      ledger: ledgerExhausted(loaded.settings, slug),
    });

    // Stopped *before* spending, not partway through. A budget check that fired after the first
    // role would overspend by a role every time it fired.
    expect(run.outcome.stoppedBeforeSpending).toBe(true);
    expect(run.outcome.tokensConsumed).toBe(0);
    expect(run.model.received).toHaveLength(0);

    expect(run.outcome.gate.conclusion).toBe("failure");
    expect(await client.listGateRuns(pullRequest.headSha)).toHaveLength(0);
    expect(await client.readReviewStates(pullRequest.number)).toHaveLength(0);

    expect(
      run.records.filter((record) => (record as { event: string }).event === "budget.exhausted"),
    ).toHaveLength(1);

    const escalation = await client.awaitEscalation(pullRequest.number, "budget.exhausted");
    expect(escalation.statedOnPullRequest).toBe(true);
    expect(escalation.issue.labels).toContain("escalation");
  });

  it("still reviews when other agents have drawn the budget to the reserve (scenario 15)", async () => {
    const [source, tests, document] = await Promise.all([
      client.readBaseFile("src/greeting.js"),
      client.readBaseFile("tests/greeting.test.js"),
      client.readBaseFile("docs/greeting.md"),
    ]);

    const pullRequest = await client.openPullRequest({
      label: "scenario-15-reserve",
      title: "A change reviewed from the reviewer reserve alone",
      body: "Staged for scenario 15.",
      files: [
        { path: "src/greeting.js", content: `${source}\nexport const RESERVED = true;\n` },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("the flag is exported", () => {\n  assert.equal(RESERVED, true);\n});\n`,
        },
        { path: "docs/greeting.md", content: `${document}\nThe module exports a flag.\n` },
      ],
    });

    const ledger = ledgerDrawnToReviewerReserve(loaded.settings, slug);

    // The premise: everything outside the reserve is already gone, and none of it was the
    // reviewer's. An `implementer` entry is what makes this FR-047's case rather than FR-031's.
    expect(ledger.total("tokens")).toBe(
      loaded.settings.tokenBudget - loaded.settings.reviewerTokenReserve,
    );
    expect(ledger.entries().every((entry) => entry.actor !== "review")).toBe(true);

    const run = await runReview({ client, pullRequest, script: bothApprove(), ledger });

    // The review ran. Both roles were asked, and the reserve is what paid for it.
    expect(run.outcome.stoppedBeforeSpending).toBe(false);
    expect(run.model.requestsFor("security")).toHaveLength(1);
    expect(run.model.requestsFor("implementation")).toHaveLength(1);
    expect(run.outcome.tokensConsumed).toBeGreaterThan(0);

    // And the pull request is gated: the point of the reserve is a reported gate, not a run.
    expect(run.outcome.gate.conclusion).toBe("success");
    expect((await client.awaitGateConclusion(pullRequest.headSha)).conclusion).toBe("success");

    // The reviewer's own spend came out of the reserve, so the total now exceeds what every other
    // actor together was allowed.
    expect(ledger.total("tokens")).toBeGreaterThan(
      loaded.settings.tokenBudget - loaded.settings.reviewerTokenReserve,
    );

    expect(await client.readEscalationCauses(pullRequest.number)).not.toContain("budget.exhausted");
  });
});
