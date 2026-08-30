import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bothApprove,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  runReview,
  type FixtureClient,
  type FixturePullRequest,
} from "./harness/index.js";

/**
 * Quickstart scenario 18 (tasks.md T103): the reviewer never approves its own work (FR-004,
 * SC-006).
 *
 * Principle VI's independence is the feature. It also fails *silently* — a self-review looks
 * exactly like an ordinary one, right down to a green check run — which is why the refusal has to
 * be a check the service makes rather than a convention it follows.
 *
 * The pull request here is therefore genuinely authored by the reviewing identity: the App creates
 * the branch, the commit, and the pull request with its own installation token, so GitHub reports
 * the author as the App's bot login and the service compares two real names. A harness that
 * asserted the comparison against a synthesized login would be testing string equality.
 *
 * The negative case shares the file deliberately. A refusal that fired on every pull request would
 * satisfy every assertion in the first test and be catastrophically wrong, and nothing in the first
 * test can tell the two apart.
 */

/** The author GitHub reports for a pull request, which is what FR-004 actually compares. */
async function authorLoginOf(
  client: FixtureClient,
  pullRequest: FixturePullRequest,
): Promise<string | null> {
  const { data } = await client.author.rest.pulls.get({
    owner: client.environment.repository.owner,
    repo: client.environment.repository.name,
    pull_number: pullRequest.number,
  });

  return data.user?.login ?? null;
}

describe("self-authored pull requests", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("records no approval for a pull request it authored itself (scenario 18)", async () => {
    const source = await client.readBaseFile("src/greeting.js");

    const pullRequest = await client.openPullRequest({
      label: "scenario-18-self-authored",
      title: "A change authored by the reviewing identity",
      body: "Staged for scenario 18.",
      openedBy: "app",
      files: [{ path: "src/greeting.js", content: `${source}\nexport const SELF = true;\n` }],
    });

    // The premise, read back from GitHub rather than assumed: this really was opened by an App.
    const login = await authorLoginOf(client, pullRequest);
    expect(login).not.toBeNull();
    expect(login?.endsWith("[bot]")).toBe(true);

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    // Refused before anything was asked of the model — independence is not something to spend
    // tokens discovering.
    expect(run.outcome.stoppedBeforeSpending).toBe(true);
    expect(run.model.received).toHaveLength(0);
    expect(run.outcome.tokensConsumed).toBe(0);

    // No approving verdict anywhere: not in the records, and not on the pull request.
    expect(
      run.records.filter((record) => (record as { event: string }).event === "role.verdict"),
    ).toHaveLength(0);
    expect(await client.readReviewStates(pullRequest.number)).not.toContain("APPROVED");

    expect(run.outcome.gate.conclusion).not.toBe("success");
    expect(run.outcome.gate.conclusion).toBe("failure");

    expect(
      run.records.filter(
        (record) => (record as { event: string }).event === "identity.self_authored_refused",
      ),
    ).toHaveLength(1);

    // The reason is stated where the author reads it, and a human is told (FR-035).
    const escalation = await client.awaitEscalation(pullRequest.number, "identity.self_authored");
    expect(escalation.statedOnPullRequest).toBe(true);
    expect(escalation.issue.labels).toContain("escalation");
  });

  it("does not trip on a pull request another author opened (scenario 18)", async () => {
    const [source, tests, document] = await Promise.all([
      client.readBaseFile("src/greeting.js"),
      client.readBaseFile("tests/greeting.test.js"),
      client.readBaseFile("docs/greeting.md"),
    ]);

    const pullRequest = await client.openPullRequest({
      label: "scenario-18-other-author",
      title: "A change authored by somebody else",
      body: "Staged for scenario 18's negative case.",
      files: [
        { path: "src/greeting.js", content: `${source}\nexport const OTHER = true;\n` },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("the flag is exported", () => {\n  assert.equal(OTHER, true);\n});\n`,
        },
        { path: "docs/greeting.md", content: `${document}\nThe module exports a flag.\n` },
      ],
    });

    const login = await authorLoginOf(client, pullRequest);
    expect(login?.endsWith("[bot]")).toBe(false);

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    // The check is narrow enough to let an ordinary contributor through, which is the half a
    // refusal-only test can never establish.
    expect(run.outcome.stoppedBeforeSpending).toBe(false);
    expect(run.model.requestsFor("security")).toHaveLength(1);
    expect(run.model.requestsFor("implementation")).toHaveLength(1);

    expect(
      run.records.filter(
        (record) => (record as { event: string }).event === "identity.self_authored_refused",
      ),
    ).toHaveLength(0);
    expect(await client.readEscalationCauses(pullRequest.number)).not.toContain(
      "identity.self_authored",
    );

    expect(run.outcome.gate.conclusion).toBe("success");
  });
});
