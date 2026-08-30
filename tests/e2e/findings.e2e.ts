import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isPullRequestLevel } from "../../src/model/client.js";

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
 * Quickstart scenario 2 and FR-014 (tasks.md T049, T050): where a finding lands.
 *
 * Both cases are about placement rather than judgement, and they are the two halves of one rule.
 * A finding the diff can carry is anchored to the line that introduces the defect, so the author
 * reads it beside the code (FR-010). A finding the diff *cannot* carry — a line the change does
 * not touch, a path outside it, an excluded path — is recorded at pull-request level rather than
 * dropped (FR-014).
 *
 * The second half is the one worth a scenario of its own. GitHub rejects a review comment on a
 * line the diff does not touch, so the tempting implementation is to discard such a finding at the
 * point the platform refuses it — which produces a reviewer that silently notices defects and says
 * nothing, the worst of the three possible behaviours.
 *
 * Neither test asserts on the wording of a finding; both assert on where it went, what severity it
 * carries, and whether it blocks (FR-030, SC-010).
 */

describe("finding placement", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("anchors a blocking finding to the introducing line and requests changes (scenario 2)", async () => {
    const source = await client.readBaseFile("src/config.js");

    // Appended, so the introducing line's number is arithmetic rather than a guess: the file ends
    // with a newline, so `split("\n")` yields one trailing empty element and its length is the
    // number the appended line takes.
    const introducingLine = source.split("\n").length;
    const withCredential = `${source}\nexport const FALLBACK_TOKEN = "ghp_000000000000000000000000000000000000";\n`;

    const pullRequest = await client.openPullRequest({
      label: "scenario-02-credential",
      title: "Add a fallback token so local runs need no environment",
      body: "Staged for scenario 2: a credential where Principle IV forbids one.",
      files: [{ path: "src/config.js", content: withCredential }],
    });

    const run = await runReview({
      client,
      pullRequest,
      script: script({
        security: response([
          anchoredFinding("src/config.js", introducingLine, {
            rule: "hardcoded-credential",
            severity: "critical",
          }),
        ]),
      }),
    });

    // The service kept the anchor rather than demoting it: the line is one the diff added.
    const [finding] = run.outcome.findings.filter((candidate) => candidate.role === "security");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("critical");
    expect(finding?.blocking).toBe(true);
    expect(finding?.location).toEqual({
      path: "src/config.js",
      line: introducingLine,
      side: "RIGHT",
    });

    expect(run.outcome.gate.conclusion).toBe("failure");

    // Posted where the author reads it, with the severity and blocking status carried on the
    // comment itself rather than left to be inferred (FR-011, FR-012).
    const posted = await client.readOwnFindings(pullRequest.number);
    const anchored = posted.find((candidate) => candidate.rule === "hardcoded-credential");

    expect(anchored).toBeDefined();
    expect(anchored?.path).toBe("src/config.js");
    expect(anchored?.line).toBe(introducingLine);
    expect(anchored?.severity).toBe("critical");
    expect(anchored?.blocking).toBe(true);
    expect(anchored?.role).toBe("security");
    expect(anchored?.isResolved).toBe(false);

    // And the role's verdict is the platform's own `CHANGES_REQUESTED`, not a comment that reads
    // like an objection but counts as none (FR-006).
    expect(await client.readReviewStates(pullRequest.number)).toContain("CHANGES_REQUESTED");

    const concluded = await client.awaitGateConclusion(pullRequest.headSha);
    expect(concluded.conclusion).toBe("failure");
  });

  it("records a finding the diff cannot carry at pull-request level (FR-014)", async () => {
    const source = await client.readBaseFile("src/greeting.js");

    const pullRequest = await client.openPullRequest({
      label: "fr-014-unanchorable",
      title: "A one-line change, with a finding about something else",
      body: "Staged for FR-014: the finding names a line this diff does not touch.",
      files: [
        {
          path: "src/greeting.js",
          content: source.replace(
            'throw new TypeError("formatList: names must be an array");',
            'throw new TypeError("formatList: names must be an array, received a non-array");',
          ),
        },
      ],
    });

    const run = await runReview({
      client,
      pullRequest,
      script: script({
        security: response([
          // A path the diff does not touch at all — the strongest form of "outside the diff",
          // since neither the file nor the line is addressable.
          anchoredFinding("src/config.js", 12, { rule: "outside-the-diff", severity: "high" }),
        ]),
      }),
    });

    const [finding] = run.outcome.findings.filter(
      (candidate) => candidate.rule === "outside-the-diff",
    );

    // Not dropped. It exists, it still blocks, and it is now pull-request level.
    expect(finding).toBeDefined();
    expect(finding?.blocking).toBe(true);
    expect(finding?.location).toBeDefined();
    expect(isPullRequestLevel(finding!.location)).toBe(true);

    // The record says the same thing, so a run is auditable without re-reading GitHub (FR-033).
    const postedRecords = run.records.filter(
      (record) => (record as { event: string }).event === "finding.posted",
    ) as { finding: { id: string; pullRequestLevel?: boolean; path?: string } }[];

    const unanchorable = postedRecords.find((record) => record.finding.id === finding?.id);
    expect(unanchorable?.finding.pullRequestLevel).toBe(true);
    expect(unanchorable?.finding.path).toBeUndefined();

    // It reached the pull request as part of the role's review rather than as a line comment: a
    // pull-request-level finding has no thread, which is precisely why it needed somewhere to go.
    const threads = await client.readOwnFindings(pullRequest.number);
    expect(threads.some((thread) => thread.rule === "outside-the-diff")).toBe(false);

    expect(await client.readReviewStates(pullRequest.number)).toContain("CHANGES_REQUESTED");
    expect(run.outcome.gate.conclusion).toBe("failure");
  });
});
