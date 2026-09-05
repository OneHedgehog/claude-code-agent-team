import { describe, expect, it } from "vitest";

import { AgentSdkModelClient, extractJson, type AgentQuery } from "../../../src/model/agent-sdk.js";
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
  it("grants no tools at all", async () => {
    // The diff is attacker-influenced data. This transport spawns a harness whose default posture
    // is tool-bearing, so the empty list is the whole of the guard on this path -- deleting it
    // would let a reviewed diff persuade the reviewer to read a file or run a command.
    const messages = fakeQuery(WELL_FORMED);
    await new AgentSdkModelClient({ agentQuery: messages }).review(request());

    expect(messages.calls[0]?.options["allowedTools"]).toEqual([]);
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

  it("raises ModelError carrying the spend when the harness itself fails", async () => {
    const failing = (() => {
      // eslint-disable-next-line require-yield, @typescript-eslint/require-await
      return (async function* () {
        throw new Error("harness exited");
      })();
    }) as never;

    await expect(
      new AgentSdkModelClient({ agentQuery: failing }).review(request()),
    ).rejects.toThrow(ModelError);
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
