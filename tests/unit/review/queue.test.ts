import { describe, expect, it } from "vitest";

import { measureQueueWait } from "../../../src/review/queue.js";

/**
 * FR-041. Below the threshold the gate stays *unreported* rather than passing — a review still
 * waiting has concluded nothing, and reporting success would be the "absent gate that reads as no
 * objection" Principle IV prohibits.
 */

const CREATED = "2026-08-16T10:00:00.000Z";

function at(secondsLater: number): string {
  return new Date(Date.parse(CREATED) + secondsLater * 1000).toISOString();
}

describe("measureQueueWait (FR-041)", () => {
  it("measures the wait in seconds", () => {
    const result = measureQueueWait({
      runCreatedAt: CREATED,
      jobStartedAt: at(90),
      maxQueueWaitSeconds: 1800,
    });

    expect(result.waitedSeconds).toBe(90);
  });

  it("leaves the gate unreported below the threshold", () => {
    const result = measureQueueWait({
      runCreatedAt: CREATED,
      jobStartedAt: at(90),
      maxQueueWaitSeconds: 1800,
    });

    expect(result.exceeded).toBe(false);
    expect(result.escalate).toBe(false);
    expect(result.gate).toBe("unreported");
  });

  it("permits a wait exactly at the threshold", () => {
    const result = measureQueueWait({
      runCreatedAt: CREATED,
      jobStartedAt: at(1800),
      maxQueueWaitSeconds: 1800,
    });

    expect(result.exceeded).toBe(false);
  });

  it("fails and escalates past the threshold", () => {
    const result = measureQueueWait({
      runCreatedAt: CREATED,
      jobStartedAt: at(1801),
      maxQueueWaitSeconds: 1800,
    });

    expect(result.exceeded).toBe(true);
    expect(result.escalate).toBe(true);
    expect(result.gate).toBe("failure");
  });

  it("states both numbers in the reason", () => {
    const result = measureQueueWait({
      runCreatedAt: CREATED,
      jobStartedAt: at(3600),
      maxQueueWaitSeconds: 1800,
    });

    expect(result.reason).toContain("3600");
    expect(result.reason).toContain("1800");
  });

  it("never reports a negative wait when the runner's clock is behind", () => {
    const result = measureQueueWait({
      runCreatedAt: CREATED,
      jobStartedAt: at(-30),
      maxQueueWaitSeconds: 1800,
    });

    expect(result.waitedSeconds).toBe(0);
    expect(result.escalate).toBe(false);
  });

  it("never reports the gate as success on this path", () => {
    for (const seconds of [0, 60, 1800, 1801, 100_000]) {
      const result = measureQueueWait({
        runCreatedAt: CREATED,
        jobStartedAt: at(seconds),
        maxQueueWaitSeconds: 1800,
      });

      expect(["unreported", "failure"]).toContain(result.gate);
    }
  });
});
