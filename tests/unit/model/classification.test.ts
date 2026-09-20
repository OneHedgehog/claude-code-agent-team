import { describe, expect, it } from "vitest";

import {
  AnthropicModelClient,
  type MessagesApi,
  type ModelCredential,
} from "../../../src/model/anthropic.js";
import { ModelError, type ReviewRequest } from "../../../src/model/client.js";
import { scriptedCapacityFailure, scriptedContractFailure } from "../../../src/model/scripted.js";

/**
 * Where R-022 draws the line: **did a parseable response arrive at all?**
 *
 * If none did — the endpoint was unreachable, the credential had expired, a limit was hit, the
 * attempt outran its bound — nothing has been said about the reviewed revision, so the route may
 * advance (`capacity`). If one arrived and was unusable — it missed the schema, it refused a
 * tool, it carried no verdict — that is a statement about *this* run, and asking a different
 * provider would be shopping for a verdict (`contract`).
 *
 * Getting this backwards in either direction is a real fault: classifying a schema miss as
 * capacity turns the gate into something that keeps asking until one provider approves;
 * classifying a session limit as contract throws away the availability the route exists for.
 */

const CREDENTIAL: ModelCredential = { source: "environment", apiKey: "sk-test" };

function messages(response: unknown, error?: Error): MessagesApi {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async create(): Promise<unknown> {
      if (error !== undefined) throw error;
      return response;
    },
  };
}

function request(): ReviewRequest {
  return {
    runId: "run-1",
    role: "security",
    effort: "high",
    diff: "diff --git a/a b/a",
    constitution: "# constitution",
    pullRequestContext: { title: "t", body: "b", specPaths: [] },
    priorFindings: [],
    maxTokens: 1000,
  };
}

/** Runs a review expected to fail and hands back the classified error. */
async function failureOf(api: MessagesApi): Promise<ModelError> {
  const client = new AnthropicModelClient({
    credential: CREDENTIAL,
    messages: api,
    providerName: "api-under-test",
  });
  const error = await client.review(request()).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ModelError);
  return error as ModelError;
}

function textResponse(text: string): unknown {
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

describe("capacity — no response arrived", () => {
  it("classifies an unreachable endpoint as capacity", async () => {
    const error = await failureOf(messages(null, new Error("ECONNREFUSED")));

    expect(error.failureClass).toBe("capacity");
  });

  it("classifies an expired credential as capacity, so the route advances (scenario 42)", async () => {
    // A credential that expires between preflight and the call is indistinguishable, from here,
    // from any other reason the call did not land — and it says nothing about the diff.
    const error = await failureOf(messages(null, new Error("401 Unauthorized")));

    expect(error.failureClass).toBe("capacity");
  });

  it("classifies a rate limit as capacity", async () => {
    const error = await failureOf(messages(null, new Error("429 Too Many Requests")));

    expect(error.failureClass).toBe("capacity");
  });
});

describe("contract — a response arrived and was unusable", () => {
  it("classifies an empty answer as contract", async () => {
    const error = await failureOf(
      messages({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
    );

    expect(error.failureClass).toBe("contract");
  });

  it("classifies prose instead of JSON as contract", async () => {
    const error = await failureOf(messages(textResponse("I think this looks fine!")));

    expect(error.failureClass).toBe("contract");
  });

  it("classifies a schema miss as contract, so no second provider is asked", async () => {
    const error = await failureOf(messages(textResponse(JSON.stringify({ verdict: "maybe" }))));

    expect(error.failureClass).toBe("contract");
    expect(error.message).toMatch(/schema/i);
  });
});

describe("attribution and the safe default", () => {
  it("names the provider on every classified failure", async () => {
    const error = await failureOf(messages(null, new Error("ECONNREFUSED")));

    expect(error.provider).toBe("api-under-test");
  });

  it("defaults an unclassified failure to contract, which is the direction that fails closed", () => {
    // Defaulting to capacity would silently ask the next provider on a failure nobody
    // classified, which is exactly the verdict-shopping FR-078 exists to prevent.
    expect(new ModelError("something went wrong").failureClass).toBe("contract");
  });

  it("gives the scripted helpers the classes their names promise", () => {
    expect(scriptedCapacityFailure("a").failureClass).toBe("capacity");
    expect(scriptedContractFailure("a").failureClass).toBe("contract");
  });
});
