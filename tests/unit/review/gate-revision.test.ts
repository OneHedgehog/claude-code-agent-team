import { describe, expect, it } from "vitest";

import { aggregate, type GateFinding, type RoleOutcome } from "../../../src/review/gate.js";
import type { RoleName } from "../../../src/config/settings.js";

/**
 * Revision binding (FR-009) and the staleness that follows from it (FR-018).
 *
 * Both requirements were covered only by `tests/e2e/staleness.e2e.ts`, which cannot run while the
 * fixture repository is missing, and by an implementation task. That left the single most
 * dangerous failure in the system — an approval outliving the code it approved — observable
 * nowhere. These assertions are deliberately in their own file rather than in `gate.test.ts`, so
 * that neither task's record is rewritten (tasks.md, T136).
 *
 * The distinction under test is narrow and easy to lose: a verdict for a superseded revision is
 * not a weaker approval, it is *no verdict at all* for the revision under review. The gate's
 * reasons are asserted to say so, because a stale approval reported as "approved an older
 * revision" and a stale approval silently reused are indistinguishable from the outside unless the
 * reason names the revisions.
 */

const OLD_HEAD = "1111111111111111111111111111111111111111";
const NEW_HEAD = "2222222222222222222222222222222222222222";

const BOTH: readonly RoleName[] = ["security", "implementation"];

function approving(role: RoleName, revision: string): RoleOutcome {
  return { role, decision: "approve", revision };
}

function gateFor(revision: string, outcomes: readonly RoleOutcome[], findings: GateFinding[] = []) {
  return aggregate({ requiredRoles: BOTH, outcomes, findings, revision, concluded: true });
}

describe("a verdict is bound to the exact revision its role examined (FR-009)", () => {
  it("carries that revision rather than the pull request", () => {
    const verdict = approving("security", OLD_HEAD);

    expect(verdict).toEqual({ role: "security", decision: "approve", revision: OLD_HEAD });
  });

  it("counts an approving verdict bound to the revision under review", () => {
    const result = gateFor(NEW_HEAD, [
      approving("security", NEW_HEAD),
      approving("implementation", NEW_HEAD),
    ]);

    expect(result.conclusion).toBe("success");
  });

  it("does not count an approving verdict bound to any other revision", () => {
    const result = gateFor(NEW_HEAD, [
      approving("security", OLD_HEAD),
      approving("implementation", NEW_HEAD),
    ]);

    expect(result.conclusion).toBe("failure");
    expect(result.reason).toContain("security");
    expect(result.reason).toContain(OLD_HEAD);
    expect(result.reason).toContain(NEW_HEAD);
  });

  it("names the mismatch rather than reporting the role as merely absent", () => {
    // The two failures need different reasons: "approved another revision" is a stale approval a
    // human can act on, while "recorded no verdict" is a role that never ran.
    const stale = gateFor(NEW_HEAD, [approving("security", OLD_HEAD)]);
    const absent = gateFor(NEW_HEAD, []);

    expect(stale.reason).not.toBe(absent.reason);
    expect(absent.reason).toContain("recorded no verdict");
  });

  it("refuses a verdict bound to no revision the run examined, whatever its decision", () => {
    const result = gateFor(NEW_HEAD, [
      { role: "security", decision: "request-changes", revision: OLD_HEAD },
      approving("implementation", NEW_HEAD),
    ]);

    expect(result.conclusion).toBe("failure");
  });
});

describe("an approval does not survive a push (FR-018)", () => {
  const approvedOldHead: readonly RoleOutcome[] = [
    approving("security", OLD_HEAD),
    approving("implementation", OLD_HEAD),
  ];

  it("passes for the revision every role actually examined", () => {
    expect(gateFor(OLD_HEAD, approvedOldHead).conclusion).toBe("success");
  });

  it("fails for the new head with the identical set of verdicts", () => {
    const result = gateFor(NEW_HEAD, approvedOldHead);

    expect(result.conclusion).toBe("failure");
    expect(result.reason).toContain(OLD_HEAD);
  });

  it("names every role whose approval was superseded, not just the first", () => {
    const result = gateFor(NEW_HEAD, approvedOldHead);

    expect(result.reason).toContain("security");
    expect(result.reason).toContain("implementation");
  });

  it("starts the new head from no verdicts rather than from the old ones", () => {
    // The gate derived for a pushed revision before any role has run is the same gate as one
    // derived with the previous revision's approvals in hand: neither counts. If the two ever
    // diverged, a stored verdict would be leaking across revisions.
    const fromNothing = gateFor(NEW_HEAD, []);
    const fromSuperseded = gateFor(NEW_HEAD, approvedOldHead);

    expect(fromNothing.conclusion).toBe("failure");
    expect(fromSuperseded.conclusion).toBe("failure");
  });

  it("cannot be rescued by the absence of findings on the new revision", () => {
    // A clean revision is not an approved one. Nothing standing plus nothing examined is a
    // failure, because FR-007's "silence is never approval" and FR-018's staleness rule meet here.
    const result = gateFor(NEW_HEAD, approvedOldHead, []);

    expect(result.conclusion).toBe("failure");
  });
});
