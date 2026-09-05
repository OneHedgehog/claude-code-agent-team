import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  anchoredFinding,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  response,
  runReviewOnAgentTransport,
  scriptedHarness,
  toolSeekingHarness,
  type FixtureClient,
  type FixturePullRequest,
} from "./harness/index.js";

/**
 * The `agent-sdk` transport, end to end (spec 003, Principle II, feature gate 2).
 *
 * `ScriptedModelClient` replaces the model boundary whole, which on this transport would skip the
 * adapter under test entirely. Here the composition root builds the real client and only the SDK's
 * `query` is scripted.
 *
 * That distinction earned itself: three defects on this transport reached review with a green unit
 * suite, each a claim about an external contract that unit tests by the same author could only
 * confirm to themselves. The scripted response is fenced on purpose, so `extractJson` runs.
 */

describe("the subscription-backed transport, driven end to end", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  async function openPullRequest(label: string): Promise<FixturePullRequest> {
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
          content: `${document}\n\nThe caller may choose punctuation.\n`,
        },
      ],
    });
  }

  it("carries a blocking finding from the harness to a failed gate", async () => {
    const pullRequest = await openPullRequest("agent-transport-blocking");
    // The verdict is derived from the finding rather than stated, exactly as `gate.ts` derives a
    // role's decision — a script that said `approve` while carrying a blocking finding would assert
    // on a combination the service cannot produce.
    const harness = scriptedHarness(response([anchoredFinding("src/greeting.js", 1)]));

    const run = await runReviewOnAgentTransport({ client, pullRequest, agentQuery: harness });

    // A finding that arrived as fenced JSON, through the real adapter, onto a real check run.
    expect(run.outcome.gate.conclusion).toBe("failure");
    expect(run.adapters.settings.settings.modelTransport).toBe("agent-sdk");

    // Both roles reached the model. The prompt carries no role marker, so neither is scripted apart.
    const verdicts = run.records.filter((r) => (r as { event: string }).event === "role.verdict");
    expect(verdicts).toHaveLength(2);

    // Reviewed content arrives delimited as data, with the schema reproduced (FR-036, FR-057).
    expect(harness.prompts[0]).toContain("--- BEGIN DIFF ---");
    expect(harness.prompts[0]).toContain("replyJudgements");
  });

  it("spends tokens the ledger can see, on a transport that resolves no credential", async () => {
    const pullRequest = await openPullRequest("agent-transport-approve");
    const harness = scriptedHarness(response(), {
      input_tokens: 800,
      output_tokens: 90,
      // Folded into input rather than dropped: the harness caches its own prefix, and a ledger
      // ignoring cached tokens under-counts exactly the spend the cache makes cheap (FR-031).
      cache_read_input_tokens: 4_000,
    });

    const run = await runReviewOnAgentTransport({ client, pullRequest, agentQuery: harness });

    // SC-002 exercised: no credential is resolvable and the run still completes.
    expect(run.adapters.modelCredential).toEqual({ source: "agent-sdk", apiKey: null });

    const concluded = run.records.find(
      (r) => (r as { event: string }).event === "run.concluded",
    ) as { usage: { tokensConsumed: number } } | undefined;

    // A floor, not an exact figure: what matters is that the cached half was counted at all.
    expect(concluded?.usage.tokensConsumed).toBeGreaterThanOrEqual((800 + 4_000 + 90) * 2);
  });

  it("records a refused tool through the composed system, not just at the adapter", async () => {
    // The refusal path end to end. Unit tests cover the option and the callback; nothing covered
    // the two-line lambda in the composition root that carries a refusal into the record stream.
    const pullRequest = await openPullRequest("agent-transport-refusal");
    const harness = toolSeekingHarness();

    const run = await runReviewOnAgentTransport({ client, pullRequest, agentQuery: harness });

    // The harness asked, and was told no — once per role, since both reach the model.
    expect(harness.denied).toEqual(["Bash", "Bash"]);

    // And the run said so. This is the assertion that fails if the root stops wiring the callback.
    const refusals = run.records.filter((r) => (r as { event: string }).event === "tool.refused");
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toMatchObject({ tool: { name: "Bash" } });

    // Fails closed, as an interrupted turn rather than as a malformed response.
    expect(run.outcome.gate.conclusion).toBe("failure");
  });
});
