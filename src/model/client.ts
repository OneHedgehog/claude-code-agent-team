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
   * Tokens written to the prompt cache, billed above the input rate. A component of the run's total
   * draw, not an addition to it.
   */
  readonly cacheWriteTokens: number;
  /**
   * Tokens served from the prompt cache, billed well below the input rate. A component of the run's
   * total draw, not an addition to it.
   *
   * Recorded because the saving is otherwise unobservable: a cache that silently stopped matching
   * -- a byte changed in the constitution, a breakpoint moved, a prefix that fell out before the
   * next review -- costs full price and looks exactly like one that is working. This counter
   * staying at zero across consecutive reviews is the symptom, and nothing else reports it.
   *
   * Two benign causes read identically. A breakpoint on a prefix below the provider's minimum
   * cacheable length is ignored rather than rejected, so a target with a short constitution reports
   * zeroes while everything here works -- `docs/` says to check the constitution's size first. And
   * `AgentSdkModelClient` sets no breakpoint of its own, so under that transport these two counters
   * are the harness's own accounting and a large write against a zero read means nothing is wrong.
   */
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
  /**
   * Which provider produced this verdict (FR-079).
   *
   * A verdict whose author is unrecorded cannot be weighed later against that provider's track
   * record (Principle VII), and once a role can fail over there is no longer one obvious answer
   * to infer. It reaches the check-run output rather than only the host log (R-025), because that
   * output is what `reconstruct.ts` rebuilds the ledger from.
   */
  readonly provider: string;
}

/**
 * Whether a failure says anything about the reviewed revision (FR-078).
 *
 * `capacity` — a session limit, a rate limit, exhausted credit, an unreachable provider, an
 * attempt that outran its bound. None of these is a statement about the diff, so the next
 * provider in the route MAY be asked.
 *
 * `contract` — a response arrived and missed the schema (FR-059), a tool was refused (FR-064), or
 * no verdict was produced (FR-007). Each is a statement about *this* run or *this* content.
 * Asking a different provider would be shopping for a verdict, and a gate that keeps asking until
 * something approves is not a gate.
 *
 * The discriminator across a subprocess boundary is whether a parseable response arrived at all
 * (R-022). Classification belongs to the client that made the call — only it knows — and a router
 * that guessed from an error message would reintroduce the generic call failure FR-078 forbids.
 */
export type FailureClass = "capacity" | "contract";

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
  /**
   * Whether the route may advance past this failure (FR-078).
   *
   * Defaulted to `contract` rather than `capacity`, and the direction matters: an unclassified
   * failure treated as capacity would silently ask the next provider, which is the
   * verdict-shopping FR-078 exists to prevent. Defaulting the other way costs at most a failover
   * that could have happened, and a gate that fails closed is the behaviour Principle IV asks for
   * when something is unknown.
   */
  readonly failureClass: FailureClass;
  /** The provider that failed. Named in the record, never inferred (FR-079). */
  readonly provider: string;

  constructor(
    message: string,
    usage: ModelUsage = ZERO_USAGE,
    options?: { cause?: unknown; failureClass?: FailureClass; provider?: string },
  ) {
    // `cause` is carried so a wrapped failure keeps the site it came from. A retry has to wrap in
    // order to attach the accumulated spend, and without this every failure leaving the loop was a
    // bare error whose stack pointed at the wrap rather than at what broke.
    super(message, options);
    this.usage = usage;
    this.failureClass = options?.failureClass ?? "contract";
    this.provider = options?.provider ?? "unknown";
  }
}

/** One provider's turn within a role's route (data-model.md → Attempt). */
export interface RouteAttempt {
  readonly provider: string;
  /** Position in the route. Distinct from the review *round* (FR-075). */
  readonly index: number;
  readonly failureClass: FailureClass;
  /** Charged even on failure, at no less than the prompt sent (FR-067). */
  readonly usage: ModelUsage;
}

/**
 * Every provider in a role's route returned a capacity failure (FR-080).
 *
 * It is a `ModelError` so that `runRole` turns it into a missing verdict exactly as it turns any
 * other model failure into one — the gate fails closed with no new path through `role.ts`. Its
 * class is `capacity` because that is what every attempt reported; nothing here says anything
 * about the reviewed revision.
 */
export class RouteExhaustedError extends ModelError {
  readonly attempts: readonly RouteAttempt[];

  constructor(role: string, attempts: readonly RouteAttempt[]) {
    const tried = attempts.map((a) => `${a.provider} (${a.failureClass})`).join(", ");
    super(
      `every provider in the ${role} route failed on capacity: ${tried}. ` +
        `No verdict was produced for this revision, and the gate fails closed (FR-080).`,
      sumUsage(attempts.map((a) => a.usage)),
      { failureClass: "capacity", provider: attempts.at(-1)?.provider ?? "unknown" },
    );
    this.attempts = attempts;
  }
}

/** Adds usage across attempts. A failed attempt still spent, so none of them is dropped. */
export function sumUsage(all: readonly ModelUsage[]): ModelUsage {
  return all.reduce<ModelUsage>(
    (total, one) => ({
      inputTokens: total.inputTokens + one.inputTokens,
      outputTokens: total.outputTokens + one.outputTokens,
      cacheWriteTokens: total.cacheWriteTokens + one.cacheWriteTokens,
      cacheReadTokens: total.cacheReadTokens + one.cacheReadTokens,
    }),
    ZERO_USAGE,
  );
}

export function totalTokens(usage: ModelUsage): number {
  // Cached input counts. The API reports `input_tokens` *excluding* anything served from or written
  // to the cache, so summing input and output alone stopped being the whole bill the moment a cache
  // breakpoint was added: a review reading 10,800 cached tokens would have recorded ~2,000. Cheaper
  // is not free, and a ledger that under-counts is the failure FR-031 exists to prevent -- it would
  // have let the saving hide the spend.
  return usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
}

/**
 * Characters per token, for the two places that must agree: the budget forecast that authorises a
 * review, and the spend floor charged when one is abandoned before the model reports usage
 * (FR-067). Defined once rather than twice with a comment claiming the two match.
 */
export const CHARS_PER_TOKEN = 4;
