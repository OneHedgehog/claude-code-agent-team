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
 * Quickstart scenario 27 (tasks.md T085): a pull request with nothing to review is refused
 * (FR-052).
 *
 * The three available answers are not equally good. Approving would make a degenerate pull request
 * indistinguishable from an ordinary one that passed, which is the more dangerous of the two ways
 * to be wrong. Skipping is the non-failing gate Principle IV prohibits outright. Refusing is the
 * only answer that leaves the pull request visibly abnormal, and visible is the whole requirement.
 *
 * The condition is produced with a **whitespace-only** diff rather than an empty one, because git
 * will not record a commit that changes nothing — so an "empty diff" that reached the service in
 * production is far more likely to be this shape than a literal one. One line is re-indented: the
 * diff genuinely carries an added and a removed line, and it is the service's own collapse of
 * whitespace that has to decide they are the same line.
 *
 * As with every pre-spend stop, nothing opens the gate — there is no in-progress check run to
 * conclude — so the escalation is the artefact a human sees.
 */

describe("nothing to review", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("refuses a whitespace-only diff, spending nothing (scenario 27)", async () => {
    const source = await client.readBaseFile("src/greeting.js");

    const indented = source.replace("  if (names.length === 0) {", "    if (names.length === 0) {");

    // The premise: the file really did change, so the refusal below is the service collapsing
    // whitespace rather than GitHub reporting no diff at all.
    expect(indented).not.toBe(source);

    const pullRequest = await client.openPullRequest({
      label: "scenario-27-empty-diff",
      title: "A change that changes only whitespace",
      body: "Staged for scenario 27.",
      files: [{ path: "src/greeting.js", content: indented }],
    });

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    expect(run.outcome.stoppedBeforeSpending).toBe(true);
    expect(run.outcome.tokensConsumed).toBe(0);
    expect(run.model.received).toHaveLength(0);

    // No verdict from either role — the requirement says "no verdict", not "no approval".
    expect(
      run.records.filter((record) =>
        ["role.verdict", "role.verdict_missing"].includes((record as { event: string }).event),
      ),
    ).toHaveLength(0);
    expect(await client.readReviewStates(pullRequest.number)).toHaveLength(0);

    expect(run.outcome.gate.conclusion).toBe("failure");
    expect(await client.listGateRuns(pullRequest.headSha)).toHaveLength(0);

    expect(
      run.records.filter((record) => (record as { event: string }).event === "diff.empty"),
    ).toHaveLength(1);

    const escalation = await client.awaitEscalation(pullRequest.number, "diff.empty");
    expect(escalation.statedOnPullRequest).toBe(true);
    expect(escalation.issue.labels).toContain("escalation");
  });
});
