import type { TargetRepository } from "../config/target.js";

/**
 * Reading the pull request under review: its author, the exact revision, and the diff
 * (FR-001, FR-004, FR-009, FR-037, FR-043, FR-052).
 *
 * Every verdict and finding is bound to `headSha` rather than to "the pull request", which is what
 * makes an approval unable to survive a push (FR-018).
 */

export interface PullRequestSnapshot {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** The login the pull request is attributed to — compared against the reviewing identity (FR-004). */
  readonly authorLogin: string;
  /** `Bot` for an App-authored pull request, `User` otherwise. */
  readonly authorType: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly draft: boolean;
}

/** The slice of the pulls API this feature uses, narrowed so callers can substitute it. */
export interface PullRequestApi {
  get(params: { owner: string; repo: string; pull_number: number }): Promise<{
    number: number;
    title: string | null;
    body: string | null;
    user: { login: string; type: string } | null;
    head: { sha: string };
    base: { ref: string };
    draft?: boolean;
  }>;

  /** The same endpoint under the diff media type. */
  getDiff(params: { owner: string; repo: string; pull_number: number }): Promise<string>;
}

export class PullRequestError extends Error {
  override readonly name = "PullRequestError";
}

export async function readPullRequest(
  api: PullRequestApi,
  target: TargetRepository,
  pullRequest: number,
): Promise<PullRequestSnapshot> {
  const raw = await api.get({
    owner: target.owner,
    repo: target.name,
    pull_number: pullRequest,
  });

  if (raw.user === null) {
    // An unattributable pull request cannot be checked against the reviewing identity, and FR-004
    // is not satisfiable by assuming it was somebody else.
    throw new PullRequestError(
      `pull request ${pullRequest} has no author, so self-authorship cannot be checked (FR-004)`,
    );
  }

  return {
    number: raw.number,
    title: raw.title ?? "",
    body: raw.body ?? "",
    authorLogin: raw.user.login,
    authorType: raw.user.type,
    headSha: raw.head.sha,
    baseBranch: raw.base.ref,
    draft: raw.draft ?? false,
  };
}

export async function readDiff(
  api: PullRequestApi,
  target: TargetRepository,
  pullRequest: number,
): Promise<string> {
  return api.getDiff({ owner: target.owner, repo: target.name, pull_number: pullRequest });
}
