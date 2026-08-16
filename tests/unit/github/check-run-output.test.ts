import { describe, expect, it } from "vitest";

import { buildGateOutput, type GateOutputInput } from "../../../src/github/check-run.js";
import { parseRoundRecord } from "../../../src/review/round-history.js";

/**
 * The check-run output is not decoration. It is where Principle VII requires this run's state to
 * live so the *next* round can rebuild it from GitHub alone: the round history FR-046 compares
 * against, the spend FR-038 reconstructs the ledger from, the excluded-path count FR-053 reports,
 * and the effective optional settings FR-054 requires be visible.
 */

function input(overrides: Partial<GateOutputInput> = {}): GateOutputInput {
  return {
    result: { conclusion: "failure", reason: "security requested changes" },
    round: {
      roundNumber: 2,
      headSha: "abc123",
      concluded: true,
      openBlockingFingerprints: ["finding-a"],
      concludedAt: "2026-08-16T10:00:00.000Z",
      tokensConsumed: 1200,
      budgetRemaining: 8800,
      excludedPathCount: 3,
    },
    effectiveOptionalSettings: { modelEffort: "high", "escalationChannel.label": "escalation" },
    ...overrides,
  };
}

describe("buildGateOutput — spend and budget (FR-031)", () => {
  it("reports tokens consumed and budget remaining", () => {
    const output = buildGateOutput(input());

    expect(output.summary).toContain("1200");
    expect(output.summary).toContain("8800");
  });
});

describe("buildGateOutput — excluded paths (FR-053)", () => {
  it("reports the excluded-path count", () => {
    const output = buildGateOutput(input());

    expect(output.summary).toContain("3");
  });

  it("reports zero explicitly rather than omitting it", () => {
    const output = buildGateOutput(
      input({
        round: { ...input().round, excludedPathCount: 0 },
      }),
    );

    // An omitted count is indistinguishable from a count nobody measured.
    expect(output.summary).toMatch(/0 (path|excluded)/i);
  });
});

describe("buildGateOutput — effective optional settings (FR-054)", () => {
  it("reports the effective value of every optional setting", () => {
    const output = buildGateOutput(input());

    expect(output.summary).toContain("modelEffort");
    expect(output.summary).toContain("high");
  });

  it("reports a default that was filled in, not just one that was supplied", () => {
    const output = buildGateOutput(input({ effectiveOptionalSettings: { modelEffort: "max" } }));

    expect(output.summary).toContain("max");
  });
});

describe("buildGateOutput — round history the next round reads (FR-020, FR-046)", () => {
  it("embeds a record the next round can parse back", () => {
    const output = buildGateOutput(input());

    expect(parseRoundRecord(output.text ?? null)).toEqual(input().round);
  });

  it("carries the round number", () => {
    const output = buildGateOutput(input());

    expect(parseRoundRecord(output.text ?? null)?.roundNumber).toBe(2);
  });

  it("carries the head SHA the round examined", () => {
    const output = buildGateOutput(input());

    expect(parseRoundRecord(output.text ?? null)?.headSha).toBe("abc123");
  });

  it("carries whether the round concluded", () => {
    const unconcluded = buildGateOutput(input({ round: { ...input().round, concluded: false } }));

    expect(parseRoundRecord(unconcluded.text ?? null)?.concluded).toBe(false);
  });

  it("carries the open blocking fingerprints", () => {
    const output = buildGateOutput(input());

    expect(parseRoundRecord(output.text ?? null)?.openBlockingFingerprints).toEqual(["finding-a"]);
  });

  it("carries the time the round concluded", () => {
    const output = buildGateOutput(input());

    expect(parseRoundRecord(output.text ?? null)?.concludedAt).toBe("2026-08-16T10:00:00.000Z");
  });
});

describe("buildGateOutput — the title states the outcome", () => {
  it("names the failure", () => {
    const output = buildGateOutput(input());

    expect(output.title.toLowerCase()).toContain("fail");
    expect(output.summary).toContain("security requested changes");
  });

  it("names a pass", () => {
    const output = buildGateOutput(input({ result: { conclusion: "success" } }));

    expect(output.title.toLowerCase()).toContain("pass");
  });
});
