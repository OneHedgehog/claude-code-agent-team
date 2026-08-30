import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  anchoredFinding,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  response,
  runReview,
  script,
  type FixtureClient,
  type FixturePullRequest,
} from "./harness/index.js";

/**
 * Quickstart scenarios 9 and 10 (tasks.md T072): what an author's justification can and cannot do.
 *
 * Principle VI gives an author two ways to answer a blocking finding — change the code, or reply
 * with a justification — and these two scenarios are the second way, judged both ways. The
 * distinction they exist to hold is one sentence long and very easy to lose: **accepting a
 * justification is not accepting the code.**
 *
 * So a rejected justification changes nothing at all (FR-044): the finding is exactly as it was,
 * open and blocking, and the gate fails for the same reason it failed before. An accepted one does
 * not resolve the finding either (FR-045). It converts it into a waiver *request*, which is a
 * question put to a human — the gate stays shut and the escalation is how the human hears about
 * it. A service that resolved its own finding on its own acceptance would be a reviewer that can
 * waive its own findings, which is not a gate.
 *
 * Each scenario runs two rounds, because a reply can only exist once there is something to reply
 * to. The second round is reachable precisely because a reply *is* forward progress under FR-046 —
 * the same rule that stops a re-review when nothing has happened.
 */

/** Round one for both scenarios: one blocking finding, anchored, on a line the diff carries. */
async function raiseOneBlockingFinding(
  client: FixtureClient,
  label: string,
): Promise<{
  pullRequest: FixturePullRequest;
  findingId: string;
  threadId: string;
  anchorLine: number;
}> {
  const [source, tests, document] = await Promise.all([
    client.readBaseFile("src/greeting.js"),
    client.readBaseFile("tests/greeting.test.js"),
    client.readBaseFile("docs/greeting.md"),
  ]);

  const anchorLine = source.split("\n").length;

  const pullRequest = await client.openPullRequest({
    label,
    title: "A change with one contested finding",
    body: "Staged for the waiver scenarios.",
    files: [
      { path: "src/greeting.js", content: `${source}\nexport const RETRIES = 5;\n` },
      {
        path: "tests/greeting.test.js",
        content: `${tests}\ntest("the retry count is exported", () => {\n  assert.equal(typeof RETRIES, "number");\n});\n`,
      },
      { path: "docs/greeting.md", content: `${document}\nThe module exports a retry count.\n` },
    ],
  });

  const round = await runReview({
    client,
    pullRequest,
    script: script({
      security: response([
        anchoredFinding("src/greeting.js", anchorLine, { rule: "contested-finding" }),
      ]),
    }),
  });

  const finding = round.outcome.findings.find(
    (candidate) => candidate.rule === "contested-finding",
  );
  expect(finding?.blocking).toBe(true);
  expect(round.outcome.gate.conclusion).toBe("failure");

  const [thread] = await client.readOwnFindings(pullRequest.number);
  expect(thread?.findingId).toBe(finding?.id);

  return { pullRequest, findingId: finding!.id, threadId: thread!.threadId, anchorLine };
}

describe("author justifications and waivers", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("leaves a finding blocking when the justification is rejected (scenario 9)", async () => {
    const { pullRequest, findingId, threadId, anchorLine } = await raiseOneBlockingFinding(
      client,
      "scenario-09-rejected",
    );

    await client.replyToThread(threadId, "This is deliberate; the value is bounded upstream.");

    const round2 = await runReview({
      client,
      pullRequest,
      script: script({
        // Same role, rule, path, and description, so the fingerprint is the same finding rather
        // than a new one. The path matters as much as the other three: the fingerprint omits the
        // *line* deliberately, so a finding that shifted is still itself — but a finding the diff
        // cannot carry has no path at all, and would not be recognised as the same finding.
        security: response(
          [anchoredFinding("src/greeting.js", anchorLine, { rule: "contested-finding" })],
          [{ findingId, accepted: false, reason: "The bound is not visible in this diff." }],
        ),
      }),
    });

    // The reply was forward progress, so the round ran at all.
    expect(round2.outcome.stoppedBeforeSpending).toBe(false);

    // And it changed nothing about the finding. Untouched means untouched: same identity, still
    // open, still blocking (FR-044).
    const finding = round2.outcome.findings.find((candidate) => candidate.id === findingId);
    expect(finding).toBeDefined();
    expect(finding?.status).toBe("open");
    expect(finding?.blocking).toBe(true);

    expect(round2.outcome.gate.conclusion).toBe("failure");
    expect((await client.awaitGateConclusion(pullRequest.headSha)).conclusion).toBe("failure");

    // No waiver was raised, and nothing was escalated on that account.
    expect(
      round2.records.filter(
        (record) => (record as { event: string }).event === "finding.waiver_requested",
      ),
    ).toHaveLength(0);
    expect(await client.readEscalationCauses(pullRequest.number)).not.toContain("waiver.requested");

    // The thread is still open: a rejected justification does not resolve anything.
    const threads = await client.readOwnFindings(pullRequest.number);
    expect(threads.find((thread) => thread.findingId === findingId)?.isResolved).toBe(false);
  });

  it("records and escalates a waiver request when the justification is accepted (scenario 10)", async () => {
    const { pullRequest, findingId, threadId, anchorLine } = await raiseOneBlockingFinding(
      client,
      "scenario-10-accepted",
    );

    await client.replyToThread(
      threadId,
      "Accepted risk: this path is unreachable until the follow-up feature lands.",
    );

    const round2 = await runReview({
      client,
      pullRequest,
      script: script({
        security: response(
          [anchoredFinding("src/greeting.js", anchorLine, { rule: "contested-finding" })],
          [{ findingId, accepted: true, reason: "The stated bound holds for this revision." }],
        ),
      }),
    });

    // Accepted, and therefore *not* resolved. The code still exhibits the finding; what changed is
    // that a human now has something to grant or refuse (FR-045).
    const finding = round2.outcome.findings.find((candidate) => candidate.id === findingId);
    expect(finding?.status).toBe("waiver-requested");
    expect(finding?.waiver).not.toBeNull();
    expect(finding?.waiver?.revision).toBe(pullRequest.headSha);

    const waivers = round2.records.filter(
      (record) => (record as { event: string }).event === "finding.waiver_requested",
    ) as { finding: { id: string } }[];
    expect(waivers.map((record) => record.finding.id)).toEqual([findingId]);

    // The gate does not pass. An outstanding waiver holds it exactly as the finding did.
    expect(round2.outcome.gate.conclusion).toBe("failure");
    expect((await client.awaitGateConclusion(pullRequest.headSha)).conclusion).toBe("failure");

    // Escalated on both surfaces, because a waiver nobody is told about is a waiver nobody grants,
    // and a pull request comment nobody watches is not a notification (FR-035).
    const escalation = await client.awaitEscalation(pullRequest.number, "waiver.requested");

    // Filed under the channel's label — the documented default, since the fixture's settings omit
    // it, which is FR-054's "a value nobody chose is still a value everybody can see" in practice.
    expect(escalation.issue.labels).toContain("escalation");
    expect(escalation.statedOnPullRequest).toBe(true);

    // And the thread is still open.
    const threads = await client.readOwnFindings(pullRequest.number);
    expect(threads.find((thread) => thread.findingId === findingId)?.isResolved).toBe(false);
  });
});
