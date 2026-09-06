import { describe, expect, it } from "vitest";

import {
  AgentSdkModelClient,
  extractJson,
  HARNESS_FELL_BACK_TO_METERED,
  HARNESS_LIMIT_REACHED,
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
    // `tools` withholds; `allowedTools` only pre-approves. An earlier revision asserted the
    // second alone, which left every tool defined and merely unapproved (FR-058).
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
    // The refusal that does not depend on the SDK's option semantics (FR-058).
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
    // Not containment -- tidiness. `cwd` defaults to the orchestrator's own tree.
    const messages = fakeQuery(WELL_FORMED);
    await new AgentSdkModelClient({ agentQuery: messages }).review(request());

    const cwd = String(messages.calls[0]?.options["cwd"]);
    expect(cwd).not.toBe(process.cwd());
    expect(cwd.startsWith(process.cwd())).toBe(false);
  });

  it("hands the harness an allowlisted environment, not the orchestrator's own", async () => {
    // An allowlist, not a subtraction: a deny-list needs updating whenever a new secret enters
    // the parent, and forgetting is silent (FR-063).
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
    // Not hardening: this transport exists because the credits behind that key ran out, and on a
    // host still configured for `api` the key is in `process.env` (FR-063).
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
    // Reported as effective on every run, so it must take effect (FR-060).
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
    // Typed as `AgentQuery` rather than `as never`. The cast erased the call signature, so a fake
    // that threw without ever entering the async iteration satisfied this test too.
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

  it("refuses to record a review whose result carried a usage key with no value", async () => {
    // `in` is true for a key set to `undefined`, which reads as an all-zero total (FR-062).
    const empty = Object.assign(
      () =>
        // eslint-disable-next-line @typescript-eslint/require-await
        (async function* () {
          yield { type: "assistant", message: { content: [{ type: "text", text: WELL_FORMED }] } };
          yield { type: "result", subtype: "success", usage: undefined };
        })(),
      { calls: [] },
    ) as unknown as AgentQuery;

    await expect(new AgentSdkModelClient({ agentQuery: empty }).review(request())).rejects.toThrow(
      /cannot be metered/,
    );
  });

  it("names an early-ended turn rather than reporting it as a schema violation", async () => {
    // A refused tool interrupts the turn, and would otherwise read as malformed JSON.
    const interrupted = Object.assign(
      () =>
        // eslint-disable-next-line @typescript-eslint/require-await
        (async function* () {
          yield { type: "assistant", message: { content: [{ type: "text", text: WELL_FORMED }] } };
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            usage: { input_tokens: 500, output_tokens: 10 },
          };
        })(),
      { calls: [] },
    ) as unknown as AgentQuery;

    await expect(
      new AgentSdkModelClient({ agentQuery: interrupted }).review(request()),
    ).rejects.toThrow(/ended the turn early \(error_during_execution\)/);
  });

  it("names a refusal as the cause when reviewed content is what ended the turn", async () => {
    // `error_during_execution` traces to nothing. A refusal is the one cause the author can act
    // on, so it is what the gate states (FR-064).
    const seeking = Object.assign(
      (input: {
        options?: {
          canUseTool?: (n: string, i: Record<string, unknown>, o: unknown) => Promise<unknown>;
        };
      }) =>
        (async function* () {
          await input.options?.canUseTool?.("Bash", {}, {});
          yield { type: "result", subtype: "error_during_execution", usage: undefined };
        })(),
      { calls: [] },
    ) as unknown as AgentQuery;

    await expect(
      new AgentSdkModelClient({ agentQuery: seeking }).review(request()),
    ).rejects.toThrow(/attempted to use a tool/);
  });

  it("abandons a harness that does not answer, rather than holding the only review slot", async () => {
    // Nothing else bounds time, and `maxConcurrentReviews: 1` means a hung review holds the only
    // slot forever (FR-066).
    // Two doubles, because the reason must not depend on how the SDK reacts to the signal. One
    // raises on abort; the other ends the stream normally, which would otherwise fall through to
    // the metering guard and report a cancelled review as an accounting defect (FR-066).
    const raising = Object.assign(
      (input: { options?: { abortController?: AbortController } }) =>
        // eslint-disable-next-line require-yield
        (async function* () {
          await new Promise((resolve) => {
            input.options?.abortController?.signal.addEventListener("abort", resolve);
          });
          throw new Error("aborted");
        })(),
      { calls: [] },
    ) as unknown as AgentQuery;

    const returning = Object.assign(
      (input: { options?: { abortController?: AbortController } }) =>
        // eslint-disable-next-line require-yield
        (async function* () {
          await new Promise((resolve) => {
            input.options?.abortController?.signal.addEventListener("abort", resolve);
          });
        })(),
      { calls: [] },
    ) as unknown as AgentQuery;

    for (const agentQuery of [raising, returning]) {
      await expect(
        new AgentSdkModelClient({ agentQuery, deadlineMs: 25 }).review(request()),
      ).rejects.toThrow(/did not answer within/);
    }
  });

  it("refuses to record a review whose usage arrived in a shape it does not recognise", async () => {
    // A completed review costs tokens by construction, so zero only ever means "not counted"
    // (FR-062).
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

  it("names a subscription limit rather than reporting a generic failure", async () => {
    // Demonstrated, not hypothetical: round 4 of this feature's own review hit one (FR-065).
    const limited = Object.assign(
      () =>
        // eslint-disable-next-line require-yield, @typescript-eslint/require-await
        (async function* () {
          throw new Error("Claude Code returned an error result: You've hit your session limit");
        })(),
      { calls: [] },
    ) as unknown as AgentQuery;

    await expect(
      new AgentSdkModelClient({ agentQuery: limited }).review(request()),
    ).rejects.toThrow(HARNESS_LIMIT_REACHED);
  });

  it("names the metered fallback, which is the failure FR-063 exists to prevent", async () => {
    // The one failure this transport is *for* was the only one without a name (FR-063).
    const fellBack = Object.assign(
      () =>
        // eslint-disable-next-line require-yield, @typescript-eslint/require-await
        (async function* () {
          throw new Error("Credit balance is too low. Please go to Plans & Billing");
        })(),
      { calls: [] },
    ) as unknown as AgentQuery;

    await expect(
      new AgentSdkModelClient({ agentQuery: fellBack }).review(request()),
    ).rejects.toThrow(HARNESS_FELL_BACK_TO_METERED);
  });

  it("charges an abandoned review what its prompt certainly cost, not zero", async () => {
    // An aborted turn yields no `result`, so this failure would otherwise be recorded as free
    // (FR-067).
    const hanging = Object.assign(
      (input: { options?: { abortController?: AbortController } }) =>
        // eslint-disable-next-line require-yield
        (async function* () {
          await new Promise((resolve) => {
            input.options?.abortController?.signal.addEventListener("abort", resolve);
          });
          throw new Error("aborted");
        })(),
      { calls: [] },
    ) as unknown as AgentQuery;

    const error = (await new AgentSdkModelClient({ agentQuery: hanging, deadlineMs: 25 })
      .review(request())
      .catch((e: unknown) => e)) as ModelError;

    expect(error.usage.inputTokens).toBeGreaterThan(0);
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

describe("a reply that misses the schema is asked again, once (spec 004)", () => {
  /** Answers with `first` on the opening ask and `second` afterwards, recording every prompt. */
  function thenAnswers(first: string, second: string) {
    const prompts: string[] = [];
    const fn = (input: { prompt: unknown }) => {
      prompts.push(String(input.prompt));
      const text = prompts.length === 1 ? first : second;

      // eslint-disable-next-line @typescript-eslint/require-await
      return (async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text }] } };
        yield {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 500, output_tokens: 25 },
        };
      })();
    };

    return Object.assign(fn, { prompts }) as unknown as AgentQuery & { prompts: string[] };
  }

  it("recovers a review whose first reply was prose", async () => {
    // The API transport made this impossible through `output_config.format`. Here it is merely
    // rejected — at a rate high enough that a single ask lost roughly a third of role-calls, and
    // a green gate needs both roles to comply at once.
    const harness = thenAnswers("I reviewed it and it looks fine.", WELL_FORMED);

    const response = await new AgentSdkModelClient({ agentQuery: harness }).review(request());

    expect(response.verdict).toBe("request-changes");
    expect(harness.prompts).toHaveLength(2);
  });

  it("tells the model its reply was discarded, rather than repeating the question", async () => {
    const harness = thenAnswers("not json", WELL_FORMED);
    await new AgentSdkModelClient({ agentQuery: harness }).review(request());

    expect(harness.prompts[1]).toContain("did not validate against the schema");
    // And carries none of the rejected reply back: a model that emitted prose must not be handed
    // its own prose as context.
    expect(harness.prompts[1]).not.toContain("not json");
  });

  it("charges both attempts, since both were spent", async () => {
    const harness = thenAnswers("not json", WELL_FORMED);
    const response = await new AgentSdkModelClient({ agentQuery: harness }).review(request());

    expect(response.usage).toEqual({ inputTokens: 1_000, outputTokens: 50 });
  });

  it("gives up after the second miss rather than asking forever", async () => {
    const harness = thenAnswers("not json", "still not json");

    await expect(
      new AgentSdkModelClient({ agentQuery: harness }).review(request()),
    ).rejects.toThrow(ModelError);
    expect(harness.prompts).toHaveLength(2);
  });

  it("shares one deadline across both attempts rather than granting the retry a fresh one", async () => {
    // FR-066 promises fifteen minutes. A controller created per ask would have given a retried
    // review two full budgets and silently doubled the number an operator schedules around.
    let asks = 0;
    const slow = Object.assign(
      (input: { options?: { abortController?: AbortController } }) => {
        asks += 1;

        return (async function* () {
          if (asks === 1) {
            // A malformed reply, arriving just before the bound expires.
            yield { type: "assistant", message: { content: [{ type: "text", text: "not json" }] } };
            yield {
              type: "result",
              subtype: "success",
              usage: { input_tokens: 10, output_tokens: 1 },
            };

            return;
          }
          await new Promise((resolve) => {
            input.options?.abortController?.signal.addEventListener("abort", resolve);
          });
          throw new Error("aborted");
        })();
      },
      { calls: [] },
    ) as unknown as AgentQuery;

    await expect(
      new AgentSdkModelClient({ agentQuery: slow, deadlineMs: 60 }).review(request()),
    ).rejects.toThrow(/did not answer within/);
    // Two asks, one bound: the retry ran into the remainder and the whole review still ended at it.
    expect(asks).toBe(2);
  });

  it("does not ask again once the bound has expired, since there is no remainder to ask into", async () => {
    let asks = 0;
    const expired = Object.assign(
      (input: { options?: { abortController?: AbortController } }) => {
        asks += 1;

        // eslint-disable-next-line require-yield
        return (async function* () {
          await new Promise((resolve) => {
            input.options?.abortController?.signal.addEventListener("abort", resolve);
          });
          throw new Error("aborted");
        })();
      },
      { calls: [] },
    ) as unknown as AgentQuery;

    await expect(
      new AgentSdkModelClient({ agentQuery: expired, deadlineMs: 25 }).review(request()),
    ).rejects.toThrow(/did not answer within/);
    expect(asks).toBe(1);
  });

  it("does not retry a refused tool: an empty reply after an interrupt is not a schema miss", async () => {
    // The predicate was broad enough to catch `carried no text content`, which is what an
    // interrupted harness produces — routing the most security-relevant event this transport has
    // straight back into a second ask.
    let asks = 0;
    const seeking = Object.assign(
      (input: {
        options?: {
          canUseTool?: (n: string, i: Record<string, unknown>, o: unknown) => Promise<unknown>;
        };
      }) => {
        asks += 1;

        return (async function* () {
          await input.options?.canUseTool?.("Bash", {}, {});
          yield { type: "result", subtype: "error_during_execution", usage: undefined };
        })();
      },
      { calls: [] },
    ) as unknown as AgentQuery;

    await expect(
      new AgentSdkModelClient({ agentQuery: seeking }).review(request()),
    ).rejects.toThrow(/attempted to use a tool/);
    expect(asks).toBe(1);
  });

  it("does not retry an unauthenticated host", async () => {
    let asks = 0;
    const unauth = Object.assign(
      () => {
        asks += 1;

        // eslint-disable-next-line require-yield, @typescript-eslint/require-await
        return (async function* () {
          throw new Error("401 Unauthorized");
        })();
      },
      { calls: [] },
    ) as unknown as AgentQuery;

    await expect(new AgentSdkModelClient({ agentQuery: unauth }).review(request())).rejects.toThrow(
      HARNESS_NOT_AUTHENTICATED,
    );
    expect(asks).toBe(1);
  });

  it("does not retry a subscription limit, which a second ask only makes worse", async () => {
    // The point of the predicate. An unauthenticated host, a limit, a deadline and a refused tool
    // are all states an identical second ask cannot improve.
    let asks = 0;
    const limited = Object.assign(
      () => {
        asks += 1;

        // eslint-disable-next-line require-yield, @typescript-eslint/require-await
        return (async function* () {
          throw new Error("You've hit your session limit");
        })();
      },
      { calls: [] },
    ) as unknown as AgentQuery;

    await expect(
      new AgentSdkModelClient({ agentQuery: limited }).review(request()),
    ).rejects.toThrow(HARNESS_LIMIT_REACHED);
    expect(asks).toBe(1);
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
