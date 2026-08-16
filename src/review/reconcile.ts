import type { RoleName } from "../config/settings.js";
import type { Finding } from "./findings.js";

/**
 * Reconciling this round's findings against the service's own prior ones (FR-015, FR-039).
 *
 * The rule is one sentence: resolve what the current revision no longer exhibits, leave standing
 * what it does, and post only what is new. Everything else here is a limit on that rule, and each
 * limit exists because the opposite behavior is a way for a gate to quietly stop meaning anything —
 * resolving a finding that still stands hides a real defect, resolving another party's finding
 * overrides a reviewer who is not this service, and resolving one for age alone converts patience
 * into approval.
 *
 * This module decides; `github/threads.ts` acts. Keeping the judgement here means there is exactly
 * one place to read to know what may be resolved.
 */

/** One of the service's own review threads, as `github/threads.ts` narrowed it. */
export interface OwnThread {
  readonly threadId: string;
  readonly findingId: string;
  readonly role: RoleName;
  readonly blocking: boolean;
  readonly isResolved: boolean;
  /** Author replies to this finding, in order. Untrusted data (FR-036). */
  readonly replies: readonly string[];
  /** Rounds this thread has been open. Recorded for the run, never a reason to resolve. */
  readonly roundsOpen?: number;
}

export interface ResolutionTarget {
  readonly threadId: string;
  readonly findingId: string;
}

export interface ReconcilePlan {
  /** Threads to resolve: the revision under review no longer exhibits these (FR-039). */
  readonly toResolve: readonly ResolutionTarget[];
  /** Findings the revision still exhibits: left open, and deliberately not reposted. */
  readonly standing: readonly ResolutionTarget[];
  /** Findings this round raised that no prior thread of ours already carries. */
  readonly toPost: readonly Finding[];
}

export interface ReconcileInput {
  /** The service's own prior threads on this pull request. */
  readonly priorThreads: readonly OwnThread[];
  /** What the revision under review exhibits, freshly derived (FR-017). */
  readonly currentFindings: readonly Finding[];
  readonly revision: string;
}

/**
 * A finding still stands when the current revision exhibits it at all — including when a waiver
 * has been requested against it. FR-045 is explicit that a `waiver-requested` finding is never
 * resolved by reconciliation, because the code still exhibits it; the gate is held by the
 * outstanding waiver until a human grants it.
 */
function stillExhibited(findingId: string, current: readonly Finding[]): boolean {
  return current.some((finding) => finding.id === findingId);
}

export function reconcile(input: ReconcileInput): ReconcilePlan {
  const { priorThreads, currentFindings } = input;

  const toResolve: ResolutionTarget[] = [];
  const standing: ResolutionTarget[] = [];

  for (const thread of priorThreads) {
    // Already resolved: resolving it again is a wasted content-creating request against a budget
    // FR-040 meters, and it would churn the thread for no change.
    if (thread.isResolved) continue;

    const target: ResolutionTarget = { threadId: thread.threadId, findingId: thread.findingId };

    // Age is deliberately not consulted. `roundsOpen` is carried for the record precisely so that
    // it is visible and unused (FR-015).
    if (stillExhibited(thread.findingId, currentFindings)) {
      standing.push(target);
    } else {
      toResolve.push(target);
    }
  }

  const alreadyRaised = new Set(priorThreads.map((thread) => thread.findingId));

  const toPost = currentFindings.filter((finding) => !alreadyRaised.has(finding.id));

  return { toResolve, standing, toPost };
}
