import type { TargetRepository } from "../config/target.js";

/**
 * Reading branch protection, and the is-the-gate-required assertion (FR-025, FR-051,
 * research.md R-016).
 *
 * The service **verifies and never configures**. Configuring would need `administration: write`,
 * and an identity that can write branch protection can remove its own gate — so the installation
 * holds the read and never the write, which is recorded as a deliberate least-privilege tension in
 * contracts/github-surface.md.
 *
 * The response classification below is the whole point of this module. Three statuses mean four
 * different things, and two of them share `403`:
 *
 *   200 → protected; read the required contexts
 *   404 → the branch is unprotected. This is *the failure case*, not an error to retry.
 *   403 "Resource not accessible by …"  → the grant really is missing
 *   403 "Upgrade to GitHub Pro …"       → the plan does not offer the feature; the grant may well
 *                                          be held
 *
 * Collapsing the last two was verified to be wrong against a real repository: an installation
 * holding `administration: read` — proven by `/keys` and `/actions/permissions` both returning
 * `200` — still received `403` on `/branches/{b}/protection` while the repository was private on
 * GitHub Free. Reporting that as a missing permission sends an operator hunting a grant they
 * already have.
 */

export type ProtectionOutcome =
  | { readonly kind: "protected"; readonly requiredContexts: readonly string[] }
  | { readonly kind: "unprotected" }
  | { readonly kind: "permission-missing"; readonly message: string }
  | { readonly kind: "plan-unsupported"; readonly message: string };

/** The narrow slice of the branches API this feature uses, so callers can substitute it. */
export interface BranchProtectionApi {
  getBranchProtection(params: {
    owner: string;
    repo: string;
    branch: string;
  }): Promise<{ status: number; body: unknown }>;
}

/** Distinguishes a plan limitation from a missing grant by the message GitHub returns. */
const UPGRADE_PATTERN = /upgrade to github (pro|team|enterprise)|make this repository public/i;

const NOT_ACCESSIBLE_PATTERN = /resource not accessible/i;

function messageOf(body: unknown): string {
  if (body !== null && typeof body === "object" && "message" in body) {
    const message = body.message;
    if (typeof message === "string") return message;
  }

  return "";
}

function contextsOf(body: unknown): readonly string[] {
  if (body === null || typeof body !== "object" || !("required_status_checks" in body)) {
    return [];
  }

  const checks = body.required_status_checks;
  if (checks === null || typeof checks !== "object" || !("contexts" in checks)) return [];

  const contexts = checks.contexts;
  if (!Array.isArray(contexts)) return [];

  return contexts.filter((context): context is string => typeof context === "string");
}

export function classifyProtectionResponse(status: number, body: unknown): ProtectionOutcome {
  if (status === 200) {
    return { kind: "protected", requiredContexts: contextsOf(body) };
  }

  // Not an error to retry: an unprotected branch is precisely the condition FR-025 exists to catch.
  if (status === 404) {
    return { kind: "unprotected" };
  }

  if (status === 403) {
    const message = messageOf(body);

    // Order matters. The upgrade message is checked first because it is the one that must never be
    // reported as a missing grant.
    if (UPGRADE_PATTERN.test(message)) return { kind: "plan-unsupported", message };
    if (NOT_ACCESSIBLE_PATTERN.test(message)) return { kind: "permission-missing", message };

    return { kind: "permission-missing", message };
  }

  // Any other status leaves the protection state unverified, which is never a pass.
  return {
    kind: "permission-missing",
    message: `unexpected status ${status} reading branch protection: ${messageOf(body)}`,
  };
}

export async function readBranchProtection(
  api: BranchProtectionApi,
  target: TargetRepository,
  branch: string,
): Promise<ProtectionOutcome> {
  const { status, body } = await api.getBranchProtection({
    owner: target.owner,
    repo: target.name,
    branch,
  });

  return classifyProtectionResponse(status, body);
}

/**
 * Whether the merge gate is a required check. Anything other than an explicitly protected branch
 * listing the gate is a `false` — an unverified protection state is not a pass, which is the same
 * posture the statechart's `gateNotRequiredByBranchProtection` guard takes.
 */
export function isGateRequired(outcome: ProtectionOutcome, gateName: string): boolean {
  return outcome.kind === "protected" && outcome.requiredContexts.includes(gateName);
}
