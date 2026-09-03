import type {
  FindingDraft,
  FindingLocation,
  ReplyJudgement,
  ReviewResponse,
} from "../../../src/model/client.js";
import type { Script } from "../../../src/model/scripted.js";

/**
 * Scripted model responses, built rather than spelled out (tasks.md T032, R-015).
 *
 * Every scenario substitutes `ScriptedModelClient` and nothing else, so what each scenario is
 * *about* is the shape of the response it scripts — a blocking finding here, a rejected reply
 * there. Spelling out the same six-field literal twenty times would bury that shape in boilerplate
 * and, worse, invite a scenario to drift on a field it never meant to vary.
 *
 * The wording in these findings is deliberately inert. It is data the service moves around, never
 * anything a scenario asserts on: Principle II forbids an end-to-end assertion on generated
 * content, and `local/no-generated-content-assertions` enforces it (FR-030, SC-010).
 */

/**
 * The usage every scripted response reports. Non-zero on purpose: a scenario that asserts tokens
 * were spent, and one that asserts they were not, must be able to tell the two apart, and a double
 * reporting zero would make every run look like a run that stopped before spending (FR-031).
 */
export const SCRIPTED_USAGE = {
  inputTokens: 1_000,
  outputTokens: 100,
  // Non-zero, so the e2e layer exercises the path a real review takes: the constitution is a cached
  // prefix, and every scenario that asserts on spend would otherwise only ever see a cold call.
  cacheWriteTokens: 200,
  cacheReadTokens: 800,
} as const;

export interface FindingOptions {
  readonly rule?: string;
  readonly severity?: FindingDraft["severity"];
  readonly blocking?: boolean;
  readonly location?: FindingLocation;
  readonly description?: string;
}

/** A finding anchored to a line of the diff (FR-010). */
export function anchoredFinding(
  path: string,
  line: number,
  options: FindingOptions = {},
): FindingDraft {
  return {
    rule: options.rule ?? "scripted-finding",
    severity: options.severity ?? "high",
    blocking: options.blocking ?? true,
    location: options.location ?? { path, line, side: "RIGHT" },
    description: options.description ?? "Scripted by the end-to-end harness.",
  };
}

/** A finding the service records at pull-request level rather than dropping (FR-014). */
export function pullRequestLevelFinding(options: FindingOptions = {}): FindingDraft {
  return {
    rule: options.rule ?? "scripted-pull-request-level",
    severity: options.severity ?? "high",
    blocking: options.blocking ?? true,
    location: { pullRequestLevel: true },
    description: options.description ?? "Scripted by the end-to-end harness.",
  };
}

export function response(
  findings: readonly FindingDraft[] = [],
  judgements: readonly ReplyJudgement[] = [],
): ReviewResponse {
  return {
    findings,
    // Derived rather than stated, exactly as `gate.ts` derives a role's decision: a script that
    // could say `approve` while carrying a blocking finding would let a scenario assert on a
    // combination the service can never produce (FR-008).
    verdict: findings.some((finding) => finding.blocking) ? "request-changes" : "approve",
    replyJudgements: judgements,
    usage: SCRIPTED_USAGE,
  };
}

/** Both roles clean. The baseline every scenario that is not about a finding starts from. */
export function bothApprove(): Script {
  return { security: response(), implementation: response() };
}

/** One script per role, each defaulting to a clean response. */
export function script(
  roles: { readonly security?: ReviewResponse; readonly implementation?: ReviewResponse } = {},
): Script {
  return {
    security: roles.security ?? response(),
    implementation: roles.implementation ?? response(),
  };
}
