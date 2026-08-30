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
 * Quickstart scenario 29 (tasks.md T062): declared and binary exclusions (FR-053).
 *
 * The pull request carries **nothing but excluded content** — a file matching the repository's
 * declared lockfile pattern and a file version control itself reports as binary — and that is what
 * makes
 * the scenario decisive rather than merely illustrative. If either exclusion failed, the excluded
 * file would count as an ordinary behaviour change shipping neither a test nor a document, and the
 * gate would fail on two blocking findings. A passing gate is therefore not a weak assertion here:
 * it is only reachable when both exclusions held.
 *
 * The two sources are deliberately different in kind. A declared pattern is a repository's stated
 * choice; a binary file is git's own report. FR-053 admits exactly these two and no third, because
 * a generated-file heuristic that over-matched would drop real source out of the changed-line count
 * and quietly shrink a pull request under the Principle X cap.
 */

/** A 1×1 PNG. Committed as base64 so the bytes reach git intact and git reports it as binary. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

describe("excluded paths", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("excludes a declared path and a binary file from anchoring and from the count (scenario 29)", async () => {
    const pullRequest = await client.openPullRequest({
      label: "scenario-29-excluded",
      title: "Refresh the dependency lock and the logo",
      body: "Nothing here is reviewable content — staged for scenario 29.",
      files: [
        {
          path: "deps.lock",
          content: [
            "# lockfile v1",
            "greeting@1.0.0",
            "  resolved https://example.invalid/greeting-1.0.0.tgz",
            "formatter@2.3.1",
            "  resolved https://example.invalid/formatter-2.3.1.tgz",
            "",
          ].join("\n"),
        },
        { path: "assets/logo.png", content: PNG_BASE64, encoding: "base64" },
      ],
    });

    const run = await runReview({
      client,
      pullRequest,
      script: script({
        // Non-blocking on purpose: the scenario is about *placement* and *counting*, and a blocking
        // finding would fail the gate for a reason that has nothing to do with either.
        security: response([
          anchoredFinding("deps.lock", 2, {
            rule: "excluded-path-finding",
            severity: "low",
            blocking: false,
          }),
        ]),
      }),
    });

    // Both paths were excluded, and each is attributed to the source that decided it: git's own
    // report for the binary, the repository's declared pattern for the lock file.
    const [excluded] = run.records.filter(
      (record) => (record as { event: string }).event === "paths.excluded",
    ) as { excludedPaths: { count: number; paths: string[]; source: string[] } }[];

    expect(excluded).toBeDefined();
    expect([...(excluded?.excludedPaths.paths ?? [])].sort()).toEqual([
      "assets/logo.png",
      "deps.lock",
    ]);
    expect(excluded?.excludedPaths.count).toBe(2);

    const bySource = new Map(
      (excluded?.excludedPaths.paths ?? []).map((path, index) => [
        path,
        excluded?.excludedPaths.source[index],
      ]),
    );
    expect(bySource.get("deps.lock")).toBe("declared-pattern");
    expect(bySource.get("assets/logo.png")).toBe("vcs-binary");

    // Excluded from anchoring: a finding naming a line of an excluded file is recorded at
    // pull-request level rather than posted against a file nobody is meant to review.
    const [finding] = run.outcome.findings.filter(
      (candidate) => candidate.rule === "excluded-path-finding",
    );
    expect(finding).toBeDefined();
    expect(isPullRequestLevel(finding!.location)).toBe(true);

    const posted = await client.readOwnFindings(pullRequest.number);
    expect(posted.some((thread) => thread.path === "deps.lock")).toBe(false);

    // Excluded from the changed-line count, and neither file blocking on its own. Without the
    // exclusions these paths would read as a behaviour change with no test and no document.
    const rules = run.outcome.findings.map((candidate) => candidate.rule);
    expect(rules).not.toContain("missing-tests");
    expect(rules).not.toContain("missing-or-stale-document");
    expect(rules).not.toContain("pull-request-size");

    expect(run.outcome.gate.conclusion).toBe("success");

    // And the count reaches the check-run output, which is where FR-053 requires it to be visible
    // and where the next round reads it back.
    const concluded = await client.awaitGateConclusion(pullRequest.headSha);
    expect(concluded.conclusion).toBe("success");

    const record = await client.readRoundRecord(pullRequest.headSha);
    expect(record?.excludedPathCount).toBe(2);
  });
});
