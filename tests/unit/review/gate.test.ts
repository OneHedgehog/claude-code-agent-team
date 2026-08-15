import { describe, expect, it } from "vitest";

import {
  aggregate,
  deriveDecision,
  missingVerdict,
  type GateFinding,
  type RoleOutcome,
} from "../../../src/review/gate.js";
import type { RoleName } from "../../../src/config/settings.js";

const REVISION = "abc123";

function finding(overrides: Partial<GateFinding> = {}): GateFinding {
  return { id: "f1", role: "security", blocking: true, status: "open", ...overrides };
}

function approved(role: RoleName): RoleOutcome {
  return { role, decision: "approve", revision: REVISION };
}

function requestedChanges(role: RoleName): RoleOutcome {
  return { role, decision: "request-changes", revision: REVISION };
}

const BOTH: readonly RoleName[] = ["security", "implementation"];

function gate(input: {
  outcomes: readonly RoleOutcome[];
  findings?: readonly GateFinding[];
  concluded?: boolean;
}) {
  return aggregate({
    requiredRoles: BOTH,
    outcomes: input.outcomes,
    findings: input.findings ?? [],
    revision: REVISION,
    concluded: input.concluded ?? true,
  });
}

describe("deriving a role's decision from its own findings (FR-008)", () => {
  it("returns approve when nothing stands", () => {
    expect(deriveDecision("security", [])).toBe("approve");
  });

  it("forces request-changes while one blocking finding stands", () => {
    expect(deriveDecision("security", [finding()])).toBe("request-changes");
  });

  it("makes approve unreachable while one stands, whatever else is resolved", () => {
    const findings = [finding({ id: "a", status: "resolved" }), finding({ id: "b" })];

    expect(deriveDecision("security", findings)).toBe("request-changes");
  });

  it("ignores a resolved finding", () => {
    expect(deriveDecision("security", [finding({ status: "resolved" })])).toBe("approve");
  });

  it("ignores a non-blocking finding", () => {
    expect(deriveDecision("security", [finding({ blocking: false })])).toBe("approve");
  });

  it("ignores another role's finding when deriving this role's decision", () => {
    expect(deriveDecision("implementation", [finding({ role: "security" })])).toBe("approve");
  });

  it("no longer counts a finding whose justification was accepted (FR-045)", () => {
    // The finding stops forcing request-changes, but the outstanding waiver still holds the gate;
    // that is asserted against the gate itself below, not here.
    expect(deriveDecision("security", [finding({ status: "waiver-requested" })])).toBe("approve");
  });
});

describe("a missing verdict is explicit, never silence (FR-007)", () => {
  it("is representable as its own result rather than as undefined", () => {
    const missing = missingVerdict("security", "the model call failed");

    expect(missing.missing).toBe(true);
    expect(missing.role).toBe("security");
    expect(missing.reason).toBe("the model call failed");
  });

  it("fails the gate rather than being read as approval", () => {
    const result = gate({
      outcomes: [missingVerdict("security", "the model call failed"), approved("implementation")],
    });

    expect(result.conclusion).toBe("failure");
  });

  it("names the role whose verdict is missing (FR-024)", () => {
    const result = gate({
      outcomes: [missingVerdict("security", "the model call failed"), approved("implementation")],
    });

    expect(result.reason).toContain("security");
  });

  it("fails when a required role produced no result at all", () => {
    const result = gate({ outcomes: [approved("security")] });

    expect(result.conclusion).toBe("failure");
    expect(result.reason).toContain("implementation");
  });

  it("fails when no role ran, rather than passing vacuously", () => {
    expect(gate({ outcomes: [] }).conclusion).toBe("failure");
  });
});

describe("gate conclusion (FR-021)", () => {
  it("succeeds when every required role approved and nothing stands", () => {
    const result = gate({ outcomes: [approved("security"), approved("implementation")] });

    expect(result.conclusion).toBe("success");
  });

  it("fails when any role requested changes", () => {
    const result = gate({ outcomes: [approved("security"), requestedChanges("implementation")] });

    expect(result.conclusion).toBe("failure");
    expect(result.reason).toContain("implementation");
  });

  it("fails while a blocking finding stands, even with two approving verdicts", () => {
    const result = gate({
      outcomes: [approved("security"), approved("implementation")],
      findings: [finding()],
    });

    expect(result.conclusion).toBe("failure");
  });

  it("fails while a waiver is outstanding, which is the point of a waiver (FR-045)", () => {
    const result = gate({
      outcomes: [approved("security"), approved("implementation")],
      findings: [finding({ status: "waiver-requested" })],
    });

    expect(result.conclusion).toBe("failure");
    expect(result.reason).toMatch(/waiver/i);
  });

  it("leaves the gate unreported while the run has not concluded (FR-040, FR-041)", () => {
    const result = gate({
      outcomes: [approved("security"), approved("implementation")],
      concluded: false,
    });

    expect(result.conclusion).toBe("unreported");
  });

  it("binds approval to the revision examined (FR-009)", () => {
    const stale: RoleOutcome = { role: "security", decision: "approve", revision: "older-sha" };

    const result = aggregate({
      requiredRoles: BOTH,
      outcomes: [stale, approved("implementation")],
      findings: [],
      revision: REVISION,
      concluded: true,
    });

    expect(result.conclusion).toBe("failure");
    expect(result.reason).toMatch(/revision/i);
  });

  it("ignores a role that is not required, rather than letting it gate the merge", () => {
    const result = aggregate({
      requiredRoles: ["security"],
      outcomes: [approved("security"), requestedChanges("implementation")],
      findings: [],
      revision: REVISION,
      concluded: true,
    });

    expect(result.conclusion).toBe("success");
  });
});

describe("conclusions the service never uses (FR-023)", () => {
  const cases: Array<[string, ReturnType<typeof gate>]> = [
    ["two approvals", gate({ outcomes: [approved("security"), approved("implementation")] })],
    ["a refusal", gate({ outcomes: [requestedChanges("security"), approved("implementation")] })],
    ["a missing verdict", gate({ outcomes: [missingVerdict("security", "failed")] })],
    ["nothing at all", gate({ outcomes: [] })],
  ];

  it.each(cases)("never returns neutral, skipped, or cancelled for %s", (_label, result) => {
    expect(["success", "failure", "unreported"]).toContain(result.conclusion);
  });

  it("states a reason on every failure (FR-024)", () => {
    for (const [, result] of cases) {
      if (result.conclusion === "failure") {
        expect(result.reason).toBeTruthy();
      }
    }
  });

  it("states no reason on success, so a reason always means something went wrong", () => {
    const result = gate({ outcomes: [approved("security"), approved("implementation")] });

    expect(result.reason).toBeUndefined();
  });
});
