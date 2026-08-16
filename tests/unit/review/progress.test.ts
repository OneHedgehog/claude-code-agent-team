import { describe, expect, it } from "vitest";

import { checkProgress } from "../../../src/review/progress.js";
import type { RoundRecord } from "../../../src/review/round-history.js";

/**
 * FR-046 (forward progress) and FR-020 (the round cap). A round that produced neither a code
 * change nor a reply to a blocking comment is a failed round — but only measured against the last
 * *concluded* round, and only by revision and reply, never by elapsed time.
 */

function baseline(overrides: Partial<RoundRecord> = {}): RoundRecord {
  return {
    roundNumber: 1,
    headSha: "abc123",
    concluded: true,
    openBlockingFingerprints: ["finding-a"],
    concludedAt: "2026-08-16T10:00:00.000Z",
    tokensConsumed: 100,
    budgetRemaining: 900,
    excludedPathCount: 0,
    ...overrides,
  };
}

describe("checkProgress — forward progress (FR-046)", () => {
  it("finds progress when the revision changed", () => {
    const result = checkProgress({
      baseline: baseline({ headSha: "abc123" }),
      headSha: "def456",
      repliesSinceBaseline: [],
      maxReviewRounds: 10,
    });

    expect(result.forwardProgress).toBe(true);
    expect(result.escalate).toBe(false);
  });

  it("finds progress when a blocking finding received a reply", () => {
    const result = checkProgress({
      baseline: baseline({ headSha: "abc123", openBlockingFingerprints: ["finding-a"] }),
      headSha: "abc123",
      repliesSinceBaseline: [{ findingId: "finding-a", at: "2026-08-16T10:30:00.000Z" }],
      maxReviewRounds: 10,
    });

    expect(result.forwardProgress).toBe(true);
  });

  it("finds no progress when neither the revision changed nor a reply arrived", () => {
    const result = checkProgress({
      baseline: baseline({ headSha: "abc123" }),
      headSha: "abc123",
      repliesSinceBaseline: [],
      maxReviewRounds: 10,
    });

    expect(result.forwardProgress).toBe(false);
    expect(result.escalate).toBe(true);
    expect(result.reason).toContain("no");
  });

  it("ignores a reply that predates the baseline's conclusion", () => {
    const result = checkProgress({
      baseline: baseline({ concludedAt: "2026-08-16T10:00:00.000Z" }),
      headSha: "abc123",
      repliesSinceBaseline: [{ findingId: "finding-a", at: "2026-08-16T09:00:00.000Z" }],
      maxReviewRounds: 10,
    });

    // The round that produced the baseline had already seen this reply, so it is not progress
    // since then.
    expect(result.forwardProgress).toBe(false);
  });

  it("ignores a reply to a finding the baseline did not list as open and blocking", () => {
    const result = checkProgress({
      baseline: baseline({ openBlockingFingerprints: ["finding-a"] }),
      headSha: "abc123",
      repliesSinceBaseline: [{ findingId: "finding-z", at: "2026-08-16T10:30:00.000Z" }],
      maxReviewRounds: 10,
    });

    expect(result.forwardProgress).toBe(false);
  });

  it("treats an absent baseline as the first round, which is never a failed round", () => {
    const result = checkProgress({
      baseline: null,
      headSha: "abc123",
      repliesSinceBaseline: [],
      maxReviewRounds: 10,
    });

    expect(result.forwardProgress).toBe(true);
    expect(result.roundNumber).toBe(1);
    expect(result.escalate).toBe(false);
  });

  it("does not consult elapsed time", () => {
    // Same revision, no replies, but the baseline concluded long ago. FR-046 compares by revision
    // and reply; a slow author is not a stalled one.
    const result = checkProgress({
      baseline: baseline({ concludedAt: "2020-01-01T00:00:00.000Z" }),
      headSha: "abc123",
      repliesSinceBaseline: [],
      maxReviewRounds: 10,
      now: new Date("2026-08-16T10:00:00.000Z"),
    });

    expect(result.forwardProgress).toBe(false);
    expect(result.reason).not.toContain("elapsed");
  });
});

describe("checkProgress — round cap (FR-020)", () => {
  it("permits a round at the cap", () => {
    const result = checkProgress({
      baseline: baseline({ roundNumber: 9 }),
      headSha: "def456",
      repliesSinceBaseline: [],
      maxReviewRounds: 10,
    });

    expect(result.roundNumber).toBe(10);
    expect(result.roundCapExceeded).toBe(false);
    expect(result.escalate).toBe(false);
  });

  it("escalates past the cap", () => {
    const result = checkProgress({
      baseline: baseline({ roundNumber: 10 }),
      headSha: "def456",
      repliesSinceBaseline: [],
      maxReviewRounds: 10,
    });

    expect(result.roundNumber).toBe(11);
    expect(result.roundCapExceeded).toBe(true);
    expect(result.escalate).toBe(true);
    expect(result.reason).toContain("10");
  });

  it("reports the cap before forward progress when both fire", () => {
    const result = checkProgress({
      baseline: baseline({ roundNumber: 10, headSha: "abc123" }),
      headSha: "abc123",
      repliesSinceBaseline: [],
      maxReviewRounds: 10,
    });

    expect(result.roundCapExceeded).toBe(true);
    expect(result.escalate).toBe(true);
  });
});
