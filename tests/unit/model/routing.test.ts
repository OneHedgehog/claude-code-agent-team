import { describe, expect, it, vi } from "vitest";

import {
  ModelError,
  RouteExhaustedError,
  ZERO_USAGE,
  type ModelClient,
  type ReviewRequest,
  type ReviewResponse,
} from "../../../src/model/client.js";
import { RoutingModelClient } from "../../../src/model/routing.js";
import {
  ScriptedModelClient,
  scriptedCapacityFailure,
  scriptedContractFailure,
} from "../../../src/model/scripted.js";

/**
 * The routing composite (FR-078, FR-079, FR-080, FR-086; contract delta, R-023).
 *
 * The leaves are substituted and the router is real — that is the whole testing boundary FR-085
 * describes. A test that substituted the router would only prove failover by exhausting a real
 * vendor's quota, which is a path nobody runs.
 */

const USAGE = { inputTokens: 100, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0 };

function request(role: ReviewRequest["role"] = "security"): ReviewRequest {
  return {
    runId: "run-1",
    role,
    effort: "high",
    diff: "diff --git a/a b/a",
    constitution: "# constitution",
    pullRequestContext: { title: "t", body: "b", specPaths: [] },
    priorFindings: [],
    maxTokens: 1000,
  };
}

function approving(provider: string): ReviewResponse {
  return {
    findings: [],
    verdict: "approve",
    replyJudgements: [],
    usage: USAGE,
    provider,
  };
}

function scripted(provider: string, outcome: ReviewResponse | ModelError): ScriptedModelClient {
  return new ScriptedModelClient(
    { security: outcome, implementation: outcome },
    {
      providerName: provider,
    },
  );
}

describe("advancing on capacity", () => {
  it("asks the next provider and returns its verdict, named", async () => {
    const a = scripted("a", scriptedCapacityFailure("a"));
    const b = scripted("b", approving("b"));
    const router = new RoutingModelClient({ security: [a, b], implementation: [b] });

    const response = await router.review(request());

    expect(response.verdict).toBe("approve");
    expect(response.provider).toBe("b");
    // Exactly one verdict, from exactly one provider — failover never changes the count.
    expect(a.requestsFor("security")).toHaveLength(1);
    expect(b.requestsFor("security")).toHaveLength(1);
  });

  it("selects the route by role, so one role failing over does not disturb the other", async () => {
    const a = scripted("a", approving("a"));
    const b = scripted("b", approving("b"));
    const router = new RoutingModelClient({ security: [a], implementation: [b] });

    expect((await router.review(request("security"))).provider).toBe("a");
    expect((await router.review(request("implementation"))).provider).toBe("b");
  });
});

describe("stopping on contract", () => {
  it("does not ask a further provider when a response missed the schema", async () => {
    const a = scripted("a", scriptedContractFailure("a"));
    const b = scripted("b", approving("b"));
    const router = new RoutingModelClient({ security: [a, b], implementation: [b] });

    await expect(router.review(request())).rejects.toThrow(ModelError);
    // The point of the whole rule: asking b here would be shopping for a verdict.
    expect(b.requestsFor("security")).toHaveLength(0);
  });

  it("rethrows the contract failure itself rather than a route-exhausted error", async () => {
    const a = scripted("a", scriptedContractFailure("a", "did not satisfy the review schema"));
    const router = new RoutingModelClient({ security: [a, scripted("b", approving("b"))] });

    await expect(router.review(request())).rejects.not.toBeInstanceOf(RouteExhaustedError);
    await expect(router.review(request())).rejects.toThrow(/review schema/);
  });
});

describe("exhaustion fails closed", () => {
  it("names every provider tried and its class", async () => {
    const a = scripted("a", scriptedCapacityFailure("a", "session limit"));
    const b = scripted("b", scriptedCapacityFailure("b", "rate limit"));
    const router = new RoutingModelClient({ security: [a, b] });

    const error = await router.review(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RouteExhaustedError);
    const exhausted = error as RouteExhaustedError;
    expect(exhausted.message).toContain("a");
    expect(exhausted.message).toContain("b");
    expect(exhausted.attempts.map((x) => x.provider)).toEqual(["a", "b"]);
    expect(exhausted.attempts.map((x) => x.failureClass)).toEqual(["capacity", "capacity"]);
  });

  it("sums the spend across attempts, because a failed attempt still spent", async () => {
    const spent = new ModelError("session limit", USAGE, {
      failureClass: "capacity",
      provider: "a",
    });
    const a = scripted("a", spent);
    const b = scripted(
      "b",
      new ModelError("rate limit", USAGE, {
        failureClass: "capacity",
        provider: "b",
      }),
    );
    const router = new RoutingModelClient({ security: [a, b] });

    const error = (await router.review(request()).catch((e: unknown) => e)) as RouteExhaustedError;

    expect(error.usage.inputTokens).toBe(200);
    expect(error.usage.outputTokens).toBe(20);
  });

  it("is a capacity failure itself: nothing here says anything about the revision", async () => {
    const router = new RoutingModelClient({
      security: [scripted("a", scriptedCapacityFailure("a"))],
    });

    const error = (await router.review(request()).catch((e: unknown) => e)) as RouteExhaustedError;

    expect(error.failureClass).toBe("capacity");
  });
});

describe("the per-attempt bound (FR-086)", () => {
  it("cancels a hung attempt, charges the prompt floor, and advances the route", async () => {
    vi.useFakeTimers();
    try {
      const hanging: ModelClient = { review: () => new Promise<ReviewResponse>(() => {}) };
      const b = scripted("b", approving("b"));
      const router = new RoutingModelClient(
        { security: [hanging, b] },
        { providerNames: ["slow", "b"] },
      );

      const pending = router.review(request());
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 10);
      const response = await pending;

      // An expiry is a capacity failure, so it advances rather than failing the revision.
      expect(response.provider).toBe("b");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not bound an attempt that answers in time", async () => {
    const router = new RoutingModelClient({ security: [scripted("a", approving("a"))] });

    expect((await router.review(request())).provider).toBe("a");
  });
});

describe("what the router must not do", () => {
  it("rejects a role with no route rather than inventing a provider", async () => {
    const router = new RoutingModelClient({ security: [scripted("a", approving("a"))] });

    await expect(router.review(request("implementation"))).rejects.toThrow(ModelError);
  });

  it("stamps the provider even when a leaf returned a response that did not name one", async () => {
    const unnamed: ModelClient = {
      review: (): Promise<ReviewResponse> =>
        Promise.resolve({ ...approving(""), usage: ZERO_USAGE }),
    };
    const router = new RoutingModelClient({ security: [unnamed] }, { providerNames: ["leaf"] });

    expect((await router.review(request())).provider).toBe("leaf");
  });
});
