import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bothApprove,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  runReview,
  type FixtureClient,
  type FixtureFile,
} from "./harness/index.js";

/**
 * Quickstart scenarios 3, 4, 5, and 6 (tasks.md T059, T060, T061): the rules that need no model.
 *
 * Every scenario in this file scripts **both roles as approving and finding nothing**. That is the
 * design of the file rather than an incidental choice: the constitution's documentation rule
 * (Principle IX), its minimality rule (Principle X), and its size cap are decidable from paths,
 * from the diff, and from the description, so they are enforced by `review/rules/` before the model
 * is called at all. Scripting a clean model and still expecting a blocking finding is what
 * distinguishes a rule the service holds from a judgement the model happened to make — and it is
 * the only arrangement under which a regression that quietly deleted a rule would go red here.
 *
 * Scenarios 5 and 6 are two pull requests carrying the same oversized diff rather than one pull
 * request reviewed twice. Editing a description does not move the head revision, so a second review
 * of the same pull request is stopped by FR-046's forward-progress check before it reaches the size
 * rule — the scenario would test the progress detector instead of the thing it is about. Two pull
 * requests differing only in the description preserve what scenarios 5 and 6 actually contrast.
 */

/** Comfortably past `maxPullRequestSize` (400) and comfortably under `maxReviewableDiffSize` (2000). */
const OVERSIZED_LINES = 520;

function oversizedFile(): FixtureFile {
  const lines = Array.from(
    { length: OVERSIZED_LINES },
    (_unused, index) => `export const value${index} = ${index};`,
  );

  return { path: "src/generated-values.js", content: `${lines.join("\n")}\n` };
}

describe("constitutional rules", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("blocks a behaviour change that updates no document (scenario 3)", async () => {
    const [source, tests] = await Promise.all([
      client.readBaseFile("src/greeting.js"),
      client.readBaseFile("tests/greeting.test.js"),
    ]);

    const pullRequest = await client.openPullRequest({
      label: "scenario-03-missing-document",
      title: "Greet with a title prefix",
      body: "Code and test, but no document — staged for scenario 3.",
      files: [
        {
          path: "src/greeting.js",
          content: source.replace(
            "return options.formal === true ? `Good day, ${name}.` : `Hello, ${name}!`;",
            'return options.formal === true ? `Good day, ${options.title ?? ""}${name}.` : `Hello, ${name}!`;',
          ),
        },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("greet accepts a title", () => {\n  assert.equal(greet("Ada", { formal: true, title: "Dr " }), "Good day, Dr Ada.");\n});\n`,
        },
      ],
    });

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    // The model approved. The block comes from the rule, which is the whole point of Principle IX
    // being a rule rather than a prompt.
    const verdicts = run.records.filter(
      (record) => (record as { event: string }).event === "role.verdict",
    ) as { role: string; verdict: string }[];
    expect(verdicts.every((verdict) => verdict.verdict === "approve")).toBe(true);

    const document = run.outcome.findings.find(
      (finding) => finding.rule === "missing-or-stale-document",
    );
    expect(document).toBeDefined();
    expect(document?.role).toBe("implementation");
    expect(document?.blocking).toBe(true);

    // The test half of the same rule did *not* fire: this change ships one.
    expect(run.outcome.findings.some((finding) => finding.rule === "missing-tests")).toBe(false);

    expect(run.outcome.gate.conclusion).toBe("failure");
    expect((await client.awaitGateConclusion(pullRequest.headSha)).conclusion).toBe("failure");
  });

  it("blocks unrelated content the diff carries (scenario 4)", async () => {
    const [source, tests, document] = await Promise.all([
      client.readBaseFile("src/greeting.js"),
      client.readBaseFile("tests/greeting.test.js"),
      client.readBaseFile("docs/greeting.md"),
    ]);

    // A feature change that also leaves a commented-out statement behind — the category Principle X
    // names as "deleted code lives in version control, not in a comment", and the one the service
    // decides without a model.
    const pullRequest = await client.openPullRequest({
      label: "scenario-04-minimality",
      title: "Let the caller pick the punctuation",
      body: "The feature, plus a leftover the feature did not need — staged for scenario 4.",
      files: [
        {
          path: "src/greeting.js",
          content: source.replace(
            "return options.formal === true ? `Good day, ${name}.` : `Hello, ${name}!`;",
            "// return options.formal === true ? `Good day, ${name}.` : `Hello, ${name}!`;\n" +
              "  return options.formal === true\n" +
              "    ? `Good day, ${name}.`\n" +
              '    : `Hello, ${name}${options.punctuation ?? "!"}`;',
          ),
        },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("greet takes the caller's punctuation", () => {\n  assert.equal(greet("Ada", { punctuation: "?" }), "Hello, Ada?");\n});\n`,
        },
        {
          path: "docs/greeting.md",
          content: `${document}\nThe caller may supply `.concat("`punctuation`", ".\n"),
        },
      ],
    });

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    const minimality = run.outcome.findings.find((finding) =>
      finding.rule.startsWith("minimality:"),
    );

    expect(minimality).toBeDefined();
    expect(minimality?.rule).toBe("minimality:dead-code");
    expect(minimality?.role).toBe("implementation");

    // Blocking is stated by the rule rather than derived from the configured threshold: a
    // repository that raised its threshold must not be able to switch Principle X off as a side
    // effect (FR-042).
    expect(minimality?.blocking).toBe(true);

    expect(run.outcome.gate.conclusion).toBe("failure");

    // And it names the unrelated content by anchoring to the line that carries it, so "what has to
    // go" is a location rather than a description the author has to hunt for.
    const posted = await client.readOwnFindings(pullRequest.number);
    const anchored = posted.find((finding) => finding.rule === "minimality:dead-code");
    expect(anchored?.path).toBe("src/greeting.js");
    expect(anchored?.line).toBeGreaterThan(0);
    expect(anchored?.blocking).toBe(true);
  });

  it("blocks an oversized pull request that states no justification (scenario 5)", async () => {
    const pullRequest = await client.openPullRequest({
      label: "scenario-05-oversized",
      title: "Add generated value constants",
      body: "No size justification — staged for scenario 5.",
      files: [oversizedFile()],
    });

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    const size = run.outcome.findings.find((finding) => finding.rule === "pull-request-size");
    expect(size).toBeDefined();
    expect(size?.role).toBe("implementation");
    expect(size?.blocking).toBe(true);

    expect(run.outcome.gate.conclusion).toBe("failure");

    // The reviewable cap is a different, larger limit, and this diff is under it: the run reviewed
    // rather than refusing, which is what makes this a finding and not a stop (FR-037 against
    // FR-043).
    expect(run.outcome.stoppedBeforeSpending).toBe(false);
    expect(run.model.requestsFor("implementation")).toHaveLength(1);
  });

  it("clears the size cap on a stated justification, leaving other checks in force (scenario 6)", async () => {
    const pullRequest = await client.openPullRequest({
      label: "scenario-06-justified",
      title: "Add generated value constants",
      body: [
        "The same change as scenario 5, with the escape Principle X defines.",
        "",
        "## Size justification",
        "",
        "The constants are a single generated table; splitting it would produce files that do not",
        "compile independently, so the change is irreducible.",
      ].join("\n"),
      files: [oversizedFile()],
    });

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    // The size finding does not fire.
    expect(run.outcome.findings.some((finding) => finding.rule === "pull-request-size")).toBe(
      false,
    );

    // The other checks still do. A justification clears the size cap and nothing else — this
    // change still ships no test and no document.
    const rules = run.outcome.findings.map((finding) => finding.rule);
    expect(rules).toContain("missing-tests");
    expect(rules).toContain("missing-or-stale-document");

    expect(run.outcome.gate.conclusion).toBe("failure");
  });
});
