/**
 * Platform rate-limit accounting (FR-040, research.md R-007).
 *
 * Ceilings are observed from response headers rather than assumed, because the binding constraint
 * is the *secondary* limit — 80 content-creating requests per minute and 500 per hour — and a
 * budget written against the 5,000/hour primary limit would never fire while the secondary limit
 * silently throttled the reviewer. Reaching the reserve pauses and resumes; it never retries
 * immediately, and it never resolves exhaustion by spending (Principle IV).
 */

export interface RateLimitSignals {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date;
  /** Present on a throttled response. When present it is honored exactly. */
  readonly retryAfterSeconds?: number | undefined;
}

export interface RateLimitPolicy {
  readonly platformApiReserve: number;
  readonly maxRateLimitWaitSeconds: number;
}

export type RateLimitAssessment =
  | { readonly action: "proceed" }
  | { readonly action: "wait"; readonly seconds: number }
  | { readonly action: "escalate"; readonly reason: string };

type Headers = Readonly<Record<string, string | undefined>>;

function integer(value: string | undefined): number | null {
  if (value === undefined) return null;

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Reads the limit signals from a response. Returns `null` when they are absent or unparseable —
 * inventing a limit, or defaulting to zero remaining, would each be a guess in the one place the
 * service must not guess.
 */
export function readSignals(headers: Headers): RateLimitSignals | null {
  const limit = integer(headers["x-ratelimit-limit"]);
  const remaining = integer(headers["x-ratelimit-remaining"]);
  const reset = integer(headers["x-ratelimit-reset"]);

  if (limit === null || remaining === null || reset === null) return null;

  const retryAfter = integer(headers["retry-after"]);

  return {
    limit,
    remaining,
    resetAt: new Date(reset * 1000),
    retryAfterSeconds: retryAfter === null ? undefined : retryAfter,
  };
}

function bounded(seconds: number, policy: RateLimitPolicy, cause: string): RateLimitAssessment {
  if (seconds > policy.maxRateLimitWaitSeconds) {
    return {
      action: "escalate",
      reason: `rate limit: waiting ${seconds}s for ${cause} exceeds maxRateLimitWaitSeconds (${policy.maxRateLimitWaitSeconds}s)`,
    };
  }

  return { action: "wait", seconds };
}

export function assess(
  signals: RateLimitSignals,
  policy: RateLimitPolicy,
  now: Date,
): RateLimitAssessment {
  // GitHub's guidance is explicit: honor `retry-after` when present, never retry sooner, and
  // never treat a secondary limit as a transient error to retry through.
  if (signals.retryAfterSeconds !== undefined) {
    return bounded(signals.retryAfterSeconds, policy, "retry-after");
  }

  if (signals.remaining > policy.platformApiReserve) {
    return { action: "proceed" };
  }

  const seconds = Math.max(0, Math.ceil((signals.resetAt.getTime() - now.getTime()) / 1000));

  return bounded(seconds, policy, "the rate-limit reset");
}
