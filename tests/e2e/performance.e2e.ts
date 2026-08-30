import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bothApprove,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  runReview,
  type FixtureClient,
} from "./harness/index.js";

/**
 * SC-013 (tasks.md T116): a review of a diff up to 1,000 changed lines concludes within ten
 * minutes.
 *
 * **What this figure is, and is not.** The model boundary is substituted here, as it is in every
 * other end-to-end case (R-015, Principle II) — so the ten minutes measured below bound *harness
 * overhead*: cloning and provisioning a worktree, reading the pull request and its diff, indexing
 * it, taking a host lease, opening and concluding the check run, posting and reconciling findings.
 * They do not bound model latency, and this test would not notice if it doubled.
 *
 * That is deliberate rather than a compromise. A merge-path test whose duration depended on a
 * model call would be measuring the provider's day: it would go red on a slow afternoon, nobody
 * would be able to reproduce it, and within a month it would be skipped. The real-model figure is
 * an eval run outside the merge path, where a slow result is information rather than a broken
 * build. What belongs *here* is the half that is deterministic and that a change to this code can
 * actually regress — a quadratic diff index, a per-line API call, a lost `Promise.all` — and that
 * half is the one this measures.
 *
 * The diff is deliberately just under `maxReviewableDiffSize` (2,000 in the fixture's settings), so
 * the run reaches `reviewing` rather than being refused for size. It is well over
 * `maxPullRequestSize`, so the size rule raises a blocking pull-request-level finding and the gate
 * fails — which is correct, and irrelevant: SC-013 is a claim about *concluding*, not about
 * passing.
 */

/** SC-013's figure, exactly. */
const CHANGED_LINES = 1_000;

/** SC-013's bound, exactly. */
const TEN_MINUTES_MS = 10 * 60 * 1_000;

describe("review duration", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("concludes a 1,000-changed-line review within ten minutes (SC-013)", async () => {
    const generated = Array.from(
      { length: CHANGED_LINES },
      (_unused, index) => `export const measured${index} = ${index};`,
    ).join("\n");

    const pullRequest = await client.openPullRequest({
      label: "sc-013-performance",
      title: "A thousand changed lines",
      body: "Staged for SC-013. Deliberately large, deliberately unjustified.",
      // A path no exclusion pattern matches, so all thousand lines are counted rather than skipped.
      files: [{ path: "src/measured-constants.js", content: `${generated}\n` }],
    });

    const startedAt = Date.now();
    const run = await runReview({ client, pullRequest, script: bothApprove() });
    const elapsedMs = Date.now() - startedAt;

    // It concluded — the claim SC-013 makes — rather than stopping short of a conclusion.
    expect(run.outcome.stoppedBeforeSpending).toBe(false);
    expect(["success", "failure"]).toContain(run.outcome.gate.conclusion);

    const concluded = await client.awaitGateConclusion(pullRequest.headSha);
    expect(concluded.status).toBe("completed");

    // The measurement, taken over the run itself rather than over the whole test: the pull request
    // had to be created first, and creating it is not reviewing it.
    expect(elapsedMs).toBeLessThan(TEN_MINUTES_MS);
  });
});
