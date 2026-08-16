import type { CheckRunSummary } from "../github/check-run.js";

/**
 * Round history, read from the reviewing identity's own check runs (FR-020, FR-046).
 *
 * FR-020's round count and FR-046's forward-progress check both need the *previous concluded
 * round*, which no single run holds. Principle VII says where it lives: on GitHub, never in local
 * state. Each round writes its own record into its check-run output, and the next round reads it
 * back — so a crashed runner, a cleared disk, or a fresh clone all recover the same history.
 *
 * The rule that earns its keep here is that an unconcluded round is ignored *entirely*. Without
 * it, a retry after a crash, a budget stop, or a queue timeout is indistinguishable from an author
 * who pushed nothing, and the service escalates on a stalled author who does not exist.
 */

export interface RoundRecord {
  readonly roundNumber: number;
  readonly headSha: string;
  /** Only a concluded round may serve as a baseline (FR-046). */
  readonly concluded: boolean;
  /** Open blocking findings when the round concluded, for FR-046's reply comparison. */
  readonly openBlockingFingerprints: readonly string[];
  readonly concludedAt: string;
  readonly tokensConsumed: number;
  readonly budgetRemaining: number;
  readonly excludedPathCount: number;
}

const MARKER_PREFIX = "independent-review-round:";

const MARKER_PATTERN = new RegExp(`<!--\\s*${MARKER_PREFIX}\\s*(\\{[\\s\\S]*?\\})\\s*-->`);

/** Embeds a round's record in its check-run output text, where the next round reads it. */
export function renderRoundRecord(record: RoundRecord): string {
  return `<!-- ${MARKER_PREFIX} ${JSON.stringify(record)} -->`;
}

/** Reads a round record back. Returns `null` for anything that is not one of ours. */
export function parseRoundRecord(text: string | null): RoundRecord | null {
  if (text === null) return null;

  const match = MARKER_PATTERN.exec(text);
  if (match?.[1] === undefined) return null;

  try {
    return JSON.parse(match[1]) as RoundRecord;
  } catch {
    // A malformed record is treated as absent rather than fatal: the run proceeds as a first
    // round, which is never a failed round, instead of failing on unreadable history.
    return null;
  }
}

/**
 * The most recent concluded round across the reviewing identity's check runs, ordered by
 * conclusion time rather than by the order GitHub happened to return them.
 */
export function baselineRound(checkRuns: readonly CheckRunSummary[]): RoundRecord | null {
  const concluded = checkRuns
    .map((run) => parseRoundRecord(run.output.text))
    .filter((record): record is RoundRecord => record !== null && record.concluded);

  if (concluded.length === 0) return null;

  return concluded.reduce((latest, candidate) =>
    Date.parse(candidate.concludedAt) > Date.parse(latest.concludedAt) ? candidate : latest,
  );
}

/** The round this run is. An absent history makes it the first round (FR-020). */
export function nextRoundNumber(baseline: RoundRecord | null): number {
  if (baseline === null) return 1;

  return Math.max(1, baseline.roundNumber + 1);
}
