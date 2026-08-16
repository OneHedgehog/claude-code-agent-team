/**
 * Queue-wait measurement and its escalation threshold (FR-041, research.md R-013).
 *
 * Reviewer jobs take an ordinary slot in the host-wide concurrency cap and are never given a
 * dedicated runner — Principle VIII counts "any CI or reviewer job executing on the same host",
 * and an exempted reviewer would be the one job able to thrash the machine it is protecting.
 *
 * A boundary worth stating rather than discovering: the measurement is taken *by the job itself*,
 * so the escalation happens when the job starts and finds it waited too long. A review that never
 * starts at all therefore never escalates on this path — it leaves the gate unreported, and branch
 * protection's required-check requirement is what keeps the pull request un-mergeable. That is the
 * correct failure (un-mergeable and quiet beats mergeable), but it is a different mechanism, and
 * SC-017 is scoped to waits that end.
 */

export interface QueueWaitInput {
  /** When the workflow run was created — the moment the job entered the queue. */
  readonly runCreatedAt: string;
  /** When the job actually started on a runner. */
  readonly jobStartedAt: string;
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
  const { runCreatedAt, jobStartedAt, maxQueueWaitSeconds } = input;

  const created = Date.parse(runCreatedAt);
  const started = Date.parse(jobStartedAt);

  // A clock that ran backwards is not a wait. Clamping keeps a skewed runner from escalating.
  const waitedSeconds = Math.max(0, Math.round((started - created) / 1000));

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
      `this review waited ${waitedSeconds}s for a runner slot, past the configured maximum of ` +
      `${maxQueueWaitSeconds}s; the host is saturated and the gate fails rather than reviewing ` +
      `late (FR-041)`,
  };
}
