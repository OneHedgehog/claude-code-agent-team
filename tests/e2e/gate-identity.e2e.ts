import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MERGE_GATE_CHECK_NAME } from "../../src/github/check-run.js";

import {
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  statusOf,
  type FixtureClient,
  type FixturePullRequest,
} from "./harness/index.js";

/**
 * Quickstart scenario 19 (tasks.md T037): the authoring identity cannot report the gate.
 *
 * FR-022 and SC-007 are usually read as a policy — "the service must use a separate identity" —
 * and a suite that tested it as one would be testing its own configuration. It is not a policy.
 * GitHub accepts a check-run write only from a GitHub App installation and rejects every user
 * token whatever scopes it carries, so the separation is **structural**: there is no grant that
 * would let the authoring identity report this gate, and therefore nothing an operator could
 * misconfigure into letting it.
 *
 * The distinction is what this file exists to pin down, so the three assertions are deliberately
 * arranged to rule out the two innocent explanations for a `403`:
 *
 *   - the authoring token *can* write to this repository — it just created a branch, a commit, and
 *     a pull request — so the refusal is not "no write access";
 *   - the App *can* write this exact check run on this exact revision, so the refusal is not "this
 *     revision rejects check runs";
 *   - and yet the same request from the authoring identity is refused.
 *
 * Only the identity differs between the second and the third, which is what makes the refusal
 * attributable to it.
 */

describe("merge gate identity", () => {
  let client: FixtureClient;
  let pullRequest: FixturePullRequest;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));

    const source = await client.readBaseFile("src/greeting.js");

    pullRequest = await client.openPullRequest({
      label: "scenario-19-gate-identity",
      title: "A revision for the gate-identity scenario",
      body: "Opened so scenario 19 has a real revision to attempt a check run against.",
      files: [
        {
          path: "src/greeting.js",
          content: source.replace(
            "export function formatList(names) {",
            "export function formatList(names /* the list to render */) {",
          ),
        },
      ],
    });
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("lets the authoring identity write to the repository", async () => {
    // The premise the refusal below has to be read against. Without it, a `403` on the check run
    // is equally well explained by a token with no access to the fixture at all.
    const response = await statusOf(() =>
      client.author.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: client.environment.repository.owner,
        repo: client.environment.repository.name,
        pull_number: pullRequest.number,
      }),
    );

    expect(response.status).toBe(200);
    expect(client.created.pullRequests).toContain(pullRequest.number);
  });

  it("lets the App report the gate on the same revision", async () => {
    const app = await client.asApp();

    const { data } = await app.rest.checks.create({
      owner: client.environment.repository.owner,
      repo: client.environment.repository.name,
      name: MERGE_GATE_CHECK_NAME,
      head_sha: pullRequest.headSha,
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Scenario 19",
        summary: "Written by the App to establish that this revision accepts a check run at all.",
      },
    });

    expect(data.id).toBeGreaterThan(0);

    const runs = await client.listGateRuns(pullRequest.headSha);
    expect(runs.some((run) => run.id === data.id)).toBe(true);
  });

  it("refuses the same report from the authoring identity", async () => {
    const refused = await client.attemptGateReportAsAuthor(pullRequest.headSha);

    // 403, not 404 and not 422: the request is understood, the revision is right, and the identity
    // is the reason. A user token cannot be granted this, so there is no scope to add.
    expect(refused.status).toBe(403);

    // Nothing was created by the attempt. A refusal that still left a run behind would mean the
    // gate had a second, unauthenticated author.
    const runs = await client.listGateRuns(pullRequest.headSha);
    expect(runs.every((run) => run.status === "completed")).toBe(true);
    expect(runs).toHaveLength(1);
  });
});
