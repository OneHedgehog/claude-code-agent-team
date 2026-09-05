import { describe, expect, it } from "vitest";

import {
  AgentSdkModelClient,
  extractJson,
  HARNESS_NOT_AUTHENTICATED,
  scopedEnvironment,
  type AgentQuery,
} from "../../../src/model/agent-sdk.js";
import { ModelError, type ReviewRequest } from "../../../src/model/client.js";

const WELL_FORMED = JSON.stringify({
  findings: [
    {
      rule: "hardcoded-credential",
      severity: "critical",
      blocking: true,
      location: { pullRequestLevel: false, path: "src/cli.ts", line: 3, side: "RIGHT" },
      description: "A key is committed here.",
    },
  ],
  verdict: "request-changes",
  replyJudgements: [],
});

function request(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    runId: "run-1",
    role: "security",
    effort: "high",
    diff: "@@ -1 +1 @@\n+const a = 1;",
    constitution: "# Constitution",
    pullRequestContext: { title: "Add a thing", body: "Implements the spec.", specPaths: [] },
    priorFindings: [],
    maxTokens: 8000,
    ...overrides,
  };
}

/** Stands in for the harness, recording what it was asked so a test can assert on it. */
function fakeQuery(text: string, usage?: Record<string, number>) {
  const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
  const fn = (input: { prompt: unknown; options?: Record<string, unknown> }) => {
    calls.push({ prompt: input.prompt, options: input.options ?? {} });

    // eslint-disable-next-line @typescript-eslint/require-await
    return (async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text }] } };
      yield { type: "result", usage: usage ?? { input_tokens: 100, output_tokens: 20 } };
    })();
  };

  return Object.assign(fn, { calls }) as unknown as AgentQuery & { calls: typeof calls };
}

describe("the harness is asked for a review and nothing else (FR-036, Principle V)", () => {
  it("exposes no tools, using the option that actually withholds them", async () => {
    // The diff is attacker-influenced data and this transport spawns a harness whose default
    // posture is tool-bearing, so this is the whole of the guard on this path.
    //
    // `tools` is the option that means "no tools", and the distinction is not pedantry: the SDK
    // documents `allowedTools` as "tool names that are auto-allowed without prompting for
    // permission" and says outright "to restrict which tools are available, use the `tools` option
    // instead". An earlier revision asserted only `allowedTools: []`, which left every tool defined
    // and merely un-approved -- a permission prompt with nobody present to answer it.
    const messages = fakeQuery(WELL_FORMED);
    await new AgentSdkModelClient({ agentQuery: messages }).review(request());

    expect(messages.calls[0]?.options["tools"]).toEqual([]);
  });

  it("pre-approves nothing either", async () => {
    const messages = fakeQuery(WELL_FORMED);
    await new AgentSdkModelClient({ agentQuery: messages }).review(request());

    expect(messages.calls[0]?.options["allowedTools"]).toEqual([]);
  });

  it("refuses a tool at the moment of use, whatever the other two options turn out to mean", async () => {
    // The belt-and-braces line. `tools: []` should make this unreachable; it exists because the
    // other two assertions are claims about an external contract, and a guard over untrusted input
    // must not rest on any one of them being read the way its documentation reads today.
    const messages = fakeQuery(WELL_FORMED);
    const refused: string[] = [];
    await new AgentSdkModelClient({
      agentQuery: messages,
      onRefusedTool: (name) => refused.push(name),
    }).review(request());

    const canUseTool = messages.calls[0]?.options["canUseTool"] as (
      toolName: string,
    ) => Promise<{ behavior: string }>;

    expect(await canUseTool("Bash")).toMatchObject({ behavior: "deny" });
    // And it is audible. A reviewed diff talking a tool-less reviewer into reaching for a tool is
    // the single most important thing a run could have to say (FR-024).
    expect(refused).toEqual(["Bash"]);
  });

  it("runs in an empty directory rather than the orchestrator's own tree", async () => {
    // `cwd` defaults to `process.cwd()` -- the tree holding `.agents/settings.json`, the App
    // configuration and every other checkout. If any refusal above were wrong, that was the
    // fallback the harness would have been standing in.
    const messages = fakeQuery(WELL_FORMED);
    await new AgentSdkModelClient({ agentQuery: messages }).review(request());

    const cwd = String(messages.calls[0]?.options["cwd"]);
    expect(cwd).not.toBe(process.cwd());
    expect(cwd.startsWith(process.cwd())).toBe(false);
  });

  it("hands the harness an allowlisted environment, not the orchestrator's own", async () => {
    // The environment was the last dimension still inherited whole, after tools, settings and cwd
    // had each been narrowed. The SDK replaces the child's environment when `env` is set rather
    // than merging it, so an allowlist is possible -- and an allowlist is what this must be: a
    // deny-list needs updating every time a new secret enters the parent, and forgetting is silent.
    const messages = fakeQuery(WELL_FORMED);
    await new AgentSdkModelClient({
      agentQuery: messages,
      env: {
        PATH: "/usr/bin",
        HOME: "/Users/reviewer",
        ANTHROPIC_API_KEY: "sk-exhausted",
        GITHUB_MCP_PAT: "ghp-secret",
        AWS_SECRET_ACCESS_KEY: "also-secret",
      },
    }).review(request());

    expect(messages.calls[0]?.options["env"]).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/reviewer",
      // Present and empty rather than absent -- see the next test.
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
    });
  });

  it("withholds the exhausted API key specifically, so the transport cannot be metered to it", () => {
    // The finding that produced this was not about hardening. This transport exists *because* the
    // credits behind `ANTHROPIC_API_KEY` ran out, and on a host still configured for `api` -- the
    // default -- that key is in `process.env`. Inherited, the harness might authenticate with it,
    // meter every "subscription-funded" review against the exhausted balance, and rebuild the
    // deadlock this transport was written to end, while the record claimed otherwise.
    //
    // Asserted rather than reasoned about: the key is not there to win with, so which credential
    // the harness would have preferred never has to be answered (FR-063).
    const scoped = scopedEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/reviewer",
      USER: "reviewer",
      ANTHROPIC_API_KEY: "sk-exhausted",
      ANTHROPIC_AUTH_TOKEN: "also-exhausted",
    });

    // Present and empty, not absent. Measured behaviour is that the SDK *replaces* the child's
    // environment rather than merging it over `process.env`, which would make omission enough --
    // but omission is only enough under that reading, and this transport has already shipped two
    // defects of exactly that shape. An empty value neutralises the credential either way.
    expect(scoped["ANTHROPIC_API_KEY"]).toBe("");
    expect(scoped["ANTHROPIC_AUTH_TOKEN"]).toBe("");
    // And the two the harness genuinely needs still reach it. `USER` is not cosmetic: without it
    // the harness does not reach the subscription at all and falls back to a metered path.
    expect(scoped["HOME"]).toBe("/Users/reviewer");
    expect(scoped["USER"]).toBe("reviewer");
  });

  it("inherits no settings, so the same revision reviews the same on any machine", async () => {
    const messages = fakeQuery(WELL_FORMED);
    await new AgentSdkModelClient({ agentQuery: messages }).review(request());

    expect(messages.calls[0]?.options["settingSources"]).toEqual([]);
  });

  it("takes exactly one turn: a review is a question, not a conversation", async () => {
    const messages = fakeQuery(WELL_FORMED);
    await new AgentSdkModelClient({ agentQuery: messages }).review(request());

    expect(messages.calls[0]?.options["maxTurns"]).toBe(1);
  });

  it("carries the standing instruction as the system prompt, where reviewed content cannot displace it", async () => {
    const messages = fakeQuery(WELL_FORMED);
    await new AgentSdkModelClient({ agentQuery: messages }).review(request());

    expect(String(messages.calls[0]?.options["systemPrompt"])).toContain("DATA");
  });

  it("spends the configured effort, which the run reports as effective (FR-054)", async () => {
    // Every run reports `modelEffort` in its effective settings. Before this assertion existed the
    // agent transport ignored it, so a run configured `max` reported `max` and behaved like `low`
    // -- a value nobody could see through, reported as though they could.
    const messages = fakeQuery(WELL_FORMED);
    await new AgentSdkModelClient({ agentQuery: messages }).review(request({ effort: "max" }));

    expect(messages.calls[0]?.options["effort"]).toBe("max");
    expect(messages.calls[0]?.options["thinking"]).toEqual({ type: "adaptive" });
  });

  it("reproduces the schema in the prompt, since this transport cannot constrain the reply", async () => {
    const messages = fakeQuery(WELL_FORMED);
    await new AgentSdkModelClient({ agentQuery: messages }).review(request());

    const prompt = String(messages.calls[0]?.prompt);
    expect(prompt).toContain("replyJudgements");
    expect(prompt).toContain("--- BEGIN DIFF ---");
  });
});

describe("the response is consumed through the schema, exactly as on the API transport", () => {
  it("returns the structured findings and verdict", async () => {
    const client = new AgentSdkModelClient({ agentQuery: fakeQuery(WELL_FORMED) });

    const response = await client.review(request());

    expect(response.verdict).toBe("request-changes");
    expect(response.findings[0]?.location).toEqual({ path: "src/cli.ts", line: 3, side: "RIGHT" });
  });

  it("rejects prose rather than parsing it (FR-007)", async () => {
    const client = new AgentSdkModelClient({
      agentQuery: fakeQuery("I reviewed it and it looks fine to me."),
    });

    await expect(client.review(request())).rejects.toThrow(ModelError);
  });

  it("reports a refused location rather than downgrading it silently", async () => {
    const rejected: { path: string; reason: string }[] = [];
    const traversal = WELL_FORMED.replace("src/cli.ts", "../../etc/passwd");
    const client = new AgentSdkModelClient({
      agentQuery: fakeQuery(traversal),
      onRejectedLocation: (r) => rejected.push(r),
    });

    const response = await client.review(request());

    expect(rejected).toHaveLength(1);
    expect(response.findings[0]?.location).toEqual({ pullRequestLevel: true });
  });

  it("counts cached tokens as consumed, so the ledger cannot under-count", async () => {
    const client = new AgentSdkModelClient({
      agentQuery: fakeQuery(WELL_FORMED, {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 26_000,
        cache_read_input_tokens: 4_000,
      }),
    });

    const response = await client.review(request());

    // The harness caches its own prefix and reports it separately; ignoring it would hide the
    // majority of what the run actually processed (FR-031).
    expect(response.usage.inputTokens).toBe(10 + 26_000 + 4_000);
    expect(response.usage.outputTokens).toBe(20);
  });

  it("raises ModelError carrying the spend when the harness fails part-way through", async () => {
    // Typed the way every other fake here is typed. An earlier revision wrote `as never`, which
    // erased the call signature entirely: a plain throwing function -- which never enters the async
    // iteration, and so is not the path under test at all -- passed the test just as well.
    const failing = Object.assign(
      () =>
        // eslint-disable-next-line @typescript-eslint/require-await
        (async function* () {
          yield { type: "result", usage: { input_tokens: 700, output_tokens: 40 } };
          throw new Error("harness exited");
        })(),
      { calls: [] },
    ) as unknown as AgentQuery;

    const error = await new AgentSdkModelClient({ agentQuery: failing })
      .review(request())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelError);
    // The second half of the contract, and the half the previous test dropped: what a failed call
    // consumed is still spend, and a ledger that lost it would under-count (FR-031).
    expect((error as ModelError).usage).toEqual({ inputTokens: 700, outputTokens: 40 });
  });

  it("names an unauthenticated harness rather than folding it into a generic failure", async () => {
    // FR-051's presence check passes by construction on this transport, so the failure it exists to
    // catch arrives at review time instead. It cannot be prevented from here without spending a
    // call to find out -- but it can be said, rather than surfacing as `model call failed: 401`.
    const unauthenticated = Object.assign(
      () =>
        // eslint-disable-next-line require-yield, @typescript-eslint/require-await
        (async function* () {
          throw new Error("401 Unauthorized");
        })(),
      { calls: [] },
    ) as unknown as AgentQuery;

    await expect(
      new AgentSdkModelClient({ agentQuery: unauthenticated }).review(request()),
    ).rejects.toThrow(HARNESS_NOT_AUTHENTICATED);
  });

  it("refuses to record a review whose usage arrived in a shape it does not recognise", async () => {
    // The null guard alone checked that a usage-bearing message *arrived*, not that anything was
    // counted. A renamed field in a later SDK release maps to `0` through `count()`, which is not
    // `null`, so a real review that spent real tokens reached the ledger as free. A completed
    // review costs tokens by construction, so zero here only ever means "not counted".
    const renamed = Object.assign(
      () =>
        // eslint-disable-next-line @typescript-eslint/require-await
        (async function* () {
          yield { type: "assistant", message: { content: [{ type: "text", text: WELL_FORMED }] } };
          yield { type: "result", usage: { inputTokenCount: 900, outputTokenCount: 40 } };
        })(),
      { calls: [] },
    ) as unknown as AgentQuery;

    await expect(
      new AgentSdkModelClient({ agentQuery: renamed }).review(request()),
    ).rejects.toThrow(/cannot be metered/);
  });

  it("refuses to record a review the harness never metered", async () => {
    // A stream that ends without a usage-bearing result once recorded a completed review at zero
    // tokens -- an under-count in the ledger rather than an error. Principle IV would rather stop.
    const silent = Object.assign(
      () =>
        // eslint-disable-next-line @typescript-eslint/require-await
        (async function* () {
          yield { type: "assistant", message: { content: [{ type: "text", text: WELL_FORMED }] } };
        })(),
      { calls: [] },
    ) as unknown as AgentQuery;

    await expect(new AgentSdkModelClient({ agentQuery: silent }).review(request())).rejects.toThrow(
      /cannot be metered/,
    );
  });
});

describe("extractJson widens what is accepted, never what is trusted", () => {
  it("takes the object out of a fenced block", () => {
    expect(extractJson('```json\n{"verdict":"approve"}\n```')).toEqual({ verdict: "approve" });
  });

  it("takes the object out of an answer with preamble", () => {
    expect(extractJson('Here is my review:\n{"verdict":"approve"}')).toEqual({
      verdict: "approve",
    });
  });

  it("passes prose through unchanged, so the parser still rejects it", () => {
    // Deliberately not an error here: this function widens the shapes the parser sees, and the
    // parser is what decides. Swallowing a malformed answer would be the failure FR-007 forbids.
    expect(extractJson("no json at all")).toBe("no json at all");
  });

  it("passes malformed JSON through rather than guessing at a repair", () => {
    expect(extractJson('{"verdict": ')).toBe('{"verdict":');
  });
});
