import { describe, expect, it } from "vitest";

import { reconcile, type OwnThread } from "../../../src/review/reconcile.js";
import { createFinding, type Finding } from "../../../src/review/findings.js";
import type { Severity } from "../../../src/config/settings.js";

const REVISION = "abc123";
const THRESHOLD: Severity = "high";

function finding(overrides: Partial<Parameters<typeof createFinding>[0]> = {}): Finding {
  return createFinding(
    {
      role: "security",
      rule: "hardcoded-credential",
      severity: "critical",
      location: { path: "src/a.ts", line: 12, side: "RIGHT" },
      description: "A credential is hardcoded here.",
      ...overrides,
    },
    THRESHOLD,
  );
}

function thread(source: Finding, overrides: Partial<OwnThread> = {}): OwnThread {
  return {
    threadId: `PRRT_${source.id}`,
    findingId: source.id,
    role: source.role,
    blocking: source.blocking,
    isResolved: false,
    replies: [],
    latestReplyAt: null,
    ...overrides,
  };
}

describe("reconcile (FR-015, FR-039)", () => {
  it("resolves a prior finding the current revision no longer exhibits", () => {
    const fixed = finding();

    const plan = reconcile({
      priorThreads: [thread(fixed)],
      currentFindings: [],
      revision: REVISION,
    });

    expect(plan.toResolve).toEqual([{ threadId: `PRRT_${fixed.id}`, findingId: fixed.id }]);
    expect(plan.standing).toHaveLength(0);
    expect(plan.toPost).toHaveLength(0);
  });

  it("leaves a finding that still stands open, and does not repost it", () => {
    const standing = finding();

    const plan = reconcile({
      priorThreads: [thread(standing)],
      currentFindings: [standing],
      revision: REVISION,
    });

    expect(plan.toResolve).toHaveLength(0);
    expect(plan.standing.map((entry) => entry.findingId)).toEqual([standing.id]);
    // The whole point of FR-039: the comment history stays readable because a standing finding is
    // not posted a second time.
    expect(plan.toPost).toHaveLength(0);
  });

  it("posts a finding the prior round did not raise", () => {
    const carried = finding();
    const fresh = finding({ rule: "missing-test", description: "No test covers this branch." });

    const plan = reconcile({
      priorThreads: [thread(carried)],
      currentFindings: [carried, fresh],
      revision: REVISION,
    });

    expect(plan.toPost.map((entry) => entry.id)).toEqual([fresh.id]);
    expect(plan.toResolve).toHaveLength(0);
  });

  it("resolves, keeps, and adds in the same round", () => {
    const fixed = finding({ rule: "fixed-rule", description: "Fixed since the last round." });
    const stands = finding({ rule: "standing-rule", description: "Still present." });
    const fresh = finding({ rule: "new-rule", description: "Newly introduced." });

    const plan = reconcile({
      priorThreads: [thread(fixed), thread(stands)],
      currentFindings: [stands, fresh],
      revision: REVISION,
    });

    expect(plan.toResolve.map((entry) => entry.findingId)).toEqual([fixed.id]);
    expect(plan.standing.map((entry) => entry.findingId)).toEqual([stands.id]);
    expect(plan.toPost.map((entry) => entry.id)).toEqual([fresh.id]);
  });

  it("never resolves a finding that still stands (FR-015)", () => {
    const stands = finding();

    const plan = reconcile({
      priorThreads: [thread(stands)],
      currentFindings: [stands],
      revision: REVISION,
    });

    expect(plan.toResolve).toHaveLength(0);
  });

  it("never resolves a finding merely for being old (FR-015)", () => {
    const stands = finding();

    // Ten rounds later, with the finding still exhibited, age changes nothing.
    const plan = reconcile({
      priorThreads: [thread(stands, { roundsOpen: 10 })],
      currentFindings: [stands],
      revision: REVISION,
    });

    expect(plan.toResolve).toHaveLength(0);
    expect(plan.standing).toHaveLength(1);
  });

  it("never resolves an already-resolved thread a second time", () => {
    const fixed = finding();

    const plan = reconcile({
      priorThreads: [thread(fixed, { isResolved: true })],
      currentFindings: [],
      revision: REVISION,
    });

    expect(plan.toResolve).toHaveLength(0);
  });

  it("never resolves a waiver-requested finding, because the code still exhibits it", () => {
    const waived = finding();
    const held: Finding = { ...waived, status: "waiver-requested" };

    const plan = reconcile({
      priorThreads: [thread(waived)],
      currentFindings: [held],
      revision: REVISION,
    });

    expect(plan.toResolve).toHaveLength(0);
    expect(plan.standing.map((entry) => entry.findingId)).toEqual([waived.id]);
  });

  it("does not repost a waiver-requested finding", () => {
    const waived = finding();
    const held: Finding = { ...waived, status: "waiver-requested" };

    const plan = reconcile({
      priorThreads: [thread(waived)],
      currentFindings: [held],
      revision: REVISION,
    });

    expect(plan.toPost).toHaveLength(0);
  });
});

describe("reconcile ownership (FR-015)", () => {
  it("only ever resolves threads supplied as the service's own", () => {
    // `ownThreads` in github/threads.ts is what filters foreign threads out; reconcile is given
    // only our own, and every thread it resolves must have come from that input.
    const fixed = finding();
    const ours = thread(fixed);

    const plan = reconcile({
      priorThreads: [ours],
      currentFindings: [],
      revision: REVISION,
    });

    const suppliedIds = new Set([ours.threadId]);
    for (const entry of plan.toResolve) {
      expect(suppliedIds.has(entry.threadId)).toBe(true);
    }
  });

  it("resolves nothing when there are no prior threads of ours", () => {
    const fresh = finding();

    const plan = reconcile({
      priorThreads: [],
      currentFindings: [fresh],
      revision: REVISION,
    });

    expect(plan.toResolve).toHaveLength(0);
    expect(plan.toPost.map((entry) => entry.id)).toEqual([fresh.id]);
  });
});
