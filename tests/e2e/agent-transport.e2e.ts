import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  anchoredFinding,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  response,
  runReviewOnAgentTransport,
  scriptedHarness,
  type FixtureClient,
  type FixturePullRequest,
} from "./harness/index.js";

/**
 * The `agent-sdk` transport, end to end (spec 003, Principle II, feature gate 2).
 *
 * Every other scenario in this suite substitutes `ScriptedModelClient`, which replaces the model
 * boundary whole. On this transport that would skip the thing under test: the adapter the service
 * actually constructs — its prompt assembly, its three tool refusals, its scoped environment, its
 * JSON extraction, its schema validation, its usage folding — would all be bypassed, and the layer
 * meant to catch integration defects would be exercising a class production never builds. So here
 * the real `AgentSdkModelClient` runs and only the SDK's `query` is scripted.
 *
 * That distinction is not theoretical. Three defects on this transport reached review *with a green
 * unit suite*: `allowedTools: []` meant "nothing pre-approved" rather than "no tools", the child
 * process inherited the orchestrator's whole environment including the exhausted API key, and a
 * usage message in an unrecognised shape recorded a real review as free. Each was a claim about an
 * external contract that unit tests written by the same author could only confirm to itself.
 *
 * The response is fenced on purpose. A harness-driven answer wrapping its JSON in a code fence is
 * the likeliest way this transport's output differs from a schema-constrained one, so the scenario
 * drives `extractJson` rather than stepping around it.
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

    // The whole point of the scenario: the gate concluded from a finding that arrived as fenced
    // JSON out of a scripted harness, through the real adapter, on the real check-run write.
    expect(run.outcome.gate.conclusion).toBe("failure");
    expect(run.adapters.settings.settings.modelTransport).toBe("agent-sdk");

    // Both roles reached the model. Neither is scripted apart — the prompt carries no role marker,
    // which is a property of this transport rather than an omission here.
    const verdicts = run.records.filter((r) => (r as { event: string }).event === "role.verdict");
    expect(verdicts).toHaveLength(2);

    // The prompt the harness received is the one the injection guard shapes: reviewed content
    // arrives delimited as data, and the schema is reproduced because this transport cannot
    // constrain the reply (FR-036, FR-057).
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

    // SC-002, exercised rather than asserted: no model credential is resolvable, and the run still
    // completes. `checkPrerequisites` sees a source rather than an absence.
    expect(run.adapters.modelCredential).toEqual({ source: "agent-sdk", apiKey: null });

    const concluded = run.records.find(
      (r) => (r as { event: string }).event === "run.concluded",
    ) as { usage: { tokensConsumed: number } } | undefined;

    // Two roles at 800 + 4,000 input and 90 output each. Asserted as a floor rather than an exact
    // figure, because what matters is that the cached half was counted at all — the defect this
    // guards against recorded a real review as free.
    expect(concluded?.usage.tokensConsumed).toBeGreaterThanOrEqual((800 + 4_000 + 90) * 2);
  });
});
