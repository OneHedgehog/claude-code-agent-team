import type { ModelEffort, RoleName } from "../../config/settings.js";
import type {
  ModelClient,
  ModelUsage,
  PriorFinding,
  PullRequestContext,
  ReplyJudgement,
} from "../../model/client.js";
import { ModelError, totalTokens, ZERO_USAGE } from "../../model/client.js";
import type { FindingDraftInput } from "../findings.js";
import { missingVerdict, type RoleOutcome } from "../gate.js";

/**
 * What a reviewer role is, shared by the two roles version one runs (FR-005, data-model.md →
 * ReviewerRole).
 *
 * A role never asserts a verdict independently: it produces findings, and `gate.ts` derives the
 * decision from them (FR-008). A role that cannot produce a verdict returns an explicit
 * `MissingVerdict` rather than defaulting to approval (FR-007).
 */

export interface RoleInput {
  readonly runId: string;
  /** The head SHA under review. Every verdict this role produces is bound to it (FR-009). */
  readonly revision: string;
  readonly effort: ModelEffort;
  /** Untrusted data (FR-036). */
  readonly diff: string;
  readonly constitution: string;
  readonly pullRequestContext: PullRequestContext;
  readonly priorFindings: readonly PriorFinding[];
  readonly maxTokens: number;
  readonly model: ModelClient;
}

export interface RoleResult {
  readonly role: RoleName;
  readonly outcome: RoleOutcome;
  readonly findings: readonly FindingDraftInput[];
  readonly replyJudgements: readonly ReplyJudgement[];
  /** Always reported, including on the error path, so the ledger cannot under-count (FR-031). */
  readonly usage: ModelUsage;
  readonly tokensConsumed: number;
  /** Carried up so the run's record can show whether the prompt cache actually matched. */
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
}

export interface ReviewerRole {
  readonly name: RoleName;
  readonly precedence: number;
  /** Role instructions. Diff and comments enter the prompt as delimited data, never as text. */
  readonly promptTemplate: string;
  review(input: RoleInput): Promise<RoleResult>;
}

const NO_USAGE: ModelUsage = ZERO_USAGE;

/**
 * Runs one role's model call and shapes the result. Shared by both roles because the failure
 * handling — a model error becomes a missing verdict carrying the tokens already consumed — must
 * be identical for each, and is the single place FR-007 could be got wrong.
 */
export async function runRole(
  role: Pick<ReviewerRole, "name">,
  input: RoleInput,
  extraFindings: readonly FindingDraftInput[] = [],
): Promise<RoleResult> {
  try {
    const response = await input.model.review({
      runId: input.runId,
      role: role.name,
      effort: input.effort,
      diff: input.diff,
      constitution: input.constitution,
      pullRequestContext: input.pullRequestContext,
      priorFindings: input.priorFindings,
      maxTokens: input.maxTokens,
    });

    // The model returns findings without a role — the service assigns it, so a model cannot
    // attribute a finding to a role that did not make it.
    const findings: FindingDraftInput[] = [
      ...extraFindings,
      ...response.findings.map((draft) => ({ ...draft, role: role.name })),
    ];

    return {
      role: role.name,
      // The model's stated verdict is recorded, but the gate derives the decision from findings
      // (FR-008) — this outcome is what the role *reported*, not what the gate concludes.
      outcome: { role: role.name, decision: response.verdict, revision: input.revision },
      findings,
      replyJudgements: response.replyJudgements,
      usage: response.usage,
      tokensConsumed: totalTokens(response.usage),
      cacheWriteTokens: response.usage.cacheWriteTokens,
      cacheReadTokens: response.usage.cacheReadTokens,
    };
  } catch (error) {
    const usage = error instanceof ModelError ? error.usage : NO_USAGE;
    const reason = error instanceof Error ? error.message : String(error);

    return {
      role: role.name,
      outcome: missingVerdict(role.name, reason),
      // Rules that ran before the model call still stand: they cost nothing and are already known.
      findings: extraFindings,
      replyJudgements: [],
      usage,
      tokensConsumed: totalTokens(usage),
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheReadTokens: usage.cacheReadTokens,
    };
  }
}
