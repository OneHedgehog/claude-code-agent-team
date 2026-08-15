import type { TargetRepository } from "../config/target.js";
import type { GateResult } from "../review/gate.js";

/**
 * The merge gate itself: a check run created and updated by the App installation (FR-021, FR-022,
 * FR-023, FR-024, research.md R-005).
 *
 * GitHub's own rule is what makes FR-022 structural rather than conventional — only GitHub Apps
 * can create or update check runs, so an authoring identity holding a personal access token
 * physically cannot report this gate, whatever scopes it carries.
 */

/**
 * The gate's name. Branch protection must list this exact string in the base branch's required
 * status checks, and `branch-protection.ts` verifies that it does (FR-025, FR-051). A human
 * configures it; the service never writes it.
 */
export const MERGE_GATE_CHECK_NAME = "independent-review";

export interface CheckRunOutput {
  readonly title: string;
  readonly summary: string;
  readonly text?: string;
}

export interface CheckRunSummary {
  readonly id: number;
  readonly name: string;
  readonly headSha: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: string | null;
  readonly completedAt: string | null;
  readonly output: { readonly title: string | null; readonly text: string | null };
}

/** The slice of the checks API this feature uses, narrowed so callers can substitute it. */
export interface CheckRunApi {
  create(params: {
    owner: string;
    repo: string;
    name: string;
    head_sha: string;
    status: "queued" | "in_progress" | "completed";
    started_at?: string;
    output?: CheckRunOutput;
  }): Promise<{ id: number }>;

  update(params: {
    owner: string;
    repo: string;
    check_run_id: number;
    status?: "queued" | "in_progress" | "completed";
    conclusion?: "success" | "failure";
    completed_at?: string;
    output?: CheckRunOutput;
  }): Promise<void>;

  listForRef(params: {
    owner: string;
    repo: string;
    ref: string;
    check_name?: string;
  }): Promise<CheckRunSummary[]>;
}

/**
 * The platform conclusions this service is willing to report (contracts/github-surface.md).
 * `neutral`, `skipped`, and `cancelled` are absent by construction: GitHub treats the first two as
 * non-failing, which is precisely the "absent gate that reads as no objection" Principle IV
 * prohibits.
 */
export type ReportableConclusion = "success" | "failure";

export class GateReportError extends Error {
  override readonly name = "GateReportError";
}

/**
 * Maps a derived gate result onto a platform conclusion. `unreported` has no mapping on purpose —
 * the caller leaves the check run `in_progress` rather than concluding it (FR-040, FR-041).
 */
export function toConclusion(result: GateResult): ReportableConclusion | null {
  if (result.conclusion === "unreported") return null;

  if (result.conclusion === "failure" && (result.reason ?? "") === "") {
    // FR-024: a failure without a reason is a bug, not a gate. Refusing here keeps the reason
    // requirement from being satisfied by an empty string somewhere upstream.
    throw new GateReportError("a failing gate must state a reason (FR-024)");
  }

  return result.conclusion;
}

export interface OpenGate {
  readonly checkRunId: number;
  readonly headSha: string;
}

/** Creates the gate in progress, before any review work begins. */
export async function openGate(
  api: CheckRunApi,
  target: TargetRepository,
  headSha: string,
  startedAt: string,
): Promise<OpenGate> {
  const created = await api.create({
    owner: target.owner,
    repo: target.name,
    name: MERGE_GATE_CHECK_NAME,
    head_sha: headSha,
    status: "in_progress",
    started_at: startedAt,
    output: {
      title: "Independent review in progress",
      summary: "The security and implementation reviewers are examining this revision.",
    },
  });

  return { checkRunId: created.id, headSha };
}

/** Concludes the gate. A `unreported` result leaves it in progress rather than concluding it. */
export async function reportGate(
  api: CheckRunApi,
  target: TargetRepository,
  gate: OpenGate,
  result: GateResult,
  completedAt: string,
  output?: CheckRunOutput,
): Promise<ReportableConclusion | null> {
  const conclusion = toConclusion(result);

  if (conclusion === null) {
    return null;
  }

  await api.update({
    owner: target.owner,
    repo: target.name,
    check_run_id: gate.checkRunId,
    status: "completed",
    conclusion,
    completed_at: completedAt,
    output: output ?? {
      title: conclusion === "success" ? "Independent review passed" : "Independent review failed",
      summary: result.reason ?? "Every required reviewer role approved this revision.",
    },
  });

  return conclusion;
}

/** Reads the check runs the reviewing identity created on a revision (FR-020, FR-046). */
export async function listGateRuns(
  api: CheckRunApi,
  target: TargetRepository,
  ref: string,
): Promise<CheckRunSummary[]> {
  return api.listForRef({
    owner: target.owner,
    repo: target.name,
    ref,
    check_name: MERGE_GATE_CHECK_NAME,
  });
}
