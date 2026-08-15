import { describe, expect, it } from "vitest";

import {
  ROLE_PRECEDENCE,
  resolvePrecedence,
  type PrecedenceInput,
} from "../../../src/review/precedence.js";

/**
 * FR-048 and FR-049. The equal-precedence disagreement path is unreachable end to end in version
 * one — the only two roles have distinct precedence — so it is asserted here, where it can be
 * reached, rather than left untested until a third role makes it live.
 */

function input(overrides: Partial<PrecedenceInput> = {}): PrecedenceInput {
  return {
    precedence: ROLE_PRECEDENCE,
    conclusions: [
      { role: "security", decision: "approve", hasBlockingFinding: false },
      { role: "implementation", decision: "approve", hasBlockingFinding: false },
    ],
    ...overrides,
  };
}

describe("the precedence order (FR-048)", () => {
  it("puts security above implementation, lower being higher authority", () => {
    expect(ROLE_PRECEDENCE.security).toBeLessThan(ROLE_PRECEDENCE.implementation);
  });
});

describe("a higher-precedence blocking finding stands (FR-048)", () => {
  const contested = input({
    conclusions: [
      { role: "security", decision: "request-changes", hasBlockingFinding: true },
      { role: "implementation", decision: "approve", hasBlockingFinding: false },
    ],
  });

  it("leaves the security finding standing against the implementation approval", () => {
    expect(resolvePrecedence(contested).standingBlockingRoles).toEqual(["security"]);
  });

  it("records the contradiction rather than discarding it", () => {
    const outcome = resolvePrecedence(contested);

    expect(outcome.contradictions).toHaveLength(1);
    expect(outcome.contradictions[0]).toMatchObject({
      prevailing: "security",
      overruled: "implementation",
    });
  });

  it("raises no disagreement escalation, because precedence settled it (SC-023)", () => {
    expect(resolvePrecedence(contested).disagreement).toBeNull();
  });

  it("does not resolve the disagreement by attrition — the finding is not dropped", () => {
    expect(resolvePrecedence(contested).standingBlockingRoles).not.toHaveLength(0);
  });
});

describe("agreement records nothing (FR-048)", () => {
  it("records no contradiction when both roles approve", () => {
    const outcome = resolvePrecedence(input());

    expect(outcome.contradictions).toEqual([]);
    expect(outcome.disagreement).toBeNull();
    expect(outcome.standingBlockingRoles).toEqual([]);
  });

  it("records no contradiction when both roles request changes", () => {
    const outcome = resolvePrecedence(
      input({
        conclusions: [
          { role: "security", decision: "request-changes", hasBlockingFinding: true },
          { role: "implementation", decision: "request-changes", hasBlockingFinding: true },
        ],
      }),
    );

    expect(outcome.contradictions).toEqual([]);
    expect(outcome.disagreement).toBeNull();
    expect(outcome.standingBlockingRoles).toEqual(["security", "implementation"]);
  });
});

describe("a lower-precedence role blocking on its own is not a contradiction", () => {
  it("stands without overruling anyone", () => {
    const outcome = resolvePrecedence(
      input({
        conclusions: [
          { role: "security", decision: "approve", hasBlockingFinding: false },
          { role: "implementation", decision: "request-changes", hasBlockingFinding: true },
        ],
      }),
    );

    expect(outcome.standingBlockingRoles).toEqual(["implementation"]);
    expect(outcome.contradictions).toEqual([]);
    expect(outcome.disagreement).toBeNull();
  });
});

describe("equal precedence stops the review (FR-049)", () => {
  // Unreachable in version one; asserted here because a third role would make it live and this is
  // the path where "disagreement is escalated, never resolved by attrition" is enforced.
  const tied = input({
    precedence: { security: 0, implementation: 0 },
    conclusions: [
      { role: "security", decision: "request-changes", hasBlockingFinding: true },
      { role: "implementation", decision: "approve", hasBlockingFinding: false },
    ],
  });

  it("escalates rather than letting either side win", () => {
    const outcome = resolvePrecedence(tied);

    expect(outcome.disagreement).not.toBeNull();
    expect(outcome.disagreement?.roles.sort()).toEqual(["implementation", "security"]);
  });

  it("records no contradiction, because nothing prevailed", () => {
    expect(resolvePrecedence(tied).contradictions).toEqual([]);
  });

  it("states why it stopped, so the escalation can name it (FR-024)", () => {
    expect(resolvePrecedence(tied).disagreement?.reason).toMatch(/precedence/i);
  });
});
