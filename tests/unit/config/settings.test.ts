import { describe, expect, it } from "vitest";

import {
  REQUIRED_SETTING_KEYS,
  SettingsError,
  validateSettings,
} from "../../../src/config/settings.js";

/** A complete, valid `reviewService` section, with no optional key supplied. */
function validSection(): Record<string, unknown> {
  return {
    requiredReviewerRoles: ["security", "implementation"],
    blockingSeverityThreshold: "high",
    maxReviewRounds: 10,
    maxReviewableDiffSize: 2000,
    maxPullRequestSize: 400,
    excludedPathPatterns: ["package-lock.json"],
    tokenBudget: 20_000_000,
    reviewerTokenReserve: 5_000_000,
    platformApiBudget: 400,
    platformApiReserve: 50,
    maxRateLimitWaitSeconds: 3900,
    maxQueueWaitSeconds: 1800,
    escalationChannel: { type: "github-issue", assignee: "a-human" },
    pollIntervalSeconds: 60,
    maxConcurrentReviews: 1,
  };
}

/** The shared, agent-agnostic section. Owned by nobody, validated by everybody (R-019). */
function validHost(): Record<string, unknown> {
  return { maxConcurrentAgents: 2 };
}

function validFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { reviewService: { ...validSection(), ...overrides }, host: validHost() };
}

describe("required settings (FR-028)", () => {
  it("accepts a complete section", () => {
    expect(() => validateSettings(validFile())).not.toThrow();
  });

  it("stops the run when the reviewService section is absent entirely", () => {
    expect(() => validateSettings({ someOtherAgent: {}, host: validHost() })).toThrow(
      SettingsError,
    );
  });

  it.each(REQUIRED_SETTING_KEYS)("stops the run when %s is missing", (key) => {
    const file = validFile();
    delete (file["reviewService"] as Record<string, unknown>)[key];

    expect(() => validateSettings(file)).toThrow(SettingsError);
  });

  it.each(REQUIRED_SETTING_KEYS)(
    "does not silently fill %s from the schema default — the default is documentation, not a fallback",
    (key) => {
      const file = validFile();
      delete (file["reviewService"] as Record<string, unknown>)[key];

      let message = "";
      try {
        validateSettings(file);
      } catch (error) {
        message = error instanceof SettingsError ? error.message : "";
      }

      expect(message).toContain(key);
    },
  );

  it.each([
    ["a budget below its minimum", { tokenBudget: 0 }],
    ["a severity outside the fixed scale", { blockingSeverityThreshold: "cosmetic" }],
    ["an unknown reviewer role", { requiredReviewerRoles: ["performance"] }],
    ["a non-integer round cap", { maxReviewRounds: 2.5 }],
    ["an escalation channel without an assignee", { escalationChannel: { type: "github-issue" } }],
    ["an unknown escalation transport", { escalationChannel: { type: "slack", assignee: "x" } }],
  ])("stops the run on an invalid value: %s", (_label, override) => {
    expect(() => validateSettings(validFile(override))).toThrow(SettingsError);
  });
});

describe("namespacing (FR-050)", () => {
  it("stops the run on an unrecognized key inside its own section", () => {
    expect(() => validateSettings(validFile({ maxReviewRound: 10 }))).toThrow(SettingsError);
  });

  it("names the unrecognized key, since a silent typo is indistinguishable from an unapplied setting", () => {
    let message = "";
    try {
      validateSettings(validFile({ tokenBudgett: 1 }));
    } catch (error) {
      message = error instanceof SettingsError ? error.message : "";
    }

    expect(message).toContain("tokenBudgett");
  });

  it("ignores a sibling agent's section rather than rejecting it", () => {
    const file = {
      ...validFile(),
      authoringAgent: { model: "claude-opus-5", maxTasks: 3 },
      someFutureAgent: { anything: { nested: true } },
    };

    expect(() => validateSettings(file)).not.toThrow();
  });

  it("does not leak a sibling section into its own settings", () => {
    const loaded = validateSettings({ ...validFile(), authoringAgent: { tokenBudget: 1 } });

    expect(loaded.settings.tokenBudget).toBe(20_000_000);
    expect(loaded.settings).not.toHaveProperty("authoringAgent");
  });
});

describe("optional settings (FR-054)", () => {
  it("fills an absent modelEffort from the documented default rather than stopping the run", () => {
    const loaded = validateSettings(validFile());

    expect(loaded.settings.modelEffort).toBe("high");
  });

  it("reports the effective value of every optional setting", () => {
    const loaded = validateSettings(validFile());

    expect(loaded.effectiveOptionalSettings).toEqual({
      modelEffort: "high",
      "escalationChannel.label": "escalation",
    });
  });

  it("reports a supplied optional value as effective, not the default", () => {
    const loaded = validateSettings(
      validFile({
        modelEffort: "max",
        escalationChannel: { type: "github-issue", assignee: "a-human", label: "urgent" },
      }),
    );

    expect(loaded.settings.modelEffort).toBe("max");
    expect(loaded.effectiveOptionalSettings).toEqual({
      modelEffort: "max",
      "escalationChannel.label": "urgent",
    });
  });

  it("fills the escalation label default while leaving the required assignee alone", () => {
    const loaded = validateSettings(validFile());

    expect(loaded.settings.escalationChannel.label).toBe("escalation");
    expect(loaded.settings.escalationChannel.assignee).toBe("a-human");
  });

  it("still rejects an invalid optional value rather than falling back to the default", () => {
    expect(() => validateSettings(validFile({ modelEffort: "exhaustive" }))).toThrow(SettingsError);
  });
});
