import { nextRoundNumber, type RoundRecord } from "./round-history.js";

/**
 * Forward progress (FR-046) and the round cap (FR-020).
 *
 * Principle VI requires the review loop to be bounded and to make progress: "a round that produces
 * neither a code change nor a reply to a blocking comment is a failed round". Both halves matter —
 * bounding alone lets two agents argue ten times before stopping, and progress alone lets them
 * argue forever as long as someone keeps typing.
 *
 * Progress is measured by revision and reply, never by elapsed time. A slow author is not a
 * stalled one, and a clock-based rule would escalate on someone who simply went to lunch.
 */

export interface ReplySinceBaseline {
  readonly findingId: string;
  /** When the reply was posted, compared against the baseline's conclusion time. */
  readonly at: string;
}

export interface ProgressInput {
  /** The most recent *concluded* round, or null for a first round. */
  readonly baseline: RoundRecord | null;
  readonly headSha: string;
  readonly repliesSinceBaseline: readonly ReplySinceBaseline[];
  readonly maxReviewRounds: number;
  /** Accepted so the absence of any time-based rule is visible rather than merely claimed. */
  readonly now?: Date;
}

export interface ProgressResult {
  readonly roundNumber: number;
  readonly forwardProgress: boolean;
  readonly roundCapExceeded: boolean;
  readonly escalate: boolean;
  readonly reason: string | null;
}

export function checkProgress(input: ProgressInput): ProgressResult {
  const { baseline, headSha, repliesSinceBaseline, maxReviewRounds } = input;

  const roundNumber = nextRoundNumber(baseline);

  // FR-020 is checked first: past the cap, whether the author made progress is moot.
  if (roundNumber > maxReviewRounds) {
    return {
      roundNumber,
      forwardProgress: true,
      roundCapExceeded: true,
      escalate: true,
      reason:
        `this pull request has reached round ${roundNumber}, past the configured maximum of ` +
        `${maxReviewRounds}; the review loop stops here and a human is needed (FR-020)`,
    };
  }

  // A first round is never a failed round: there is nothing yet to have made progress against.
  if (baseline === null) {
    return {
      roundNumber,
      forwardProgress: true,
      roundCapExceeded: false,
      escalate: false,
      reason: null,
    };
  }

  const revisionChanged = baseline.headSha !== headSha;

  const concludedAt = Date.parse(baseline.concludedAt);
  const blocking = new Set(baseline.openBlockingFingerprints);

  // A reply counts only when it answers a finding the baseline actually listed as open and
  // blocking, and only when it arrived after that round concluded — a reply the previous round
  // already saw is not progress since then.
  const replied = repliesSinceBaseline.some(
    (reply) => blocking.has(reply.findingId) && Date.parse(reply.at) > concludedAt,
  );

  const forwardProgress = revisionChanged || replied;

  if (forwardProgress) {
    return {
      roundNumber,
      forwardProgress: true,
      roundCapExceeded: false,
      escalate: false,
      reason: null,
    };
  }

  return {
    roundNumber,
    forwardProgress: false,
    roundCapExceeded: false,
    escalate: true,
    reason:
      `round ${roundNumber} found no forward progress since round ${baseline.roundNumber}: the ` +
      `revision is unchanged (${headSha}) and no blocking finding received a reply (FR-046)`,
  };
}
