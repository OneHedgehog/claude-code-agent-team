import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateSettings, type LoadedSettings } from "../../src/config/settings.js";

import {
  anchoredFinding,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  response,
  runReview,
  script,
  type FixtureClient,
} from "./harness/index.js";

/**
 * Quickstart scenario 17 (tasks.md T090): the platform allowance is paused for, not failed on
 * (FR-040, SC-016).
 *
 * Every other budget in this service hard-stops, and this one must not, for a reason worth stating
 * plainly: the platform allowance costs nothing and **refills on a documented reset**. Failing a
 * pull request because the hour's requests ran out would report a review result for a scheduling
 * fact, and the author would have to push a commit to clear a gate that would have cleared itself.
 * So reaching the reserve stops further calls, tells a human, and leaves the gate *unreported* —
 * never success, never neutral, never skipped — and the next run resumes.
 *
 * **How the condition is produced.** `platformApiReserve` is a threshold on the allowance
 * *remaining*, so the condition "the reserve has been reached" is a comparison between a setting
 * and a live figure read from GitHub. This scenario moves the setting rather than the figure: it
 * raises the reserve above the allowance the installation actually has left. Draining four
 * thousand requests to arrive at the same comparison would take an hour, cost the rest of the
 * suite its allowance, and prove exactly the same thing.
 *
 * That is a configuration change, not a substitution: the reserve is read from settings in
 * production too, the remaining figure is genuinely GitHub's, and the comparison the service makes
 * is untouched. `ScriptedModelClient` remains the only thing replaced (R-015).
 *
 * The three rounds are the requirement in order: a round that posts a finding, a round that pauses
 * without reporting or reposting anything, and a round after the allowance restores that finishes
 * the job and — the assertion that matters most — does **not** post the standing finding a second
 * time. A service that resumed by reposting would turn every rate-limit pause into a duplicate
 * comment, which is how a reviewer stops being read.
 */

/** The fixture's settings with the platform-allowance knobs replaced, validated for real. */
function withAllowance(
  text: string,
  overrides: {
    platformApiBudget: number;
    platformApiReserve: number;
    maxRateLimitWaitSeconds?: number;
  },
): LoadedSettings {
  const parsed = JSON.parse(text) as { reviewService: Record<string, unknown> };

  return validateSettings({
    ...parsed,
    reviewService: {
      ...parsed.reviewService,
      platformApiBudget: overrides.platformApiBudget,
      platformApiReserve: overrides.platformApiReserve,
      ...(overrides.maxRateLimitWaitSeconds === undefined
        ? {}
        : { maxRateLimitWaitSeconds: overrides.maxRateLimitWaitSeconds }),
    },
  });
}

/**
 * A reserve set above any allowance GitHub grants an installation, so the comparison the service
 * makes against the live figure can only come out one way.
 */
const RESERVE_ABOVE_ANY_ALLOWANCE = { platformApiBudget: 1_000_000, platformApiReserve: 999_999 };

describe("the platform allowance", () => {
  let client: FixtureClient;
  let settingsText: string;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
    settingsText = await client.readBaseFile(".agents/settings.json");
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("pauses unreported at the reserve, then resumes without reposting (scenario 17)", async () => {
    const [source, tests, document] = await Promise.all([
      client.readBaseFile("src/greeting.js"),
      client.readBaseFile("tests/greeting.test.js"),
      client.readBaseFile("docs/greeting.md"),
    ]);

    const anchorLine = source.split("\n").length;
    const standing = script({
      security: response([
        anchoredFinding("src/greeting.js", anchorLine, { rule: "finding-across-the-pause" }),
      ]),
    });

    const pullRequest = await client.openPullRequest({
      label: "scenario-17-rate-limit",
      title: "A change reviewed across a rate-limit pause",
      body: "Staged for scenario 17.",
      files: [
        { path: "src/greeting.js", content: `${source}\nexport const PAUSED = 1;\n` },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("the constant is exported", () => {\n  assert.equal(PAUSED, 1);\n});\n`,
        },
        { path: "docs/greeting.md", content: `${document}\nThe module exports a constant.\n` },
      ],
    });

    // ---- Round one: an ordinary review that posts one blocking finding. ----

    const round1 = await runReview({ client, pullRequest, script: standing });
    expect(round1.outcome.gate.conclusion).toBe("failure");

    const posted = await client.readOwnFindings(pullRequest.number);
    expect(posted).toHaveLength(1);
    const findingId = posted[0]?.findingId;
    expect(findingId).toBeDefined();

    // ---- Round two: the reserve is reached, and the run pauses. ----

    const revised = await client.pushRevision(
      pullRequest,
      [{ path: "src/greeting.js", content: `${source}\nexport const PAUSED = 2;\n` }],
      "revise while the allowance is short",
    );

    const paused = await runReview({
      client,
      pullRequest: revised,
      script: standing,
      settings: withAllowance(settingsText, RESERVE_ABOVE_ANY_ALLOWANCE),
    });

    // Stopped before spending: the allowance is checked before the work that consumes it.
    expect(paused.outcome.stoppedBeforeSpending).toBe(true);
    expect(paused.model.received).toHaveLength(0);

    // Unreported — the one non-failing outcome in the system, and never success or neutral.
    expect(paused.outcome.gate.conclusion).toBe("unreported");
    await client.expectGateUnreported(revised.headSha);

    expect(
      paused.records.filter(
        (record) => (record as { event: string }).event === "platform.reserve_reached",
      ),
    ).toHaveLength(1);

    // A human is told it is waiting, on both surfaces. A pause nobody hears about is a stop.
    const escalation = await client.awaitEscalation(pullRequest.number, "platform.rate_limit");
    expect(escalation.statedOnPullRequest).toBe(true);

    // Nothing was posted while paused: the thread count is exactly what round one left.
    expect(await client.readOwnFindings(pullRequest.number)).toHaveLength(1);

    // ---- Round three: the allowance is back, and the run finishes. ----

    const resumed = await runReview({ client, pullRequest: revised, script: standing });

    expect(resumed.outcome.stoppedBeforeSpending).toBe(false);
    expect(resumed.model.requestsFor("security")).toHaveLength(1);

    // The standing finding kept its identity across the pause and was **not** posted again.
    expect(
      resumed.records.filter((record) => (record as { event: string }).event === "finding.posted"),
    ).toHaveLength(0);

    const threads = await client.readOwnFindings(pullRequest.number);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.findingId).toBe(findingId);

    const concluded = await client.awaitGateConclusion(revised.headSha);
    expect(concluded.conclusion).toBe("failure");
  });

  it("fails the gate when the wait would exceed the configured maximum (scenario 17)", async () => {
    const source = await client.readBaseFile("src/greeting.js");

    const pullRequest = await client.openPullRequest({
      label: "scenario-17-wait-too-long",
      title: "A change whose rate-limit wait is longer than allowed",
      body: "Staged for scenario 17's bounded-wait half.",
      files: [{ path: "src/greeting.js", content: `${source}\nexport const IMPATIENT = true;\n` }],
    });

    // The same reserve, with a maximum wait of one second. The reset is minutes away at worst and
    // an hour away at best, so the wait cannot fit inside it — which is the one case FR-040 says
    // fails the gate rather than waiting.
    const run = await runReview({
      client,
      pullRequest,
      script: script(),
      settings: withAllowance(settingsText, {
        ...RESERVE_ABOVE_ANY_ALLOWANCE,
        maxRateLimitWaitSeconds: 1,
      }),
    });

    expect(run.outcome.stoppedBeforeSpending).toBe(true);
    expect(run.model.received).toHaveLength(0);

    // Failure, not `unreported`: waiting is no longer an option, so the gate says so.
    expect(run.outcome.gate.conclusion).toBe("failure");

    const escalation = await client.awaitEscalation(pullRequest.number, "platform.rate_limit");
    expect(escalation.statedOnPullRequest).toBe(true);
  });
});
