import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseRoundRecord } from "../../src/review/round-history.js";

import {
  bothApprove,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  runReview,
  seedConcludedRound,
  seedCrashedRound,
  type FixtureClient,
} from "./harness/index.js";

/**
 * Quickstart scenarios 11 and 12 (tasks.md T089): what counts as a failed round, and what does not
 * (FR-020, FR-046, SC-020).
 *
 * The loop has to be bounded *and* has to make progress, and these two scenarios are the boundary
 * between them read from both sides. Re-triggering a review on an unchanged revision with no reply
 * is a round that cannot reach a new conclusion — running it would spend tokens to restate a
 * verdict already recorded — so it stops. But a round that *started and never concluded* is not
 * that: a crashed process, a killed run, a budget stop partway through. Counting it as a failed
 * round would escalate on a stalled author who does not exist.
 *
 * That is why `concluded` is a field on the round record rather than an inference from a check run
 * existing, and why these two scenarios differ in exactly one boolean. Both seed a real prior check
 * run written by the App — the only identity that can write one — and the service reads its own
 * history back from GitHub rather than from anything local, which is what makes the recovery in
 * scenario 12 a real recovery.
 */

describe("forward progress", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("stops before re-reviewing when nothing has changed since the last round (scenario 11)", async () => {
    const source = await client.readBaseFile("src/greeting.js");

    const pullRequest = await client.openPullRequest({
      label: "scenario-11-no-progress",
      title: "A change re-triggered with nothing new",
      body: "Staged for scenario 11.",
      files: [{ path: "src/greeting.js", content: `${source}\nexport const STALLED = true;\n` }],
    });

    // A round that really concluded, on this exact revision, written by the App. Nothing is pushed
    // and nothing is replied to after it — which is the whole condition.
    const baseline = await seedConcludedRound(client, pullRequest);
    expect(baseline.concluded).toBe(true);
    expect(baseline.headSha).toBe(pullRequest.headSha);

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    expect(run.outcome.stoppedBeforeSpending).toBe(true);
    expect(run.outcome.tokensConsumed).toBe(0);
    expect(run.model.received).toHaveLength(0);

    expect(run.outcome.gate.conclusion).toBe("failure");
    expect(await client.readReviewStates(pullRequest.number)).toHaveLength(0);

    // The seeded round is still the only check run on the revision: the stop opened no new gate.
    expect(await client.listGateRuns(pullRequest.headSha)).toHaveLength(1);

    expect(
      run.records.filter(
        (record) => (record as { event: string }).event === "progress.no_forward_progress",
      ),
    ).toHaveLength(1);

    const escalation = await client.awaitEscalation(
      pullRequest.number,
      "progress.no_forward_progress",
    );
    expect(escalation.statedOnPullRequest).toBe(true);
  });

  it("proceeds after a round that started and never concluded (scenario 12)", async () => {
    const [source, tests, document] = await Promise.all([
      client.readBaseFile("src/greeting.js"),
      client.readBaseFile("tests/greeting.test.js"),
      client.readBaseFile("docs/greeting.md"),
    ]);

    const pullRequest = await client.openPullRequest({
      label: "scenario-12-crashed",
      title: "A change whose previous round crashed",
      body: "Staged for scenario 12.",
      files: [
        { path: "src/greeting.js", content: `${source}\nexport const RETRIED = true;\n` },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("the flag is exported", () => {\n  assert.equal(RETRIED, true);\n});\n`,
        },
        { path: "docs/greeting.md", content: `${document}\nThe module exports a flag.\n` },
      ],
    });

    // The same shape a crash leaves: a check run still `in_progress`, carrying an unconcluded
    // record. Identical to scenario 11's seed but for `concluded`.
    const crashed = await seedCrashedRound(client, pullRequest);
    expect(crashed.concluded).toBe(false);
    expect(await client.readRoundRecord(pullRequest.headSha)).not.toBeNull();

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    // Not a failed round. The review ran, both roles were asked, and the retry is round one —
    // there is no concluded round for it to be the second of.
    expect(run.outcome.stoppedBeforeSpending).toBe(false);
    expect(run.model.requestsFor("security")).toHaveLength(1);
    expect(run.model.requestsFor("implementation")).toHaveLength(1);

    expect(run.outcome.gate.conclusion).toBe("success");

    // Read from the *concluded* run rather than from whichever run GitHub lists first: the crashed
    // seed is still on the revision, and its record is exactly the one this assertion must not
    // accidentally read.
    const concluded = await client.awaitGateConclusion(pullRequest.headSha);
    expect(concluded.conclusion).toBe("success");

    const record = parseRoundRecord(concluded.output.text);
    expect(record?.concluded).toBe(true);
    // Round one, not round two: the crashed round is not a round the author failed to progress on.
    expect(record?.roundNumber).toBe(1);

    expect(await client.readEscalationCauses(pullRequest.number)).not.toContain(
      "progress.no_forward_progress",
    );
  });
});
