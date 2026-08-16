import type { RoleOutcome } from "../gate.js";

/**
 * The pre-spend reviewability gate (FR-037).
 *
 * Distinct from `rules/size.ts`, and deliberately so. That one is Principle X's discipline cap: a
 * blocking *finding* a stated justification can clear. This one is a refusal to review at all —
 * past this size the service does not believe it can review the diff well, so it fails before
 * spending anything rather than producing a review nobody should trust.
 *
 * Both measure the same changed-line count, taken over the excluded set from `excluded-paths.ts`.
 * FR-053 exists so that the two caps cannot drift apart, which is why the count arrives here
 * already reduced rather than being recomputed.
 */

export interface ReviewableSizeInput {
  /** Changed lines with the excluded set already removed (FR-053). */
  readonly changedLines: number;
  readonly maxReviewableDiffSize: number;
}

export interface ReviewableSizeResult {
  readonly exceeds: boolean;
  /** Empty when the diff is refused: no role ran, so no role has a verdict. */
  readonly verdicts: readonly RoleOutcome[];
  /** Always zero — this check sits ahead of the model call, which is the whole point. */
  readonly tokensSpent: 0;
  readonly reason: string | null;
}

export function checkReviewableSize(input: ReviewableSizeInput): ReviewableSizeResult {
  const { changedLines, maxReviewableDiffSize } = input;

  if (changedLines <= maxReviewableDiffSize) {
    return { exceeds: false, verdicts: [], tokensSpent: 0, reason: null };
  }

  return {
    exceeds: true,
    verdicts: [],
    tokensSpent: 0,
    reason:
      `this pull request changes ${changedLines} lines, past the ${maxReviewableDiffSize}-line ` +
      `reviewable limit, so no review was attempted and no model tokens were spent; ` +
      `split it into independently shippable pull requests (FR-037)`,
  };
}
