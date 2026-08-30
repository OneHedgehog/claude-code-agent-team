import { describe, expect, it } from "vitest";

import { MERGE_GATE_CHECK_NAME, type CheckRunSummary } from "../../src/github/check-run.js";
import {
  decideReview,
  publishIfCurrent,
  reconcileTick,
  type OpenPullRequest,
  type ThreadReplySummary,
} from "../../src/daemon.js";
import { renderRoundRecord, type RoundRecord } from "../../src/review/round-history.js";

/**
 * The reconciliation decision (FR-001, FR-019, FR-044, FR-046, research.md R-017 and R-018).
 *
 * This is the production trigger. Everything the service does downstream is reachable only through
 * the predicate asserted here, which is why R-018 exists at all: R-017's first pass keyed on head
 * SHA plus the existence of the gate check run, and a justification offered *instead of* a code
 * change leaves the head SHA exactly where it was. Under clause (a) alone such a pull request is
 * skipped on every tick forever — FR-044's judgement never runs, FR-045's waiver is never raised,
 * and FR-046's detector can never fire because a second round on that revision never starts.
 *
 * An integration test rather than a unit test because the decision reads real artifacts: the
 * check-run summaries GitHub returns and the round record `round-history.ts` embeds in their
 * output. Only the platform edges are stubbed.
 */

const TARGET = { owner: "OneHedgehog", repo: "claude-code-agent-team" } as const;

const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);

function round(overrides: Partial<RoundRecord> = {}): RoundRecord {
  return {
    roundNumber: 1,
    headSha: HEAD,
    concluded: true,
    openBlockingFingerprints: ["finding-1"],
    concludedAt: "2026-08-20T12:00:00.000Z",
    tokensConsumed: 1000,
    budgetRemaining: 19_000,
    excludedPathCount: 0,
    ...overrides,
  };
}

function gateRun(
  overrides: Partial<CheckRunSummary> = {},
  record: RoundRecord | null,
): CheckRunSummary {
  return {
    id: 1,
    name: MERGE_GATE_CHECK_NAME,
    headSha: HEAD,
    status: "completed",
    conclusion: "failure",
    completedAt: "2026-08-20T12:00:00.000Z",
    output: {
      title: "Independent review failed",
      text: record === null ? null : renderRoundRecord(record),
    },
    ...overrides,
  };
}

/** Records whether the thread read happened at all — FR-040 budgets it per pull request per tick. */
function threadReader(replies: readonly ThreadReplySummary[]): {
  read: () => Promise<readonly ThreadReplySummary[]>;
  calls: number[];
} {
  const calls: number[] = [];

  return {
    calls,
    read: (): Promise<readonly ThreadReplySummary[]> => {
      calls.push(1);
      return Promise.resolve(replies);
    },
  };
}

const pullRequest: OpenPullRequest = { number: 7, headSha: HEAD };

describe("clause (a): a revision the gate has never reported on (R-017)", () => {
  it("selects a head SHA carrying no independent-review check run", async () => {
    const reader = threadReader([]);

    const decision = await decideReview({ pullRequest, checkRuns: [], readThreads: reader.read });

    expect(decision.select).toBe(true);
    expect(decision.reason).toBe("no-gate-run-for-revision");
  });

  it("skips a head SHA that already carries one", async () => {
    const reader = threadReader([]);

    const decision = await decideReview({
      pullRequest,
      checkRuns: [gateRun({ conclusion: "success" }, round())],
      readThreads: reader.read,
    });

    expect(decision.select).toBe(false);
  });

  it("ignores another app's check run on the same revision", async () => {
    const reader = threadReader([]);

    const decision = await decideReview({
      pullRequest,
      checkRuns: [gateRun({ name: "ci", conclusion: "success" }, null)],
      readThreads: reader.read,
    });

    expect(decision.select).toBe(true);
    expect(decision.reason).toBe("no-gate-run-for-revision");
  });

  it("ignores a gate run belonging to a different revision", async () => {
    const reader = threadReader([]);

    const decision = await decideReview({
      pullRequest,
      checkRuns: [gateRun({ headSha: OLDER, conclusion: "success" }, round({ headSha: OLDER }))],
      readThreads: reader.read,
    });

    expect(decision.select).toBe(true);
  });

  it("does not read threads to reach clause (a) — there is no prior round to reply to", async () => {
    const reader = threadReader([]);

    await decideReview({ pullRequest, checkRuns: [], readThreads: reader.read });

    expect(reader.calls).toHaveLength(0);
  });
});

describe("clause (b): a reply offered instead of a code change (R-018, FR-044)", () => {
  it("selects when a reply is newer than the failing run's conclusion time", async () => {
    const reader = threadReader([
      { findingId: "finding-1", latestReplyAt: "2026-08-20T12:30:00.000Z" },
    ]);

    const decision = await decideReview({
      pullRequest,
      checkRuns: [gateRun({}, round())],
      readThreads: reader.read,
    });

    expect(decision.select).toBe(true);
    expect(decision.reason).toBe("reply-since-conclusion");
    expect(decision.threadsRead).toBe(true);
  });

  it("does not select when the newest reply predates the conclusion", async () => {
    const reader = threadReader([
      { findingId: "finding-1", latestReplyAt: "2026-08-20T11:00:00.000Z" },
    ]);

    const decision = await decideReview({
      pullRequest,
      checkRuns: [gateRun({}, round())],
      readThreads: reader.read,
    });

    expect(decision.select).toBe(false);
    expect(decision.reason).toBe("no-reply-since-conclusion");
  });

  it("does not select when the run concluded success, however new the reply", async () => {
    const reader = threadReader([
      { findingId: "finding-1", latestReplyAt: "2030-01-01T00:00:00.000Z" },
    ]);

    const decision = await decideReview({
      pullRequest,
      checkRuns: [gateRun({ conclusion: "success" }, round())],
      readThreads: reader.read,
    });

    expect(decision.select).toBe(false);
  });

  it("does not select when the run's output lists no open blocking finding", async () => {
    const reader = threadReader([
      { findingId: "finding-1", latestReplyAt: "2030-01-01T00:00:00.000Z" },
    ]);

    const decision = await decideReview({
      pullRequest,
      checkRuns: [gateRun({}, round({ openBlockingFingerprints: [] }))],
      readThreads: reader.read,
    });

    expect(decision.select).toBe(false);
    expect(decision.reason).toBe("no-open-blocking-findings");
  });

  it("counts only replies to findings the run itself listed as open and blocking", async () => {
    const reader = threadReader([
      { findingId: "some-other-finding", latestReplyAt: "2030-01-01T00:00:00.000Z" },
    ]);

    const decision = await decideReview({
      pullRequest,
      checkRuns: [gateRun({}, round())],
      readThreads: reader.read,
    });

    expect(decision.select).toBe(false);
  });

  it("treats a thread carrying no reply at all as no reply, not as a missing timestamp", async () => {
    const reader = threadReader([{ findingId: "finding-1", latestReplyAt: null }]);

    const decision = await decideReview({
      pullRequest,
      checkRuns: [gateRun({}, round())],
      readThreads: reader.read,
    });

    expect(decision.select).toBe(false);
  });
});

describe("the thread read is skipped for pull requests the cheap conditions exclude (FR-040)", () => {
  it("does not read threads when the gate passed", async () => {
    const reader = threadReader([]);

    await decideReview({
      pullRequest,
      checkRuns: [gateRun({ conclusion: "success" }, round())],
      readThreads: reader.read,
    });

    expect(reader.calls).toHaveLength(0);
  });

  it("does not read threads when the run listed no open blocking finding", async () => {
    const reader = threadReader([]);

    await decideReview({
      pullRequest,
      checkRuns: [gateRun({}, round({ openBlockingFingerprints: [] }))],
      readThreads: reader.read,
    });

    expect(reader.calls).toHaveLength(0);
  });

  it("does not read threads for a run that has not concluded", async () => {
    const reader = threadReader([]);

    await decideReview({
      pullRequest,
      checkRuns: [gateRun({ status: "in_progress", conclusion: null, completedAt: null }, round())],
      readThreads: reader.read,
    });

    expect(reader.calls).toHaveLength(0);
  });

  it("reads threads exactly once when the cheap conditions do hold", async () => {
    const reader = threadReader([
      { findingId: "finding-1", latestReplyAt: "2026-08-20T12:30:00.000Z" },
    ]);

    await decideReview({
      pullRequest,
      checkRuns: [gateRun({}, round())],
      readThreads: reader.read,
    });

    expect(reader.calls).toHaveLength(1);
  });

  it("does not read threads for a run whose output carries no round record", async () => {
    const reader = threadReader([]);

    await decideReview({ pullRequest, checkRuns: [gateRun({}, null)], readThreads: reader.read });

    expect(reader.calls).toHaveLength(0);
  });
});

describe("an unchanged listing costs nothing and selects nothing (R-017)", () => {
  it("selects nothing when the listing answers 304", async () => {
    const tick = await reconcileTick({
      target: TARGET,
      etag: 'W/"cached"',
      listOpen: () => Promise.resolve({ pullRequests: null, etag: 'W/"cached"' }),
      listGateRuns: () => Promise.reject(new Error("a 304 must not cost a check-run request")),
      readThreads: () => Promise.resolve([]),
    });

    expect(tick.unchanged).toBe(true);
    expect(tick.selected).toHaveLength(0);
  });

  it("carries the new ETag forward so the next tick can be conditional too", async () => {
    const tick = await reconcileTick({
      target: TARGET,
      etag: null,
      listOpen: () => Promise.resolve({ pullRequests: [pullRequest], etag: 'W/"fresh"' }),
      listGateRuns: () => Promise.resolve([]),
      readThreads: () => Promise.resolve([]),
    });

    expect(tick.etag).toBe('W/"fresh"');
    expect(tick.selected.map((selection) => selection.pullRequest)).toEqual([7]);
  });

  it("decides each open pull request independently rather than stopping at the first skip", async () => {
    const reviewed: OpenPullRequest = { number: 8, headSha: OLDER };

    const tick = await reconcileTick({
      target: TARGET,
      etag: null,
      listOpen: () => Promise.resolve({ pullRequests: [reviewed, pullRequest], etag: null }),
      listGateRuns: ({ ref }: { ref: string }) =>
        Promise.resolve(
          ref === OLDER
            ? [gateRun({ headSha: OLDER, conclusion: "success" }, round({ headSha: OLDER }))]
            : [],
        ),
      readThreads: () => Promise.resolve([]),
    });

    expect(tick.selected.map((selection) => selection.pullRequest)).toEqual([7]);
  });
});

describe("a run whose head SHA moved during the review discards its outcome (FR-019)", () => {
  it("publishes when the head is still the revision that was reviewed", async () => {
    const posted: string[] = [];

    const result = await publishIfCurrent({
      reviewed: HEAD,
      readHeadSha: () => Promise.resolve(HEAD),
      publish: () => {
        posted.push("published");
        return Promise.resolve();
      },
    });

    expect(result.published).toBe(true);
    expect(posted).toEqual(["published"]);
  });

  it("posts neither findings nor the gate when the head moved", async () => {
    const posted: string[] = [];

    const result = await publishIfCurrent({
      reviewed: HEAD,
      readHeadSha: () => Promise.resolve(OLDER),
      publish: () => {
        posted.push("published");
        return Promise.resolve();
      },
    });

    expect(result.published).toBe(false);
    expect(posted).toEqual([]);
  });

  it("states which revision it discarded and which superseded it (FR-024)", async () => {
    const result = await publishIfCurrent({
      reviewed: HEAD,
      readHeadSha: () => Promise.resolve(OLDER),
      publish: () => Promise.resolve(),
    });

    expect(result.reason).toContain(HEAD);
    expect(result.reason).toContain(OLDER);
  });

  it("discards rather than guessing when the head cannot be re-read", async () => {
    const posted: string[] = [];

    const result = await publishIfCurrent({
      reviewed: HEAD,
      readHeadSha: () => Promise.reject(new Error("network")),
      publish: () => {
        posted.push("published");
        return Promise.resolve();
      },
    });

    expect(result.published).toBe(false);
    expect(posted).toEqual([]);
  });
});
