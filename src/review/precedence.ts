import type { RoleName } from "../config/settings.js";

/**
 * Role precedence and contradiction handling (FR-048, FR-049).
 *
 * The constitution requires disagreement to be escalated, never resolved by attrition. Precedence
 * is what lets that rule coexist with two roles that legitimately see a change differently: a
 * blocking finding from the higher-authority role stands, the disagreement is *recorded* rather
 * than discarded, and nothing is escalated because nothing is unresolved. Only a tie — two roles
 * of equal authority reaching contrary conclusions — has no principled winner, and that stops the
 * review.
 */

/** Lower is higher authority. Security outranks implementation (data-model.md, ReviewerRole). */
export const ROLE_PRECEDENCE: Readonly<Record<RoleName, number>> = {
  security: 0,
  implementation: 1,
};

export interface RoleConclusion {
  readonly role: RoleName;
  readonly decision: "approve" | "request-changes";
  readonly hasBlockingFinding: boolean;
}

export interface PrecedenceInput {
  readonly precedence: Readonly<Record<RoleName, number>>;
  readonly conclusions: readonly RoleConclusion[];
}

export interface Contradiction {
  readonly prevailing: RoleName;
  readonly overruled: RoleName;
  readonly reason: string;
}

export interface Disagreement {
  readonly roles: RoleName[];
  readonly reason: string;
}

export interface PrecedenceOutcome {
  /** Roles whose blocking findings stand after precedence is applied. */
  readonly standingBlockingRoles: RoleName[];
  /** Recorded, not escalated: precedence settled these (FR-048). */
  readonly contradictions: Contradiction[];
  /** Escalated, not settled: no role outranks the other (FR-049). */
  readonly disagreement: Disagreement | null;
}

export function resolvePrecedence(input: PrecedenceInput): PrecedenceOutcome {
  const { precedence, conclusions } = input;

  const blocking = conclusions.filter((c) => c.hasBlockingFinding);
  const approving = conclusions.filter((c) => c.decision === "approve" && !c.hasBlockingFinding);

  const contradictions: Contradiction[] = [];
  const tied: RoleName[] = [];

  for (const blocker of blocking) {
    for (const approver of approving) {
      const blockerRank = precedence[blocker.role];
      const approverRank = precedence[approver.role];

      if (blockerRank < approverRank) {
        contradictions.push({
          prevailing: blocker.role,
          overruled: approver.role,
          reason: `${blocker.role} recorded a blocking finding that ${approver.role} did not; ${blocker.role} holds higher precedence, so its finding stands`,
        });
      } else if (blockerRank === approverRank) {
        // No principled winner. Escalate rather than letting either side prevail.
        if (!tied.includes(blocker.role)) tied.push(blocker.role);
        if (!tied.includes(approver.role)) tied.push(approver.role);
      }
      // A lower-precedence blocker against a higher-precedence approver is not a contradiction:
      // the blocking finding simply stands on its own. Nothing overrules it, because approval
      // from a higher-authority role is not a statement that another role's finding is wrong.
    }
  }

  const disagreement: Disagreement | null =
    tied.length > 0
      ? {
          roles: tied,
          reason: `roles of equal precedence reached contrary conclusions: ${tied.join(", ")}`,
        }
      : null;

  return {
    standingBlockingRoles: blocking.map((c) => c.role),
    // A tie is escalated, not recorded as settled, so no contradiction is reported alongside it.
    contradictions: disagreement === null ? contradictions : [],
    disagreement,
  };
}
