import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  anchoredFinding,
  bothApprove,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  response,
  runReview,
  script,
  type FixtureClient,
} from "./harness/index.js";

/**
 * Quickstart scenarios 7 and 8 (tasks.md T070, T071): what a push does to a review.
 *
 * Scenario 7 is the property the whole gate rests on. A verdict is bound to a revision, never to
 * "the pull request", so a push does not *invalidate* an approval so much as leave it attached to
 * code nobody is proposing to merge any more (FR-009, FR-017, FR-018). The assertion is therefore
 * about the new revision rather than the old one: the old approval is still there, still true of
 * the revision it named, and reports nothing at all about the revision that replaced it.
 *
 * Scenario 8 is the other half — the loop has to be able to run twice without either forgetting
 * what it said or repeating it. Reconciliation resolves what the revision no longer exhibits,
 * leaves standing what it does, and posts only what is new (FR-039). Reposting a standing finding
 * would be the quietest of the three failures: the author sees a growing pile of duplicates and
 * stops reading any of them.
 */

describe("staleness and re-review", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("leaves the gate unreported on a revision pushed after approval (scenario 7)", async () => {
    const [source, tests, document] = await Promise.all([
      client.readBaseFile("src/greeting.js"),
      client.readBaseFile("tests/greeting.test.js"),
      client.readBaseFile("docs/greeting.md"),
    ]);

    const approved = await client.openPullRequest({
      label: "scenario-07-staleness",
      title: "A change that passes, then gains a commit",
      body: "Staged for scenario 7.",
      files: [
        { path: "src/greeting.js", content: `${source}\nexport const VERSION = "1.0.0";\n` },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("the module states its version", () => {\n  assert.equal(typeof VERSION, "string");\n});\n`,
        },
        { path: "docs/greeting.md", content: `${document}\nThe module states its version.\n` },
      ],
    });

    const first = await runReview({ client, pullRequest: approved, script: bothApprove() });
    expect(first.outcome.gate.conclusion).toBe("success");
    expect((await client.awaitGateConclusion(approved.headSha)).conclusion).toBe("success");

    const revised = await client.pushRevision(
      approved,
      [{ path: "src/greeting.js", content: `${source}\nexport const VERSION = "1.1.0";\n` }],
      "bump the version",
    );

    expect(revised.headSha).not.toBe(approved.headSha);

    // The approval did not move with the branch. Nothing reports on the new revision, so branch
    // protection holds the merge — which is the behaviour, not an absence of one.
    expect(await client.listGateRuns(revised.headSha)).toHaveLength(0);

    // The prior verdict is still bound to the revision it examined, and to no other (FR-009).
    const priorRecord = await client.readRoundRecord(approved.headSha);
    expect(priorRecord?.headSha).toBe(approved.headSha);

    // The next review is a fresh, full review of the new revision: both roles are asked again, and
    // neither round-one verdict is carried across.
    const second = await runReview({ client, pullRequest: revised, script: bothApprove() });

    expect(second.model.requestsFor("security")).toHaveLength(1);
    expect(second.model.requestsFor("implementation")).toHaveLength(1);
    expect(second.runId).not.toBe(first.runId);
    expect(second.outcome.headSha).toBe(revised.headSha);

    const verdicts = second.records.filter(
      (record) => (record as { event: string }).event === "role.verdict",
    ) as { revision: string }[];
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((verdict) => verdict.revision === revised.headSha)).toBe(true);

    const concluded = await client.awaitGateConclusion(revised.headSha);
    expect(concluded.headSha).toBe(revised.headSha);
    expect(concluded.conclusion).toBe("success");
  });

  it("resolves the fixed finding, leaves the standing one, adds the new one (scenario 8)", async () => {
    const [source, tests, document] = await Promise.all([
      client.readBaseFile("src/greeting.js"),
      client.readBaseFile("tests/greeting.test.js"),
      client.readBaseFile("docs/greeting.md"),
    ]);

    // The test and the document ship with the change so the documentation rule stays silent. This
    // scenario is about reconciliation across rounds, and a rule firing on every round would put
    // its own pull-request-level findings into the counts below without saying anything about it.

    // Two appended lines, so both findings anchor to lines the diff genuinely carries and their
    // numbers are arithmetic rather than a guess.
    const firstAddedLine = source.split("\n").length;
    const secondAddedLine = firstAddedLine + 1;

    const revisionOne = (alpha: string): string =>
      `${source}\nexport const ALPHA = ${alpha};\nexport const BETA = 2;\n`;

    const pullRequest = await client.openPullRequest({
      label: "scenario-08-reconciliation",
      title: "Two constants, one of which will be fixed",
      body: "Staged for scenario 8.",
      files: [
        { path: "src/greeting.js", content: revisionOne("1") },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("the constants are exported", () => {\n  assert.equal(typeof ALPHA, "number");\n});\n`,
        },
        { path: "docs/greeting.md", content: `${document}\nThe module exports two constants.\n` },
      ],
    });

    const round1 = await runReview({
      client,
      pullRequest,
      script: script({
        security: response([
          anchoredFinding("src/greeting.js", firstAddedLine, { rule: "finding-fixed-next-round" }),
          anchoredFinding("src/greeting.js", secondAddedLine, { rule: "finding-that-stands" }),
        ]),
      }),
    });

    expect(round1.outcome.findings).toHaveLength(2);
    const fixedId = round1.outcome.findings.find(
      (finding) => finding.rule === "finding-fixed-next-round",
    )?.id;
    const standingId = round1.outcome.findings.find(
      (finding) => finding.rule === "finding-that-stands",
    )?.id;

    expect(fixedId).toBeDefined();
    expect(standingId).toBeDefined();
    expect(
      (await client.readOwnFindings(pullRequest.number)).map((f) => f.findingId).sort(),
    ).toEqual([fixedId, standingId].sort());

    const revised = await client.pushRevision(
      pullRequest,
      [{ path: "src/greeting.js", content: revisionOne("3") }],
      "address the first finding",
    );

    // Round two: the first finding is gone, the second is exhibited again — identical role, rule,
    // path, and description, which is what makes it the *same* finding rather than a new one, since
    // the fingerprint deliberately excludes the line number — and a third is raised.
    const round2 = await runReview({
      client,
      pullRequest: revised,
      script: script({
        security: response([
          anchoredFinding("src/greeting.js", secondAddedLine, { rule: "finding-that-stands" }),
          anchoredFinding("src/greeting.js", firstAddedLine, { rule: "finding-raised-this-round" }),
        ]),
      }),
    });

    const newId = round2.outcome.findings.find(
      (finding) => finding.rule === "finding-raised-this-round",
    )?.id;
    expect(newId).toBeDefined();

    // The standing finding kept its identity across the push.
    expect(round2.outcome.findings.some((finding) => finding.id === standingId)).toBe(true);

    const resolvedRecords = round2.records.filter(
      (record) => (record as { event: string }).event === "finding.resolved",
    ) as { finding: { id: string } }[];
    expect(resolvedRecords.map((record) => record.finding.id)).toEqual([fixedId]);

    const postedRecords = round2.records.filter(
      (record) => (record as { event: string }).event === "finding.posted",
    ) as { finding: { id: string } }[];
    // Only the new one is posted: the standing finding is left where it is rather than repeated.
    expect(postedRecords.map((record) => record.finding.id)).toEqual([newId]);

    const threads = await client.readOwnFindings(revised.number);

    // Exactly three threads, not four: nothing was reposted.
    expect(threads).toHaveLength(3);

    const byId = new Map(threads.map((thread) => [thread.findingId, thread]));
    expect(byId.get(fixedId!)?.isResolved).toBe(true);
    expect(byId.get(standingId!)?.isResolved).toBe(false);
    expect(byId.get(newId!)?.isResolved).toBe(false);

    expect(round2.outcome.gate.conclusion).toBe("failure");
  });
});
