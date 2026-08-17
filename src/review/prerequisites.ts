import {
  missingPermissions,
  REQUIRED_INSTALLATION_PERMISSIONS,
  type PermissionLevel,
} from "../github/auth.js";
import { isGateRequired, type ProtectionOutcome } from "../github/branch-protection.js";
import { MISSING_CREDENTIAL_REASON, type ModelCredential } from "../model/anthropic.js";
import type { RoleOutcome } from "./gate.js";

/**
 * Startup prerequisite verification (FR-003, FR-025, FR-051).
 *
 * Both checks run before any model tokens are spent, and neither is ever *configured* by the
 * service — it verifies and reports. The reason FR-051 exists at all is that a merge gate branch
 * protection does not require is the quietest failure in the system: the service reviews, posts
 * findings, reports a failing gate, and the pull request merges anyway because nothing required
 * the check. Everything looks healthy. One read per run turns that into a loud failure.
 *
 * Permissions are reported before branch protection, because a `403` on the protection endpoint is
 * a *consequence* of a missing `administration: read` and naming the effect before the cause sends
 * an operator to the wrong place.
 */

export interface PrerequisiteInput {
  /** Permissions the installation token actually carries (FR-003). */
  readonly granted: Readonly<Record<string, PermissionLevel>>;
  readonly protection: ProtectionOutcome;
  /** The check-run name branch protection must list. */
  readonly gateName: string;
  readonly baseBranch: string;
  /**
   * The resolved model credential, or `null` when none of the local sources FR-032 permits has
   * one. Checked here rather than at the model call so an absent credential costs nothing and
   * fails with a stated reason, instead of surfacing as a 401 partway through a review.
   */
  readonly modelCredential: ModelCredential | null;
}

export interface PrerequisiteResult {
  readonly satisfied: boolean;
  readonly permissionsHeld: boolean;
  readonly modelCredentialPresent: boolean;
  readonly gateRequiredByBranchProtection: boolean;
  /** Named so a human can act on it (FR-024). */
  readonly missing: readonly string[];
  readonly reason: string | null;
  /** Empty on every path: no role runs before prerequisites pass. */
  readonly verdicts: readonly RoleOutcome[];
  /** Always zero — both checks sit ahead of the model call, which is the point of FR-051. */
  readonly tokensSpent: 0;
  readonly escalate: boolean;
}

function protectionReason(
  outcome: ProtectionOutcome,
  gateName: string,
  baseBranch: string,
): string {
  switch (outcome.kind) {
    case "protected":
      return (
        `branch protection on \`${baseBranch}\` does not require the \`${gateName}\` check, so a ` +
        `failing review would not stop a merge; add it to the branch's required status checks ` +
        `(FR-025)`
      );

    case "unprotected":
      return (
        `\`${baseBranch}\` is not protected, so nothing requires the \`${gateName}\` check and a ` +
        `failing review would not stop a merge; protect the branch and add the check (FR-025)`
      );

    case "plan-unsupported":
      // Never "missing permission": the grant may well be held. This is the distinction
      // contracts/github-surface.md records as verified against a real repository.
      return (
        `branch protection is unavailable on this repository's plan, so the \`${gateName}\` check ` +
        `cannot be made required: "${outcome.message}". This is not a permission fault — make the ` +
        `repository public, or upgrade the plan`
      );

    case "permission-missing":
      return (
        `branch protection on \`${baseBranch}\` could not be read, so it is unknown whether the ` +
        `\`${gateName}\` check is required: "${outcome.message}"`
      );
  }
}

export function checkPrerequisites(input: PrerequisiteInput): PrerequisiteResult {
  const { granted, protection, gateName, baseBranch, modelCredential } = input;

  const missing = missingPermissions(granted, REQUIRED_INSTALLATION_PERMISSIONS);
  const permissionsHeld = missing.length === 0;

  const modelCredentialPresent = modelCredential !== null;
  const gateRequired = isGateRequired(protection, gateName);

  if (permissionsHeld && modelCredentialPresent && gateRequired) {
    return {
      satisfied: true,
      permissionsHeld: true,
      modelCredentialPresent: true,
      gateRequiredByBranchProtection: true,
      missing: [],
      reason: null,
      verdicts: [],
      tokensSpent: 0,
      escalate: false,
    };
  }

  const reasons: string[] = [];

  // Permissions first: a protection-endpoint 403 is downstream of a missing `administration: read`.
  if (!permissionsHeld) {
    reasons.push(
      `the installation is missing ${missing.length === 1 ? "a permission" : "permissions"} its ` +
        `work requires: ${missing.join(", ")} (FR-003)`,
    );
  }

  if (!modelCredentialPresent) {
    reasons.push(MISSING_CREDENTIAL_REASON);
  }

  if (!gateRequired) {
    reasons.push(protectionReason(protection, gateName, baseBranch));
  }

  return {
    satisfied: false,
    permissionsHeld,
    modelCredentialPresent,
    gateRequiredByBranchProtection: gateRequired,
    missing,
    reason: reasons.join("; "),
    verdicts: [],
    tokensSpent: 0,
    escalate: true,
  };
}
