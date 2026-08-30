import type { TargetRepository } from "../config/target.js";
import { parseMarker, type FindingMarker } from "../review/findings.js";
import type { OwnThread } from "../review/reconcile.js";

/**
 * Review threads, read and resolved through GraphQL (FR-015, FR-039, FR-044, research.md R-006).
 *
 * GraphQL is not a preference here. Review threads are not exposed in the REST API at all, so
 * `resolveReviewThread` is the only route to FR-039's reconciliation — which is also why the
 * installation carries `contents: write`, recorded as a known least-privilege tension in
 * contracts/github-surface.md.
 *
 * Everything in this module narrows to *the service's own* findings. A thread without our marker
 * is another party's and is never resolved, whatever it says (FR-015).
 */

export interface ReviewThreadComment {
  readonly body: string;
  /** When the comment was posted. FR-046 and R-018's clause (b) both compare against it. */
  readonly createdAt: string;
  readonly authorLogin: string | null;
}

export interface ReviewThread {
  /** GitHub's node id, `PRRT_`-prefixed. */
  readonly id: string;
  readonly isResolved: boolean;
  readonly path: string | null;
  readonly line: number | null;
  readonly comments: readonly ReviewThreadComment[];
}

/** The GraphQL surface this feature uses, narrowed so callers can substitute it. */
export interface ThreadsApi {
  listReviewThreads(params: {
    owner: string;
    repo: string;
    pullRequest: number;
  }): Promise<ReviewThread[]>;

  resolveReviewThread(params: { threadId: string }): Promise<void>;
}

export const REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            path
            line
            comments(first: 100) {
              nodes { body createdAt author { login } }
            }
          }
        }
      }
    }
  }
`;

export const RESOLVE_THREAD_MUTATION = `
  mutation ResolveThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

/**
 * A thread is ours when its *first* comment carries our marker. Later comments are replies, and a
 * reply cannot make someone else's thread ours — which is what stops an author quoting a finding
 * from turning their own thread into one the service will resolve.
 */
export function readOwnMarker(thread: ReviewThread): FindingMarker | null {
  const first = thread.comments[0];
  if (first === undefined) return null;

  return parseMarker(first.body);
}

/**
 * Narrows the pull request's threads to the service's own, carrying each one's replies so FR-044's
 * reply judgement and FR-046's forward-progress check can read them.
 */
export function ownThreads(threads: readonly ReviewThread[]): OwnThread[] {
  const own: OwnThread[] = [];

  for (const thread of threads) {
    const marker = readOwnMarker(thread);
    if (marker === null) continue;

    // The first comment is the finding itself; everything after it is a reply to it.
    const replies = thread.comments.slice(1);

    own.push({
      threadId: thread.id,
      findingId: marker.id,
      role: marker.role,
      blocking: marker.blocking,
      isResolved: thread.isResolved,
      replies: replies.map((comment) => comment.body),
      // The newest reply, not every timestamp: both callers ask the same question — is there a
      // reply *since* some moment — and the newest one answers it for the whole thread.
      latestReplyAt: latestReplyAt(replies),
    });
  }

  return own;
}

/**
 * The most recent reply's timestamp, or `null` when nobody has replied. Ordered by time rather
 * than by position: GitHub returns comments in order today, and a thread whose last comment is not
 * its newest would otherwise silently answer "no reply since" when there was one.
 */
function latestReplyAt(replies: readonly ReviewThreadComment[]): string | null {
  let latest: string | null = null;

  for (const reply of replies) {
    if (latest === null || Date.parse(reply.createdAt) > Date.parse(latest)) {
      latest = reply.createdAt;
    }
  }

  return latest;
}

/** Reads the service's own threads on a pull request. */
export async function readOwnThreads(
  api: ThreadsApi,
  target: TargetRepository,
  pullRequest: number,
): Promise<OwnThread[]> {
  const threads = await api.listReviewThreads({
    owner: target.owner,
    repo: target.name,
    pullRequest,
  });

  return ownThreads(threads);
}

/**
 * Resolves threads a reconciliation plan named. The plan is the only caller: this function does no
 * judging of its own, so there is exactly one place where "may this be resolved?" is decided.
 */
export async function resolveThreads(
  api: ThreadsApi,
  threadIds: readonly string[],
): Promise<number> {
  let resolved = 0;

  for (const threadId of threadIds) {
    await api.resolveReviewThread({ threadId });
    resolved += 1;
  }

  return resolved;
}
