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

/**
 * The routing declaration rules (006: FR-076, FR-084, FR-086, R-021, R-026).
 *
 * Every one is a *preflight* failure, before any model call. They live here rather than in the
 * schema for the same reason the budget invariants above do — JSON Schema cannot express a rule
 * that spans fields — and they ship in the same pull request as the shape they validate, because
 * a configuration surface and the rules that make it safe are one change, not two.
 */

const CONTAINMENT = {
  noTools: true,
  noInheritedSettings: true,
  noWorkingTreeAccess: true,
  allowlistedEnvironment: true,
  emptyWorkingDirectory: true,
  otherCredentialsNeutralised: true,
} as const;

function provider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    models: { high: "gemini-3.1-pro-high", low: "gemini-3.1-pro-low" },
    family: "gemini",
    transport: "cli",
    funding: "subscription",
    account: "a",
    credential: { source: "oauth-profile" },
    containment: { ...CONTAINMENT },
    ...overrides,
  };
}

/** A valid routed file: one account, providers and a route per required role. */
function routedFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return validFile({
    accounts: { a: { budget: 8_000_000, reserve: 2_000_000 } },
    providers: {
      p1: provider(),
      // A second family, pinned consistently. Declaring `gpt-oss` while keeping the gemini
      // identifiers is exactly the R-021 mismatch the rules below refuse.
      p2: provider({ family: "gpt-oss", models: { high: "gpt-oss-120b-medium" } }),
    },
    routes: { security: ["p1"], implementation: ["p1"] },
    ...overrides,
  });
}

describe("route declaration rules", () => {
  it("accepts a well-formed routed file", () => {
    expect(() => validateSettings(routedFile())).not.toThrow();
  });

  it("stops the run when a required role has no route", () => {
    expect(() => validateSettings(routedFile({ routes: { security: ["p1"] } }))).toThrow(
      SettingsError,
    );
  });

  it("stops the run when a route names an undeclared provider", () => {
    expect(() =>
      validateSettings(routedFile({ routes: { security: ["nope"], implementation: ["p1"] } })),
    ).toThrow(SettingsError);
  });

  it("stops the run when a provider appears twice in one route", () => {
    // The second entry buys nothing: a capacity failure will not have cleared between them.
    expect(() =>
      validateSettings(routedFile({ routes: { security: ["p1", "p1"], implementation: ["p1"] } })),
    ).toThrow(SettingsError);
  });

  it("stops the run when a provider draws on an undeclared account", () => {
    expect(() =>
      validateSettings(routedFile({ providers: { p1: provider({ account: "ghost" }) } })),
    ).toThrow(SettingsError);
  });

  it("stops the run when an account's reserve is not below its budget", () => {
    expect(() =>
      validateSettings(routedFile({ accounts: { a: { budget: 100, reserve: 100 } } })),
    ).toThrow(SettingsError);
  });

  it("stops the run when `modelTransport` is declared alongside `providers`", () => {
    // Two descriptions of how a model is reached is one more than can be true. The alias is
    // retained for the migration alone.
    expect(() => validateSettings(routedFile({ modelTransport: "agent-sdk" }))).toThrow(
      SettingsError,
    );
  });
});

describe("the FR-086 arithmetic invariant", () => {
  it("accepts a route whose attempts fit inside maxQueueWaitSeconds", () => {
    // 6 x 300s = 1800s, exactly the shipped default — the longest route R-026 permits.
    const six = Object.fromEntries(
      ["p1", "p2", "p3", "p4", "p5", "p6"].map((n) => [n, provider()]),
    );
    expect(() =>
      validateSettings(
        routedFile({
          providers: six,
          routes: { security: Object.keys(six), implementation: ["p1"] },
          maxQueueWaitSeconds: 1800,
        }),
      ),
    ).not.toThrow();
  });

  it("stops the run when a route could outlast the wait everything queued behind it agreed to", () => {
    const seven = Object.fromEntries(
      ["p1", "p2", "p3", "p4", "p5", "p6", "p7"].map((n) => [n, provider()]),
    );
    expect(() =>
      validateSettings(
        routedFile({
          providers: seven,
          routes: { security: Object.keys(seven), implementation: ["p1"] },
          maxQueueWaitSeconds: 1800,
        }),
      ),
    ).toThrow(SettingsError);
  });
});

describe("model pinning (R-021) and the effort map (FR-060)", () => {
  it("stops the run when a provider pins no model at all", () => {
    // A vendor default is a family the FR-082 check never saw.
    expect(() =>
      validateSettings(routedFile({ providers: { p1: provider({ models: {} }) } })),
    ).toThrow(SettingsError);
  });

  it("stops the run when the configured effort has no pinned model", () => {
    // `gemini-3.1-pro` is offered at high and low only; there is no -medium in the catalogue.
    expect(() =>
      validateSettings(
        routedFile({
          modelEffort: "medium",
          providers: { p1: provider() },
          routes: { security: ["p1"], implementation: ["p1"] },
        }),
      ),
    ).toThrow(SettingsError);
  });

  it("accepts the configured effort when the provider pins a model for it", () => {
    expect(() =>
      validateSettings(
        routedFile({
          modelEffort: "medium",
          providers: { p1: provider({ models: { medium: "gemini-3.8-flash-medium" } }) },
          routes: { security: ["p1"], implementation: ["p1"] },
        }),
      ),
    ).not.toThrow();
  });

  it("does not demand a pinned model of the migrated provider", () => {
    // SC-005: a pre-feature file pinned nothing and must keep working untouched. The rules run
    // over the declared section and never see the synthesised provider.
    const loaded = validateSettings(validFile({ modelTransport: "agent-sdk" }));

    expect(loaded.settings.migratedFromModelTransport).toBe(true);
    expect(loaded.settings.providers["agent-sdk"]?.models).toEqual({});
    expect(loaded.settings.routes.security).toEqual(["agent-sdk"]);
  });
});
