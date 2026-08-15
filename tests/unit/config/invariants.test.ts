import { describe, expect, it } from "vitest";

import { SettingsError, validateSettings } from "../../../src/config/settings.js";

/**
 * The three cross-field invariants data-model.md records under OperatingSettings. JSON Schema
 * cannot express them, so they are checked in code immediately after schema validation — with the
 * same stop-the-run consequence as a missing required key, which is what these tests pin.
 */
function validFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewService: {
      requiredReviewerRoles: ["security", "implementation"],
      blockingSeverityThreshold: "high",
      maxReviewRounds: 10,
      maxReviewableDiffSize: 2000,
      maxPullRequestSize: 400,
      excludedPathPatterns: [],
      tokenBudget: 20_000_000,
      reviewerTokenReserve: 5_000_000,
      platformApiBudget: 400,
      platformApiReserve: 50,
      maxRateLimitWaitSeconds: 3900,
      maxQueueWaitSeconds: 1800,
      escalationChannel: { type: "github-issue", assignee: "a-human" },
      ...overrides,
    },
  };
}

describe("reviewerTokenReserve < tokenBudget", () => {
  it("accepts a reserve strictly below the budget", () => {
    expect(() =>
      validateSettings(validFile({ tokenBudget: 100, reviewerTokenReserve: 99 })),
    ).not.toThrow();
  });

  it.each([
    ["equal to the budget", 100, 100],
    ["above the budget", 100, 101],
  ])("stops the run when the reserve is %s", (_label, tokenBudget, reviewerTokenReserve) => {
    expect(() => validateSettings(validFile({ tokenBudget, reviewerTokenReserve }))).toThrow(
      SettingsError,
    );
  });

  it("names both fields so the operator can see which pair is wrong", () => {
    let message = "";
    try {
      validateSettings(validFile({ tokenBudget: 100, reviewerTokenReserve: 100 }));
    } catch (error) {
      message = error instanceof SettingsError ? error.message : "";
    }

    expect(message).toContain("reviewerTokenReserve");
    expect(message).toContain("tokenBudget");
  });
});

describe("platformApiReserve < platformApiBudget", () => {
  it("accepts a reserve strictly below the budget", () => {
    expect(() =>
      validateSettings(validFile({ platformApiBudget: 400, platformApiReserve: 399 })),
    ).not.toThrow();
  });

  it.each([
    ["equal to the budget", 400, 400],
    ["above the budget", 400, 500],
  ])("stops the run when the reserve is %s", (_label, platformApiBudget, platformApiReserve) => {
    expect(() => validateSettings(validFile({ platformApiBudget, platformApiReserve }))).toThrow(
      SettingsError,
    );
  });
});

describe("maxReviewableDiffSize > maxPullRequestSize", () => {
  it("accepts a reviewability cap strictly above the discipline cap", () => {
    expect(() =>
      validateSettings(validFile({ maxReviewableDiffSize: 401, maxPullRequestSize: 400 })),
    ).not.toThrow();
  });

  it.each([
    ["equal", 400, 400],
    ["below", 300, 400],
  ])(
    "stops the run when the reviewability cap is %s — otherwise FR-043 could never fire",
    (_label, maxReviewableDiffSize, maxPullRequestSize) => {
      expect(() =>
        validateSettings(validFile({ maxReviewableDiffSize, maxPullRequestSize })),
      ).toThrow(SettingsError);
    },
  );
});

describe("invariant failures are indistinguishable in consequence from a missing required key", () => {
  it("throws the same error type", () => {
    const missingKey = validFile();
    delete (missingKey["reviewService"] as Record<string, unknown>)["tokenBudget"];

    const violatedInvariant = validFile({ tokenBudget: 10, reviewerTokenReserve: 10 });

    expect(() => validateSettings(missingKey)).toThrow(SettingsError);
    expect(() => validateSettings(violatedInvariant)).toThrow(SettingsError);
  });

  it("reports every violated invariant rather than only the first", () => {
    let problems: readonly string[] = [];
    try {
      validateSettings(
        validFile({
          tokenBudget: 10,
          reviewerTokenReserve: 10,
          platformApiBudget: 10,
          platformApiReserve: 10,
        }),
      );
    } catch (error) {
      problems = error instanceof SettingsError ? error.problems : [];
    }

    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});
