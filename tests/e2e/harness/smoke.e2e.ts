import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MERGE_GATE_CHECK_NAME } from "../../../src/github/check-run.js";

import {
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  runReview,
  statusOf,
  type FixtureClient,
  type FixturePullRequest,
} from "./index.js";

/**
 * The harness's own smoke check (tasks.md T032).
 *
 * Not one of the 29 validation scenarios — it asserts nothing about review behavior. It asserts
 * that the harness itself works: the fixture is configured, a pull request can be opened as the
 * authoring identity, a real review runs against it with only the model substituted, the gate is
 * reported by the App, and teardown removes what it made.
 *
 * It exists so that a scenario failing means the *service* is wrong. Without it, the first
 * scenario written also becomes the harness's test, and its failure says nothing about which of
 * the two is broken.
 *
 * It holds `fixture-repo`, `github-quota`, and `review-slot` while it runs, like every other e2e
 * file (Principle VIII), which is why `vitest.config.ts` runs the e2e project with no parallelism.
 */

const APPROVING = {
  security: {
    findings: [],
    verdict: "approve" as const,
    replyJudgements: [],
    usage: { inputTokens: 1_000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 },
  },
  implementation: {
    findings: [],
    verdict: "approve" as const,
    replyJudgements: [],
    usage: { inputTokens: 1_000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 },
  },
};

describe("end-to-end harness", () => {
  let client: FixtureClient;
  let pullRequest: FixturePullRequest;

  beforeAll(async () => {
    // Refuses rather than skips. A suite that skipped when its fixture was absent would report
    // green on a machine where it has never once run.
    const environment = await requireFixtureEnvironment(fixtureEnvironment());
    client = createFixtureClient(environment);
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("opens a pull request in the fixture as the authoring identity", async () => {
    pullRequest = await client.openPullRequest({
      label: "harness-smoke",
      title: "Harness smoke: add a greeting variant",
      body: "Opened by the end-to-end harness (tasks.md T032).",
      files: [
        {
          path: "src/greeting.js",
          content: [
            "export function greet(name) {",
            "  return `Hello, ${name}!`;",
            "}",
            "",
            "export function farewell(name) {",
            "  return `Goodbye, ${name}!`;",
            "}",
            "",
          ].join("\n"),
        },
      ],
    });

    expect(pullRequest.number).toBeGreaterThan(0);
    expect(pullRequest.headSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(pullRequest.baseBranch).toBe(client.environment.gatedBaseBranch);

    const { data } = await client.author.rest.pulls.get({
      owner: client.environment.repository.owner,
      repo: client.environment.repository.name,
      pull_number: pullRequest.number,
    });

    // The pull request must not be authored by the reviewing identity, or every scenario but 18
    // would stop on FR-004 before doing anything at all.
    expect(data.user?.type).toBe("User");
  });

  it("runs the real service against it with only the model substituted", async () => {
    const run = await runReview({ client, pullRequest, script: APPROVING });

    // Both roles were asked, and asked about *this* revision — the diff and the constitution were
    // resolved through the target parameter rather than through the harness's own directory.
    expect(run.model.requestsFor("security")).toHaveLength(1);
    expect(run.model.requestsFor("implementation")).toHaveLength(1);
    expect(run.checkoutPath).not.toBe(process.cwd());

    expect(run.outcome.pullRequest).toBe(pullRequest.number);
    expect(run.outcome.headSha).toBe(pullRequest.headSha);
    expect(run.outcome.stoppedBeforeSpending).toBe(false);

    // Records carry the run identifier, which is what makes a concluded run reconstructible.
    const events = run.records.map((record) => (record as { event: string }).event);
    expect(events).toContain("run.started");
    expect(events).toContain("run.concluded");
    expect(run.records.every((record) => (record as { runId: string }).runId === run.runId)).toBe(
      true,
    );
  });

  it("reports the gate as the App, and reads it back", async () => {
    const concluded = await client.awaitGateConclusion(pullRequest.headSha);

    expect(concluded.name).toBe(MERGE_GATE_CHECK_NAME);
    expect(concluded.headSha).toBe(pullRequest.headSha);
    expect(concluded.status).toBe("completed");
    expect(["success", "failure"]).toContain(concluded.conclusion);

    // The round record round-trips through the check-run output, which is where the next round
    // reads its baseline from (Principle VII: history lives on GitHub, not on disk).
    const record = await client.readRoundRecord(pullRequest.headSha);
    expect(record?.headSha).toBe(pullRequest.headSha);
    expect(record?.concluded).toBe(true);
  });

  it("refuses a gate report from the authoring identity", async () => {
    const refused = await client.attemptGateReportAsAuthor(pullRequest.headSha);

    // Structural, not a matter of scope: GitHub accepts check-run writes only from an App
    // installation and rejects every user token regardless of what it was granted.
    expect(refused.status).toBe(403);
  });

  it("reads review threads and escalation issues", async () => {
    // Shape assertions only. Whether there are any is the scenarios' business; that the harness
    // can read both surfaces is this file's.
    const threads = await client.readOwnThreads(pullRequest.number);
    expect(Array.isArray(threads)).toBe(true);

    const escalations = await client.readEscalations(pullRequest.number);
    expect(Array.isArray(escalations)).toBe(true);
  });

  it("pushes a revision, which becomes a new head", async () => {
    const revised = await client.pushRevision(
      pullRequest,
      [{ path: "docs/greeting.md", content: "# Greeting\n\nNow also says goodbye.\n" }],
      "document the farewell",
    );

    expect(revised.headSha).not.toBe(pullRequest.headSha);
    expect(revised.number).toBe(pullRequest.number);

    const { data } = await client.author.rest.pulls.get({
      owner: client.environment.repository.owner,
      repo: client.environment.repository.name,
      pull_number: pullRequest.number,
    });
    expect(data.head.sha).toBe(revised.headSha);

    pullRequest = revised;
  });

  it("tears down what it created", async () => {
    const branches = [...client.created.branches];
    expect(branches.length).toBeGreaterThan(0);

    await client.teardown();

    expect(client.created.branches).toHaveLength(0);
    expect(client.created.pullRequests).toHaveLength(0);

    for (const branch of branches) {
      const response = await statusOf(() =>
        client.author.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          owner: client.environment.repository.owner,
          repo: client.environment.repository.name,
          ref: `heads/${branch}`,
        }),
      );

      expect(response.status).toBe(404);
    }
  });
});
