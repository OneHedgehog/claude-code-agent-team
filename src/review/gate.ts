import type { RoleName } from "../config/settings.js";

/**
 * Verdict aggregation and the merge gate's conclusion (FR-006, FR-007, FR-008, FR-021).
 *
 * Two rules do the work here. A role's decision is *derived* from its own findings rather than
 * asserted, so `approve` is unreachable while one of its blocking findings stands. And a missing
 * verdict is an explicit result rather than an absent one, so there is no code path where silence
 * can be read as approval — which is the failure FR-007 exists to prevent.
 */

export type FindingStatus = "open" | "resolved" | "waiver-requested";

/** The slice of a `Finding` the gate reads. `review/findings.ts` satisfies it structurally. */
export interface GateFinding {
  readonly id: string;
  readonly role: RoleName;
  readonly blocking: boolean;
  readonly status: FindingStatus;
}

export interface Verdict {
  readonly role: RoleName;
  readonly decision: "approve" | "request-changes";
  /** Bound to the revision examined (FR-009). */
  readonly revision: string;
}

export interface MissingVerdict {
  readonly role: RoleName;
  readonly missing: true;
  readonly reason: string;
}

export type RoleOutcome = Verdict | MissingVerdict;

export function isMissing(outcome: RoleOutcome): outcome is MissingVerdict {
  return "missing" in outcome;
}

export function missingVerdict(role: RoleName, reason: string): MissingVerdict {
  return { role, missing: true, reason };
}

/** A finding that still forces `request-changes` for its role. */
function stands(finding: GateFinding): boolean {
  // A `waiver-requested` finding no longer stands for this derivation — the service accepted the
  // author's justification — but the outstanding waiver still holds the gate (FR-045), which
  // `aggregate` enforces separately.
  return finding.blocking && finding.status === "open";
}

/**
 * A role's decision, derived from its own findings rather than asserted independently (FR-008).
 */
export function deriveDecision(
  role: RoleName,
  findings: readonly GateFinding[],
): "approve" | "request-changes" {
  const own = findings.filter((finding) => finding.role === role);

  return own.some(stands) ? "request-changes" : "approve";
}

export interface GateInput {
  readonly requiredRoles: readonly RoleName[];
  readonly outcomes: readonly RoleOutcome[];
  readonly findings: readonly GateFinding[];
  /** The head SHA under review; an approval bound to any other revision is stale (FR-009). */
  readonly revision: string;
  /** Only a concluded run reports at all (FR-040, FR-041). */
  readonly concluded: boolean;
}

export interface GateResult {
  /** Never `neutral`, `skipped`, or `cancelled` (FR-023). */
  readonly conclusion: "success" | "failure" | "unreported";
  /** Required whenever the conclusion is `failure` (FR-024). */
  readonly reason?: string;
}

/**
 * Passing requires all of: every required role approved the current revision, zero standing
 * blocking findings, zero outstanding waiver requests, and the run concluded (data-model.md,
 * MergeGate). Anything else fails with a stated reason.
 */
export function aggregate(input: GateInput): GateResult {
  const { requiredRoles, outcomes, findings, revision, concluded } = input;

  const reasons: string[] = [];

  for (const role of requiredRoles) {
    const outcome = outcomes.find((candidate) => candidate.role === role);

    if (outcome === undefined) {
      reasons.push(`${role} recorded no verdict for this revision`);
      continue;
    }
    if (isMissing(outcome)) {
      reasons.push(`${role} produced no verdict: ${outcome.reason}`);
      continue;
    }
    if (outcome.revision !== revision) {
      reasons.push(
        `${role} approved revision ${outcome.revision}, not the revision under review (${revision})`,
      );
      continue;
    }
    if (outcome.decision === "request-changes") {
      reasons.push(`${role} requested changes`);
    }
  }

  const standing = findings.filter(stands);
  if (standing.length > 0) {
    reasons.push(
      `${standing.length} blocking finding${standing.length === 1 ? "" : "s"} still stand${standing.length === 1 ? "s" : ""}`,
    );
  }

  const waivers = findings.filter((finding) => finding.status === "waiver-requested");
  if (waivers.length > 0) {
    reasons.push(
      `${waivers.length} waiver request${waivers.length === 1 ? "" : "s"} outstanding: a waiver requires a recorded, human-approved reason`,
    );
  }

  // A run still waiting for a host slot or a rate-limit reset has nothing to report yet. This is
  // the one non-failing outcome, and it leaves the pull request un-mergeable because branch
  // protection requires the check (FR-040, FR-041).
  if (!concluded) {
    return { conclusion: "unreported" };
  }

  if (reasons.length > 0) {
    return { conclusion: "failure", reason: reasons.join("; ") };
  }

  return { conclusion: "success" };
}
