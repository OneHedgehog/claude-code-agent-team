import { describe, expect, it } from "vitest";

import { assess, readSignals } from "../../../src/github/rate-limit.js";

const NOW = new Date("2026-08-15T12:00:00.000Z");

/** Seconds since the epoch, the unit GitHub uses for `x-ratelimit-reset`. */
function epoch(offsetSeconds: number): string {
  return String(Math.floor(NOW.getTime() / 1000) + offsetSeconds);
}

const LIMITS = { platformApiReserve: 50, maxRateLimitWaitSeconds: 3900 } as const;

describe("reading rate-limit signals from response headers (R-007)", () => {
  it("observes the ceilings rather than assuming them", () => {
    const signals = readSignals({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4123",
      "x-ratelimit-reset": epoch(600),
    });

    expect(signals).toEqual({
      limit: 5000,
      remaining: 4123,
      resetAt: new Date(NOW.getTime() + 600_000),
      retryAfterSeconds: undefined,
    });
  });

  it("reads retry-after when GitHub sends it", () => {
    const signals = readSignals({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": epoch(600),
      "retry-after": "120",
    });

    expect(signals?.retryAfterSeconds).toBe(120);
  });

  it("returns nothing when the headers are absent, rather than inventing a limit", () => {
    expect(readSignals({})).toBeNull();
  });

  it("returns nothing when a header is unparseable, rather than defaulting to zero remaining", () => {
    expect(
      readSignals({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "not-a-number",
        "x-ratelimit-reset": epoch(600),
      }),
    ).toBeNull();
  });
});

describe("the reserve (FR-040)", () => {
  it("proceeds while remaining is above the reserve", () => {
    const signals = { limit: 5000, remaining: 51, resetAt: new Date(NOW.getTime() + 600_000) };

    expect(assess(signals, LIMITS, NOW)).toEqual({ action: "proceed" });
  });

  it("stops and waits once remaining reaches the reserve", () => {
    const signals = { limit: 5000, remaining: 50, resetAt: new Date(NOW.getTime() + 600_000) };

    expect(assess(signals, LIMITS, NOW)).toEqual({ action: "wait", seconds: 600 });
  });

  it("stops and waits below the reserve too", () => {
    const signals = { limit: 5000, remaining: 0, resetAt: new Date(NOW.getTime() + 600_000) };

    expect(assess(signals, LIMITS, NOW).action).toBe("wait");
  });
});

describe("honoring retry-after (R-007)", () => {
  it("waits exactly the stated interval, never sooner", () => {
    const signals = {
      limit: 5000,
      remaining: 0,
      resetAt: new Date(NOW.getTime() + 600_000),
      retryAfterSeconds: 900,
    };

    expect(assess(signals, LIMITS, NOW)).toEqual({ action: "wait", seconds: 900 });
  });

  it("prefers retry-after over the reset even when the reset is sooner", () => {
    const signals = {
      limit: 5000,
      remaining: 0,
      resetAt: new Date(NOW.getTime() + 60_000),
      retryAfterSeconds: 300,
    };

    expect(assess(signals, LIMITS, NOW)).toEqual({ action: "wait", seconds: 300 });
  });
});

describe("waiting for the reset (FR-040)", () => {
  it("never returns a negative wait for a reset already past", () => {
    const signals = { limit: 5000, remaining: 0, resetAt: new Date(NOW.getTime() - 60_000) };
    const result = assess(signals, LIMITS, NOW);

    expect(result.action).toBe("wait");
    expect(result.action === "wait" && result.seconds).toBe(0);
  });

  it("escalates rather than waiting past maxRateLimitWaitSeconds", () => {
    const signals = { limit: 5000, remaining: 0, resetAt: new Date(NOW.getTime() + 3_901_000) };
    const result = assess(signals, LIMITS, NOW);

    expect(result.action).toBe("escalate");
    expect(result.action === "escalate" && result.reason).toMatch(/rate limit/i);
  });

  it("waits at exactly the maximum rather than escalating on the boundary", () => {
    const signals = { limit: 5000, remaining: 0, resetAt: new Date(NOW.getTime() + 3_900_000) };

    expect(assess(signals, LIMITS, NOW)).toEqual({ action: "wait", seconds: 3900 });
  });

  it("escalates on a retry-after that exceeds the maximum", () => {
    const signals = {
      limit: 5000,
      remaining: 0,
      resetAt: new Date(NOW.getTime() + 60_000),
      retryAfterSeconds: 4000,
    };

    expect(assess(signals, LIMITS, NOW).action).toBe("escalate");
  });
});
