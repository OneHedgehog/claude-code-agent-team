import { describe, expect, it } from "vitest";

import { SettingsError, validateSettings } from "../../../src/config/settings.js";

/**
 * The cross-field invariants data-model.md records under OperatingSettings. JSON Schema
 * cannot express them, so they are checked in code immediately after schema validation — with the
 * same stop-the-run consequence as a missing required key, which is what these tests pin.
 */
function validFile(
  overrides: Record<string, unknown> = {},
  hostOverrides?: Record<string, unknown>,
): Record<string, unknown> {
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
      pollIntervalSeconds: 60,
      maxConcurrentReviews: 1,
      ...overrides,
    },
    host: { maxConcurrentAgents: 2, ...(hostOverrides ?? {}) },
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

/**
 * The host-wide cap and the reviewer's share of it (research.md R-019, FR-041, Principle VIII).
 *
 * `maxConcurrentReviews` was the whole cap before R-019 and is now a ceiling on one agent's share
 * of it. A value above the host's cap is not a stricter reading of a looser setting — it is a
 * setting that cannot mean what it says, because a review holds a host lease as well as a worker
 * before it starts. Left unchecked it would read as "the reviewer may exceed the host cap", which
 * is exactly the exemption FR-041's last sentence forbids.
 */
describe("maxConcurrentReviews <= host.maxConcurrentAgents (R-019)", () => {
  it("accepts a reviewer share below the host's cap", () => {
    expect(() =>
      validateSettings(validFile({ maxConcurrentReviews: 1 }, { maxConcurrentAgents: 4 })),
    ).not.toThrow();
  });

  it("accepts a reviewer share equal to the host's cap — the reviewer may use all of it", () => {
    expect(() =>
      validateSettings(validFile({ maxConcurrentReviews: 4 }, { maxConcurrentAgents: 4 })),
    ).not.toThrow();
  });

  it("stops the run on a reviewer share above the host's cap", () => {
    expect(() =>
      validateSettings(validFile({ maxConcurrentReviews: 5 }, { maxConcurrentAgents: 4 })),
    ).toThrow(SettingsError);
  });

  it("names both numbers, so an operator can see which one to change", () => {
    let problems: readonly string[] = [];
    try {
      validateSettings(validFile({ maxConcurrentReviews: 5 }, { maxConcurrentAgents: 4 }));
    } catch (error) {
      problems = error instanceof SettingsError ? error.problems : [];
    }

    expect(problems.join(" ")).toContain("maxConcurrentReviews (5)");
    expect(problems.join(" ")).toContain("host.maxConcurrentAgents (4)");
  });
});

/**
 * The shared section is validated as strictly as this service's own. FR-050 exempts a *sibling
 * agent's* section from validation, not a section every agent shares: a typo in the host's cap is
 * the same silent failure a typo in a budget would be.
 */
describe("the shared host section (FR-050 as R-019 corrects its reading)", () => {
  it("stops the run when the host section is absent", () => {
    const file = validFile();
    delete file["host"];

    expect(() => validateSettings(file)).toThrow(SettingsError);
  });

  it("stops the run on an unrecognized key inside it", () => {
    expect(() => validateSettings(validFile({}, { maxConcurrentAgnets: 2 }))).toThrow(
      SettingsError,
    );
  });

  it("stops the run on a cap below one, which no agent could ever run under", () => {
    expect(() =>
      validateSettings(validFile({ maxConcurrentReviews: 1 }, { maxConcurrentAgents: 0 })),
    ).toThrow(SettingsError);
  });

  it("still ignores a sibling agent's own section, which is what FR-050 actually says", () => {
    const file = validFile();
    file["someOtherAgent"] = { itsOwnSetting: "whatever it likes" };

    expect(() => validateSettings(file)).not.toThrow();
  });

  it("reports the host's cap as loaded, so the lease and the settings cannot disagree", () => {
    const loaded = validateSettings(validFile({}, { maxConcurrentAgents: 3 }));

    expect(loaded.host.maxConcurrentAgents).toBe(3);
  });
});
