import { describe, expect, it } from "vitest";

import { checkPrerequisites } from "../../../src/review/prerequisites.js";
import {
  classifyProtectionResponse,
  isGateRequired,
  type ProtectionOutcome,
} from "../../../src/github/branch-protection.js";
import { REQUIRED_INSTALLATION_PERMISSIONS } from "../../../src/github/auth.js";
import { MERGE_GATE_CHECK_NAME } from "../../../src/github/check-run.js";
import type { PermissionLevel } from "../../../src/github/auth.js";

/**
 * FR-003, FR-025, FR-051. Both verifications run before any model tokens are spent, because a gate
 * that branch protection does not require is the one failure mode that leaves the service looking
 * entirely healthy while doing nothing: it reviews, posts findings, reports a failing gate, and the
 * pull request merges anyway because nothing required the check.
 *
 * The `403` handling is the subtle part and is asserted hardest. Two different causes return the
 * same status, and reporting the wrong one sends an operator hunting a grant they already hold.
 */

const HELD: Record<string, PermissionLevel> = {
  ...(Object.fromEntries(
    Object.entries(REQUIRED_INSTALLATION_PERMISSIONS).map(([scope, level]) => [scope, level]),
  ) as Record<string, PermissionLevel>),
};

function protectedWith(contexts: readonly string[]): ProtectionOutcome {
  return { kind: "protected", requiredContexts: contexts };
}

function input(overrides: Partial<Parameters<typeof checkPrerequisites>[0]> = {}) {
  return {
    granted: HELD,
    protection: protectedWith([MERGE_GATE_CHECK_NAME]),
    gateName: MERGE_GATE_CHECK_NAME,
    baseBranch: "main",
    ...overrides,
  };
}

describe("classifyProtectionResponse — the two 403s must not be collapsed", () => {
  it("reads a protected branch's required contexts", () => {
    const outcome = classifyProtectionResponse(200, {
      required_status_checks: { contexts: ["independent-review", "ci"] },
    });

    expect(outcome).toEqual({
      kind: "protected",
      requiredContexts: ["independent-review", "ci"],
    });
  });

  it("treats a protected branch with no required checks as protected but empty", () => {
    const outcome = classifyProtectionResponse(200, {});

    expect(outcome).toEqual({ kind: "protected", requiredContexts: [] });
  });

  it("treats 404 as an unprotected branch rather than an error to retry", () => {
    const outcome = classifyProtectionResponse(404, { message: "Branch not protected" });

    expect(outcome.kind).toBe("unprotected");
  });

  it("reports a permission 403 as a missing grant", () => {
    const outcome = classifyProtectionResponse(403, {
      message: "Resource not accessible by personal access token",
    });

    expect(outcome.kind).toBe("permission-missing");
  });

  it("reports the integration wording as a missing grant too", () => {
    const outcome = classifyProtectionResponse(403, {
      message: "Resource not accessible by integration",
    });

    expect(outcome.kind).toBe("permission-missing");
  });

  it("reports an upgrade 403 as a plan limitation, never as a missing grant", () => {
    const outcome = classifyProtectionResponse(403, {
      message: "Upgrade to GitHub Pro or make this repository public to enable this feature.",
    });

    // Verified against a real repository: an installation holding `administration: read` still
    // receives this 403 on a private repository on GitHub Free. Naming it as a missing permission
    // sends the operator hunting a grant that is already held.
    expect(outcome.kind).toBe("plan-unsupported");
  });
});

describe("isGateRequired (FR-025)", () => {
  it("passes when the gate appears in the required contexts", () => {
    expect(isGateRequired(protectedWith([MERGE_GATE_CHECK_NAME]), MERGE_GATE_CHECK_NAME)).toBe(
      true,
    );
  });

  it("fails when the branch is protected but the gate is not required", () => {
    expect(isGateRequired(protectedWith(["ci"]), MERGE_GATE_CHECK_NAME)).toBe(false);
  });

  it("fails when the branch is not protected at all", () => {
    expect(isGateRequired({ kind: "unprotected" }, MERGE_GATE_CHECK_NAME)).toBe(false);
  });

  it("fails when the protection state could not be read", () => {
    // An unverified protection state is never a pass. This is the same posture the statechart's
    // `gateNotRequiredByBranchProtection` guard takes: only an explicit true clears it.
    expect(
      isGateRequired({ kind: "plan-unsupported", message: "upgrade" }, MERGE_GATE_CHECK_NAME),
    ).toBe(false);
  });
});

describe("checkPrerequisites — satisfied", () => {
  it("passes when every permission is held and the gate is required", () => {
    const result = checkPrerequisites(input());

    expect(result.satisfied).toBe(true);
    expect(result.permissionsHeld).toBe(true);
    expect(result.gateRequiredByBranchProtection).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.escalate).toBe(false);
  });
});

describe("checkPrerequisites — missing permissions (FR-003)", () => {
  it("fails naming the missing permission", () => {
    const granted = { ...HELD };
    delete granted["checks"];

    const result = checkPrerequisites(input({ granted }));

    expect(result.satisfied).toBe(false);
    expect(result.permissionsHeld).toBe(false);
    expect(result.missing.join(" ")).toContain("checks");
    expect(result.reason).toContain("checks");
  });

  it("fails when a permission is held at too low a level", () => {
    const result = checkPrerequisites(input({ granted: { ...HELD, checks: "read" } }));

    expect(result.satisfied).toBe(false);
    expect(result.missing.join(" ")).toContain("checks");
  });

  it("reports the missing permission before the branch protection", () => {
    const granted = { ...HELD };
    delete granted["administration"];

    const result = checkPrerequisites(
      input({ granted, protection: { kind: "permission-missing", message: "not accessible" } }),
    );

    // contracts/github-surface.md: a 403 "reports the missing administration: read first".
    expect(result.reason).toContain("administration");
    expect(result.reason?.indexOf("administration")).toBeLessThan(
      result.reason?.indexOf("branch protection") === -1
        ? Number.MAX_SAFE_INTEGER
        : (result.reason?.indexOf("branch protection") ?? 0),
    );
  });
});

describe("checkPrerequisites — the gate is not required (FR-025, FR-051)", () => {
  it("fails naming the branch protection when the gate is absent from required checks", () => {
    const result = checkPrerequisites(input({ protection: protectedWith(["ci"]) }));

    expect(result.satisfied).toBe(false);
    expect(result.gateRequiredByBranchProtection).toBe(false);
    expect(result.reason).toContain("branch protection");
    expect(result.reason).toContain(MERGE_GATE_CHECK_NAME);
    expect(result.reason).toContain("main");
  });

  it("treats an unprotected branch as the failure case, naming it as unprotected", () => {
    const result = checkPrerequisites(input({ protection: { kind: "unprotected" } }));

    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain("not protected");
  });

  it("reports a plan limitation as such rather than as a missing permission", () => {
    const result = checkPrerequisites(
      input({
        protection: {
          kind: "plan-unsupported",
          message: "Upgrade to GitHub Pro or make this repository public to enable this feature.",
        },
      }),
    );

    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain("plan");
    // The operator must not be told to grant something they already hold.
    expect(result.reason).not.toContain("missing permission");
  });
});

describe("checkPrerequisites — every failing path is free and silent (FR-051)", () => {
  const failing: ReadonlyArray<[string, Parameters<typeof checkPrerequisites>[0]]> = [
    ["missing permission", input({ granted: {} })],
    ["gate not required", input({ protection: protectedWith([]) })],
    ["branch unprotected", input({ protection: { kind: "unprotected" } })],
    [
      "permission 403",
      input({ protection: { kind: "permission-missing", message: "not accessible" } }),
    ],
    ["plan 403", input({ protection: { kind: "plan-unsupported", message: "upgrade" } })],
  ];

  for (const [name, args] of failing) {
    it(`${name}: spends zero tokens, records no verdict, states a reason, escalates`, () => {
      const result = checkPrerequisites(args);

      expect(result.satisfied).toBe(false);
      expect(result.tokensSpent).toBe(0);
      expect(result.verdicts).toHaveLength(0);
      expect(result.reason ?? "").not.toBe("");
      expect(result.escalate).toBe(true);
    });
  }

  it("spends zero tokens on the satisfied path too", () => {
    const result = checkPrerequisites(input());

    expect(result.tokensSpent).toBe(0);
    expect(result.verdicts).toHaveLength(0);
  });
});
