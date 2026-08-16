import type { RoleName } from "../config/settings.js";
import type { TargetRepository } from "../config/target.js";
import { isPullRequestLevel } from "../model/client.js";
import { renderMarker, type Finding } from "../review/findings.js";
import { redact } from "../observability/logger.js";

/**
 * Submitting a role's verdict as a pull request review (FR-006, research.md R-006).
 *
 * One review per role, not one comment per finding: batching is what keeps the platform API cost
 * proportional to rounds rather than to findings, which is decisive under the 500 content-creating
 * requests per hour ceiling (R-007). Findings are attached to this same submission in Phase 4.
 */

export interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly body: string;
}

/** The slice of the reviews API this feature uses, narrowed so callers can substitute it. */
export interface ReviewsApi {
  create(params: {
    owner: string;
    repo: string;
    pull_number: number;
    commit_id: string;
    body: string;
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    comments?: ReviewComment[];
  }): Promise<{ id: number }>;
}

export interface RoleReview {
  readonly role: RoleName;
  readonly decision: "approve" | "request-changes";
  /** The revision the verdict is bound to (FR-009). */
  readonly revision: string;
  readonly body: string;
  /** Line-anchored findings, batched into this one submission (FR-010). */
  readonly comments?: readonly ReviewComment[];
}

function toEvent(decision: "approve" | "request-changes"): "APPROVE" | "REQUEST_CHANGES" {
  // There is no mapping to `COMMENT`: a silent pass is not an approval, and every review this
  // service submits states one of the two explicit verdicts (FR-006, FR-007).
  return decision === "approve" ? "APPROVE" : "REQUEST_CHANGES";
}

/** How a finding reads as a comment: severity, blocking status, and its machine-readable marker. */
export function renderFinding(finding: Finding): string {
  const status = finding.blocking ? "blocking" : "non-blocking";

  // The description is model-authored text about code that may itself contain a credential — a
  // hardcoded-secret finding is the likeliest place for one to be quoted back. Redacting here
  // keeps FR-032 true on the comment surface: the finding still says what is wrong and where,
  // without republishing the secret to a pull request that may be public.
  const description = redact(finding.description) as string;

  return [
    `**${finding.severity}** · ${status} · \`${finding.rule}\``,
    "",
    description,
    "",
    renderMarker(finding),
  ].join("\n");
}

/**
 * Splits a role's findings into one batched review: anchored findings become line comments, and
 * findings whose location the diff cannot carry go into the review body rather than being dropped
 * (FR-010, FR-014, research.md R-006).
 */
export function buildRoleReview(input: {
  role: RoleName;
  decision: "approve" | "request-changes";
  revision: string;
  findings: readonly Finding[];
  summary: string;
}): RoleReview {
  const comments: ReviewComment[] = [];
  const unanchored: string[] = [];

  for (const finding of input.findings) {
    if (isPullRequestLevel(finding.location)) {
      unanchored.push(renderFinding(finding));
      continue;
    }

    comments.push({
      path: finding.location.path,
      line: finding.location.line,
      side: finding.location.side,
      body: renderFinding(finding),
    });
  }

  const body =
    unanchored.length === 0
      ? input.summary
      : [
          input.summary,
          "",
          "### Findings not addressable within the diff",
          "",
          unanchored.join("\n\n---\n\n"),
        ].join("\n");

  return {
    role: input.role,
    decision: input.decision,
    revision: input.revision,
    body,
    comments,
  };
}

export async function submitReview(
  api: ReviewsApi,
  target: TargetRepository,
  pullRequest: number,
  review: RoleReview,
): Promise<number> {
  const created = await api.create({
    owner: target.owner,
    repo: target.name,
    pull_number: pullRequest,
    commit_id: review.revision,
    body: review.body,
    event: toEvent(review.decision),
    ...(review.comments === undefined ? {} : { comments: [...review.comments] }),
  });

  return created.id;
}
