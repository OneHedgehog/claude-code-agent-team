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
  type FixturePullRequest,
} from "./harness/index.js";

/**
 * Quickstart scenarios 1 and 20 (tasks.md T035, T036).
 *
 * The two halves of what the gate is for. Scenario 1 is the only path on which it may pass at all:
 * every required role approved *this* revision and nothing blocks. Scenario 20 is the path that
 * proves an approval cannot be assembled out of partial agreement — the security reviewer blocks
 * what the implementation reviewer accepts, and the gate fails.
 *
 * Scenario 20's second assertion is the one that is easy to get backwards. Precedence *settles*
 * that disagreement: security outranks implementation, so its finding stands, the contradiction is
 * recorded, and **nothing is escalated**, because nothing is unresolved (FR-048). Escalation is
 * reserved for a tie between roles of equal authority, which these two are not (FR-049). A suite
 * that asserted only "the gate failed" would pass just as happily against a service that escalated
 * every disagreement, which is the behaviour FR-048 exists to rule out.
 */

describe("gating verdict", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  /**
   * "Clean" means clean against the rules that need no model as well. The implementation role runs
   * `checkDocumentation` before the model call, so a source change shipping no test and no document
   * is blocking on its own — a pull request touching only `src/` would fail scenario 1 for reasons
   * that have nothing to do with either verdict.
   */
  async function openCleanPullRequest(label: string): Promise<FixturePullRequest> {
    const [source, tests, document] = await Promise.all([
      client.readBaseFile("src/greeting.js"),
      client.readBaseFile("tests/greeting.test.js"),
      client.readBaseFile("docs/greeting.md"),
    ]);

    return client.openPullRequest({
      label,
      title: "Greet with an exclamation the caller chooses",
      body: "A behaviour change, its test, and its document, in one pull request.",
      files: [
        {
          path: "src/greeting.js",
          content: source.replace(
            "return options.formal === true ? `Good day, ${name}.` : `Hello, ${name}!`;",
            'return options.formal === true ? `Good day, ${name}.` : `Hello, ${name}${options.punctuation ?? "!"}`;',
          ),
        },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("greet takes the caller's punctuation", () => {\n  assert.equal(greet("Ada", { punctuation: "?" }), "Hello, Ada?");\n});\n`,
        },
        {
          path: "docs/greeting.md",
          content: document.replace(
            '| `greet("Ada")` | `Hello, Ada!` |',
            '| `greet("Ada")` | `Hello, Ada!` |\n| `greet("Ada", { punctuation: "?" })` | `Hello, Ada?` |',
          ),
        },
      ],
    });
  }

  it("concludes success when both roles approve the revision (scenario 1)", async () => {
    const pullRequest = await openCleanPullRequest("scenario-01-clean");

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    // Both required roles were actually asked. A gate that passed having consulted one role would
    // satisfy every other assertion here (FR-005).
    expect(run.model.requestsFor("security")).toHaveLength(1);
    expect(run.model.requestsFor("implementation")).toHaveLength(1);

    expect(run.outcome.stoppedBeforeSpending).toBe(false);
    expect(run.outcome.findings).toHaveLength(0);
    expect(run.outcome.gate.conclusion).toBe("success");

    // Each role's verdict is bound to the revision under review, never to "the pull request"
    // (FR-009).
    const verdicts = run.records.filter(
      (record) => (record as { event: string }).event === "role.verdict",
    ) as { role: string; verdict: string; revision: string }[];

    expect(verdicts.map((verdict) => verdict.role).sort()).toEqual(["implementation", "security"]);
    expect(verdicts.every((verdict) => verdict.verdict === "approve")).toBe(true);
    expect(verdicts.every((verdict) => verdict.revision === pullRequest.headSha)).toBe(true);

    // And the App reported it, on this revision, where branch protection reads it.
    const concluded = await client.awaitGateConclusion(pullRequest.headSha);
    expect(concluded.conclusion).toBe("success");
    expect(concluded.headSha).toBe(pullRequest.headSha);
  });

  it("fails when security blocks what implementation accepts, and does not escalate (scenario 20)", async () => {
    const pullRequest = await openCleanPullRequest("scenario-20-precedence");

    const run = await runReview({
      client,
      pullRequest,
      script: script({
        security: response([anchoredFinding("src/greeting.js", 22, { rule: "scripted-security" })]),
        implementation: response(),
      }),
    });

    // The security finding stands. Nothing about the implementation reviewer's approval softens
    // it, resolves it, or downgrades it (FR-048).
    expect(run.outcome.findings).toHaveLength(1);
    const [finding] = run.outcome.findings;
    expect(finding?.role).toBe("security");
    expect(finding?.blocking).toBe(true);
    expect(finding?.status).toBe("open");

    expect(run.outcome.gate.conclusion).toBe("failure");

    const concluded = await client.awaitGateConclusion(pullRequest.headSha);
    expect(concluded.conclusion).toBe("failure");

    // The contradiction is recorded rather than discarded: precedence settled it, and a settled
    // disagreement that left no trace would be indistinguishable from one nobody noticed.
    const contradictions = run.records.filter(
      (record) => (record as { event: string }).event === "roles.contradiction_recorded",
    );
    expect(contradictions).toHaveLength(1);

    // And it is *not* escalated. Security outranks implementation, so there is no tie and nothing
    // for a human to break (FR-048 against FR-049).
    const escalated = run.records.filter(
      (record) => (record as { event: string }).event === "roles.disagreement_escalated",
    );
    expect(escalated).toHaveLength(0);

    const causes = await client.readEscalationCauses(pullRequest.number);
    expect(causes).not.toContain("roles.disagreement");
  });
});
