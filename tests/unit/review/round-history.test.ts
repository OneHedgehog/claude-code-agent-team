import { describe, expect, it } from "vitest";

import {
  parseRoundRecord,
  renderRoundRecord,
  baselineRound,
  nextRoundNumber,
  type RoundRecord,
} from "../../../src/review/round-history.js";
import type { CheckRunSummary } from "../../../src/github/check-run.js";

/**
 * FR-020 and FR-046 both need the previous *concluded* round, which no single run holds. It lives
 * where Principle VII requires every state to live — on GitHub, in each round's check-run output.
 *
 * The rule that matters most here is that an unconcluded round is ignored entirely. Without it, a
 * retry after a crash, a budget stop, or a queue timeout looks exactly like an author who pushed
 * nothing, and the service escalates on a stalled author that does not exist.
 */

function record(overrides: Partial<RoundRecord> = {}): RoundRecord {
  return {
    roundNumber: 1,
    headSha: "abc123",
    concluded: true,
    openBlockingFingerprints: [],
    concludedAt: "2026-08-16T10:00:00.000Z",
    tokensConsumed: 100,
    budgetRemaining: 900,
    excludedPathCount: 0,
    ...overrides,
  };
}

function checkRun(
  round: RoundRecord | null,
  overrides: Partial<CheckRunSummary> = {},
): CheckRunSummary {
  return {
    id: 1,
    name: "independent-review",
    headSha: round?.headSha ?? "abc123",
    status: "completed",
    conclusion: "failure",
    completedAt: round?.concludedAt ?? null,
    output: { title: "Independent review", text: round === null ? null : renderRoundRecord(round) },
    ...overrides,
  };
}

describe("round record round-trip", () => {
  it("reads back exactly what it wrote", () => {
    const original = record({
      roundNumber: 3,
      openBlockingFingerprints: ["aaaa", "bbbb"],
      excludedPathCount: 2,
    });

    expect(parseRoundRecord(renderRoundRecord(original))).toEqual(original);
  });

  it("returns null for output carrying no record of ours", () => {
    expect(parseRoundRecord("Independent review failed. Two findings stand.")).toBeNull();
  });

  it("returns null for absent output", () => {
    expect(parseRoundRecord(null)).toBeNull();
  });

  it("returns null rather than throwing on a malformed record", () => {
    expect(parseRoundRecord("<!-- independent-review-round: {not json} -->")).toBeNull();
  });
});

describe("baselineRound (FR-046)", () => {
  it("takes the most recent concluded round", () => {
    const older = record({ roundNumber: 1, concludedAt: "2026-08-16T10:00:00.000Z" });
    const newer = record({ roundNumber: 2, concludedAt: "2026-08-16T11:00:00.000Z" });

    const baseline = baselineRound([checkRun(older), checkRun(newer)]);

    expect(baseline?.roundNumber).toBe(2);
  });

  it("ignores an unconcluded round entirely", () => {
    const concluded = record({ roundNumber: 1, concludedAt: "2026-08-16T10:00:00.000Z" });
    const crashed = record({
      roundNumber: 2,
      concluded: false,
      concludedAt: "2026-08-16T11:00:00.000Z",
    });

    const baseline = baselineRound([checkRun(concluded), checkRun(crashed)]);

    // The later round is newer but never concluded, so it is not a baseline. This is what keeps a
    // retry after a crash from being mistaken for a stalled author.
    expect(baseline?.roundNumber).toBe(1);
  });

  it("returns null when every round is unconcluded", () => {
    const crashed = record({ concluded: false });

    expect(baselineRound([checkRun(crashed)])).toBeNull();
  });

  it("returns null for an absent history", () => {
    expect(baselineRound([])).toBeNull();
  });

  it("ignores check runs carrying no record of ours", () => {
    expect(baselineRound([checkRun(null)])).toBeNull();
  });

  it("orders by conclusion time rather than by array order", () => {
    const newer = record({ roundNumber: 5, concludedAt: "2026-08-16T12:00:00.000Z" });
    const older = record({ roundNumber: 4, concludedAt: "2026-08-16T09:00:00.000Z" });

    const baseline = baselineRound([checkRun(newer), checkRun(older)]);

    expect(baseline?.roundNumber).toBe(5);
  });
});

describe("nextRoundNumber (FR-020)", () => {
  it("makes an absent history the first round", () => {
    expect(nextRoundNumber(null)).toBe(1);
  });

  it("counts up from the last concluded round", () => {
    expect(nextRoundNumber(record({ roundNumber: 3 }))).toBe(4);
  });

  it("never yields a round below one", () => {
    expect(nextRoundNumber(record({ roundNumber: 0 }))).toBeGreaterThanOrEqual(1);
  });
});
