/**
 * Queue-wait measurement and its escalation threshold (FR-041, research.md R-017, R-019).
 *
 * Reviewer jobs take an ordinary slot in the host-wide concurrency cap and are never exempted from
 * it — Principle VIII counts "any CI or reviewer job executing on the same host", and an exempted
 * reviewer would be the one job able to thrash the machine it is protecting.
 *
 * **Amended for R-017.** This measured from a workflow run's `created_at` when the service ran as
 * a GitHub Actions workflow. There is no workflow run: the wait now runs from the tick that
 * enqueued the review to the review actually *starting*, which under R-019 means holding both a
 * worker from `maxConcurrentReviews` and a host lease from `host.maxConcurrentAgents`. FR-041's
 * wording survives verbatim — it says *the host's configured concurrency cap*, never the runner's.
 *
 * A boundary worth stating rather than discovering: the measurement is taken *by the review
 * itself*, so the escalation happens when it starts and finds it waited too long. A review that
 * never starts at all therefore never escalates on this path — it leaves the gate unreported, and
 * branch protection's required-check requirement is what keeps the pull request un-mergeable. That
 * is the correct failure (un-mergeable and quiet beats mergeable), but it is a different
 * mechanism, and SC-017 is scoped to waits that end.
 */

export interface QueueWaitInput {
  /** The tick that selected this review — the moment it entered the queue (R-017). */
  readonly queuedAt: string;
  /** When the review actually started: holding a worker *and* a host lease (R-019). */
  readonly startedAt: string;
  readonly maxQueueWaitSeconds: number;
}

export interface QueueWaitResult {
  readonly waitedSeconds: number;
  readonly exceeded: boolean;
  readonly escalate: boolean;
  /** `unreported` below the threshold: the run proceeds and the gate is simply not concluded yet. */
  readonly gate: "unreported" | "failure";
  readonly reason: string | null;
}

export function measureQueueWait(input: QueueWaitInput): QueueWaitResult {
  const { queuedAt, startedAt, maxQueueWaitSeconds } = input;

  const queued = Date.parse(queuedAt);
  const started = Date.parse(startedAt);

  // A clock that ran backwards is not a wait. Clamping keeps a skewed clock from escalating.
  const waitedSeconds = Math.max(0, Math.round((started - queued) / 1000));

  if (waitedSeconds <= maxQueueWaitSeconds) {
    return {
      waitedSeconds,
      exceeded: false,
      escalate: false,
      gate: "unreported",
      reason: null,
    };
  }

  return {
    waitedSeconds,
    exceeded: true,
    escalate: true,
    gate: "failure",
    reason:
      `this review waited ${waitedSeconds}s for a host concurrency slot, past the configured maximum of ` +
      `${maxQueueWaitSeconds}s; the host is saturated and the gate fails rather than reviewing ` +
      `late (FR-041)`,
  };
}
