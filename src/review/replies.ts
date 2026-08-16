import type { ReplyJudgement } from "../model/client.js";
import type { Finding, WaiverRequest } from "./findings.js";

/**
 * Judging an author's stated justification, and the waiver path it opens (FR-044, FR-045).
 *
 * Principle VI lets an author answer a blocking finding two ways: change the code, or reply with a
 * justification. This module handles the second, and its whole design turns on one distinction —
 * accepting a justification is *not* accepting the code. A rejected justification leaves the
 * finding exactly as it was. An accepted one converts it into a waiver *request*, which holds the
 * gate until a human grants it. The service never grants its own waiver, because a reviewer that
 * can waive its own findings is not a gate (Principle VI: "waivers require a recorded,
 * human-approved reason").
 */

export interface RaisedWaiver {
  readonly findingId: string;
  readonly justification: string;
  readonly acceptanceReason: string;
  readonly revision: string;
}

export interface RejectedJustification {
  readonly findingId: string;
  readonly reason: string;
}

export interface JudgeRepliesInput {
  readonly findings: readonly Finding[];
  /** What the model concluded about each reply. Structured, never parsed from prose (FR-030). */
  readonly judgements: readonly ReplyJudgement[];
  /** The author's stated justification per finding, carried verbatim into the waiver. */
  readonly justifications: Readonly<Record<string, string>>;
  readonly revision: string;
}

export interface JudgeRepliesResult {
  readonly findings: readonly Finding[];
  readonly waiversRaised: readonly RaisedWaiver[];
  readonly rejected: readonly RejectedJustification[];
  /** True while any waiver is outstanding: the gate cannot pass on the service's say-so (FR-045). */
  readonly gateHeld: boolean;
}

export function judgeReplies(input: JudgeRepliesInput): JudgeRepliesResult {
  const { findings, judgements, justifications, revision } = input;

  const byFinding = new Map(judgements.map((judgement) => [judgement.findingId, judgement]));

  const waiversRaised: RaisedWaiver[] = [];
  const rejected: RejectedJustification[] = [];

  const judged = findings.map((finding) => {
    const judgement = byFinding.get(finding.id);
    if (judgement === undefined) return finding;

    if (!judgement.accepted) {
      // FR-044: the finding is untouched. It stays open and, if it was blocking, stays blocking.
      rejected.push({ findingId: finding.id, reason: judgement.reason });
      return finding;
    }

    // A waiver exists to hold a gate that a finding was holding. A non-blocking finding never held
    // it, so there is nothing for a human to grant and no reason to manufacture the request.
    if (!finding.blocking) return finding;

    const justification = justifications[finding.id] ?? "";

    const waiver: WaiverRequest = {
      justification,
      acceptanceReason: judgement.reason,
      revision,
    };

    waiversRaised.push({
      findingId: finding.id,
      justification,
      acceptanceReason: judgement.reason,
      revision,
    });

    return { ...finding, status: "waiver-requested" as const, waiver };
  });

  return {
    findings: judged,
    waiversRaised,
    rejected,
    gateHeld: waiversRaised.length > 0,
  };
}
