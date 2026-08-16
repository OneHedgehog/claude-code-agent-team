import type { RoleOutcome } from "./gate.js";

/**
 * The self-authored refusal (FR-004).
 *
 * Principle VI's independence requirement collapses the moment the reviewing identity reviews its
 * own pull request, and it collapses *silently* — the review would look entirely normal. So the
 * check is a comparison of two names, and the interesting part is only that it be neither too
 * loose nor too tight: a substring match would refuse a real contributor whose login happens to
 * contain the App slug, while an exact match would miss the `[bot]` suffix GitHub adds to an App's
 * author login but not to its slug.
 */

/** GitHub appends this to an App's login when it appears as an author. */
const BOT_SUFFIX = "[bot]";

function canonical(login: string): string {
  const lowered = login.toLowerCase();

  return lowered.endsWith(BOT_SUFFIX) ? lowered.slice(0, -BOT_SUFFIX.length) : lowered;
}

/**
 * Whether the pull request's author is the reviewing identity. An absent author is *not* treated
 * as self-authored: that is a different failure, handled where the pull request is read, and
 * guessing here would refuse every pull request GitHub reported oddly.
 */
export function isSelfAuthored(authorLogin: string | null, reviewingIdentity: string): boolean {
  if (authorLogin === null) return false;

  return canonical(authorLogin) === canonical(reviewingIdentity);
}

export interface SelfReviewResult {
  readonly selfAuthored: boolean;
  /** Empty by construction when self-authored: there is nothing here to read as approval. */
  readonly verdicts: readonly RoleOutcome[];
  readonly escalate: boolean;
  /** Stated on the pull request and carried into the gate's reason (FR-024, FR-035). */
  readonly reason: string | null;
}

export function checkSelfReview(
  authorLogin: string | null,
  reviewingIdentity: string,
): SelfReviewResult {
  if (!isSelfAuthored(authorLogin, reviewingIdentity)) {
    return { selfAuthored: false, verdicts: [], escalate: false, reason: null };
  }

  return {
    selfAuthored: true,
    verdicts: [],
    escalate: true,
    reason:
      `this pull request is authored by the reviewing identity (${reviewingIdentity}), ` +
      `which must not review its own work (FR-004); a human review is required`,
  };
}
