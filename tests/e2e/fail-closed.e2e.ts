import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ModelError } from "../../src/model/client.js";

import {
  bothApprove,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  runReview,
  type FixtureClient,
} from "./harness/index.js";

/**
 * Quickstart scenarios 13 and 16 (tasks.md T086, T088): the gate fails closed (FR-023, FR-037,
 * SC-002, SC-014).
 *
 * Three failures share one file because they are the same claim told three ways: **an inability to
 * review is never an approval.** They differ only in where the inability is discovered, and the
 * difference matters to what the run is allowed to have spent by then.
 *
 *   - An absent model credential is a *startup* condition. FR-051 puts it beside the permission and
 *     branch-protection checks precisely so it costs nothing — a credential discovered missing at
 *     the model call has already produced a `401` partway through a run, and an operator reading
 *     that has to work backwards from a stack trace to "nobody ran `ant auth login`".
 *   - An oversized diff is likewise pre-spend, and for a sharper reason: the spend it avoids is the
 *     largest one the service can make.
 *   - A model error mid-run is the one case where spending has already happened. Here the claim is
 *     the other half of FR-007: a role that produced no verdict records an explicit absence, and
 *     the gate reads that absence as a failure rather than as silence it may pass through.
 *
 * The first two therefore assert on what was *not* spent, and the third on what the gate concluded
 * despite having been opened. Only the third leaves a check run behind, because only the third got
 * as far as `reviewing`.
 */

/** Comfortably past the fixture's `maxReviewableDiffSize` of 2,000, and not near enough to be luck. */
const OVERSIZED_LINE_COUNT = 2_400;

describe("failing closed", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("fails with zero spend when no model credential is present (scenario 13)", async () => {
    const source = await client.readBaseFile("src/greeting.js");

    const pullRequest = await client.openPullRequest({
      label: "scenario-13-no-credential",
      title: "A change reviewed with no model credential available",
      body: "Staged for scenario 13.",
      files: [
        { path: "src/greeting.js", content: `${source}\nexport const CREDENTIALLESS = 1;\n` },
      ],
    });

    // `modelCredential: "absent"` redirects HOME to an empty one, so `~/.config/anthropic` really
    // is not there. The App credential is pinned back at the real directory, so this removes the
    // model credential and nothing else — the run still authenticates against GitHub.
    const run = await runReview({
      client,
      pullRequest,
      script: bothApprove(),
      modelCredential: "absent",
    });

    expect(run.adapters.modelCredential).toBeNull();

    expect(run.outcome.stoppedBeforeSpending).toBe(true);
    expect(run.outcome.tokensConsumed).toBe(0);
    expect(run.model.received).toHaveLength(0);

    expect(run.outcome.gate.conclusion).toBe("failure");
    expect(await client.listGateRuns(pullRequest.headSha)).toHaveLength(0);
    expect(await client.readReviewStates(pullRequest.number)).toHaveLength(0);

    const escalation = await client.awaitEscalation(pullRequest.number, "prerequisites.missing");
    expect(escalation.statedOnPullRequest).toBe(true);
  });

  it("fails with zero spend and a split reason when the diff is too large (scenario 16)", async () => {
    const generated = Array.from(
      { length: OVERSIZED_LINE_COUNT },
      (_unused, index) => `export const constant${index} = ${index};`,
    ).join("\n");

    const pullRequest = await client.openPullRequest({
      label: "scenario-16-oversized",
      title: "A change far past the reviewable diff size",
      body: "Staged for scenario 16.",
      // A path the fixture's `excludedPathPatterns` do not match, so every added line counts. An
      // excluded path would make the diff small by the measure that matters and prove nothing.
      files: [{ path: "src/generated-constants.js", content: `${generated}\n` }],
    });

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    // The largest spend the service could make is the one it declines to make.
    expect(run.outcome.stoppedBeforeSpending).toBe(true);
    expect(run.outcome.tokensConsumed).toBe(0);
    expect(run.model.received).toHaveLength(0);
    expect(run.adapters.ledger.total("tokens")).toBe(0);

    expect(run.outcome.gate.conclusion).toBe("failure");
    expect(await client.listGateRuns(pullRequest.headSha)).toHaveLength(0);
    expect(await client.readReviewStates(pullRequest.number)).toHaveLength(0);

    expect(
      run.records.filter(
        (record) => (record as { event: string }).event === "size.exceeds_reviewable",
      ),
    ).toHaveLength(1);

    const escalation = await client.awaitEscalation(pullRequest.number, "size.exceeds_reviewable");
    expect(escalation.statedOnPullRequest).toBe(true);
  });

  it("fails with no approving verdict when the model errors mid-run (scenario 13)", async () => {
    const [source, tests, document] = await Promise.all([
      client.readBaseFile("src/greeting.js"),
      client.readBaseFile("tests/greeting.test.js"),
      client.readBaseFile("docs/greeting.md"),
    ]);

    const pullRequest = await client.openPullRequest({
      label: "scenario-13-mid-run-error",
      title: "A change whose review fails partway through",
      body: "Staged for scenario 13's mid-run half.",
      files: [
        { path: "src/greeting.js", content: `${source}\nexport const ATTEMPTED = true;\n` },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("the flag is exported", () => {\n  assert.equal(ATTEMPTED, true);\n});\n`,
        },
        { path: "docs/greeting.md", content: `${document}\nThe module exports a flag.\n` },
      ],
    });

    // Both roles fail, so there is no approving verdict anywhere to be read as a pass. The usage is
    // non-zero because a model call that failed partway still consumed tokens, and a ledger that
    // under-counted those would let the failure path spend for free (FR-031).
    const interrupted = new ModelError("the model call failed partway through", {
      inputTokens: 500,
      outputTokens: 0,
    });

    const run = await runReview({
      client,
      pullRequest,
      script: { security: interrupted, implementation: interrupted },
    });

    // Not a pre-spend stop: this run reached `reviewing` and opened the gate.
    expect(run.outcome.stoppedBeforeSpending).toBe(false);

    const missing = run.records.filter(
      (record) => (record as { event: string }).event === "role.verdict_missing",
    );
    expect(missing).toHaveLength(2);

    // The absence is explicit rather than silent, and no role reported a verdict at all.
    expect(
      run.records.filter((record) => (record as { event: string }).event === "role.verdict"),
    ).toHaveLength(0);
    expect(await client.readReviewStates(pullRequest.number)).not.toContain("APPROVED");

    expect(run.outcome.gate.conclusion).toBe("failure");

    // And the gate that was opened is concluded rather than left hanging, so the pull request says
    // why it cannot merge instead of merely failing to say it can.
    const concluded = await client.awaitGateConclusion(pullRequest.headSha);
    expect(concluded.conclusion).toBe("failure");
    expect(concluded.status).toBe("completed");
  });
});
