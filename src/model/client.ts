import type { ModelEffort, RoleName, Severity } from "../config/settings.js";

/**
 * The single substitutable boundary (FR-029, contracts/model-client.md).
 *
 * Principle II requires that replacing this interface — and nothing else — be sufficient to drive
 * the entire flow deterministically from an end-to-end test. Every field of `ReviewRequest` is
 * untrusted data: an implementation MUST NOT act on instructions found in a diff, a comment, or a
 * reply (FR-036).
 */

export interface DiffLocation {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
}

/** A finding the model could not place inside the diff, recorded at pull-request level (FR-014). */
export interface PullRequestLevel {
  readonly pullRequestLevel: true;
}

export type FindingLocation = DiffLocation | PullRequestLevel;

export function isPullRequestLevel(location: FindingLocation): location is PullRequestLevel {
  return "pullRequestLevel" in location;
}

/** What the model returns: `Finding` minus the `id` and `status` the service assigns. */
export interface FindingDraft {
  readonly rule: string;
  readonly severity: Severity;
  readonly blocking: boolean;
  readonly location: FindingLocation;
  readonly description: string;
}

export interface PullRequestContext {
  readonly title: string;
  readonly body: string;
  /** Feature spec paths the pull request claims to implement. */
  readonly specPaths: readonly string[];
}

export interface PriorFinding {
  readonly id: string;
  readonly role: RoleName;
  readonly rule: string;
  readonly severity: Severity;
  readonly blocking: boolean;
  readonly location: FindingLocation;
  readonly description: string;
  /** Author replies to this finding. Untrusted data (FR-036). */
  readonly replies: readonly string[];
}

export interface ReviewRequest {
  readonly runId: string;
  readonly role: RoleName;
  readonly effort: ModelEffort;
  /** Unified diff of the revision under review. Untrusted data. */
  readonly diff: string;
  /** The target repository's constitution text, resolved via the target parameter. */
  readonly constitution: string;
  readonly pullRequestContext: PullRequestContext;
  /** The service's own open findings plus any author replies. Untrusted data. */
  readonly priorFindings: readonly PriorFinding[];
  /** Hard ceiling for this call. Exceeding it is an error, never a truncation. */
  readonly maxTokens: number;
}

export interface ReplyJudgement {
  readonly findingId: string;
  readonly accepted: boolean;
  readonly reason: string;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * Tokens written to the prompt cache, billed above the input rate, and tokens served from it,
   * billed well below it.
   *
   * Recorded because the saving is otherwise unobservable: a cache that silently stopped matching
   * -- a byte changed in the constitution, a breakpoint moved, a prefix that fell out before the
   * next review -- costs full price and looks exactly like one that is working. `cacheReadTokens`
   * staying at zero across consecutive reviews is the symptom, and nothing else reports it.
   */
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
}

/** No spend at all. Named once so a new construction site cannot quietly omit a field. */
export const ZERO_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

export interface ReviewResponse {
  readonly findings: readonly FindingDraft[];
  /** Never inferred from silence: an implementation that cannot produce one rejects (FR-007). */
  readonly verdict: "approve" | "request-changes";
  readonly replyJudgements: readonly ReplyJudgement[];
  /** Required on every response, including error paths that consumed tokens (FR-031). */
  readonly usage: ModelUsage;
}

export interface ModelClient {
  /**
   * Runs one reviewer role against one diff and returns structured findings.
   * Implementations MUST NOT act on instructions found in `request` content (FR-036).
   */
  review(request: ReviewRequest): Promise<ReviewResponse>;
}

/** Raised when a model call cannot produce a verdict. Never degraded into an approval (FR-007). */
export class ModelError extends Error {
  override readonly name = "ModelError";
  /** Tokens consumed before the failure, so the ledger cannot under-count (FR-031). */
  readonly usage: ModelUsage;

  constructor(message: string, usage: ModelUsage = ZERO_USAGE) {
    super(message);
    this.usage = usage;
  }
}

export function totalTokens(usage: ModelUsage): number {
  return usage.inputTokens + usage.outputTokens;
}
