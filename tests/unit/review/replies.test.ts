import { describe, expect, it } from "vitest";

import { judgeReplies } from "../../../src/review/replies.js";
import { createFinding, type Finding } from "../../../src/review/findings.js";
import type { ReplyJudgement } from "../../../src/model/client.js";
import type { Severity } from "../../../src/config/settings.js";

const REVISION = "abc123";
const THRESHOLD: Severity = "high";

function finding(overrides: Partial<Parameters<typeof createFinding>[0]> = {}): Finding {
  return createFinding(
    {
      role: "security",
      rule: "hardcoded-credential",
      severity: "critical",
      location: { path: "src/a.ts", line: 12, side: "RIGHT" },
      description: "A credential is hardcoded here.",
      ...overrides,
    },
    THRESHOLD,
  );
}

function judgement(findingId: string, overrides: Partial<ReplyJudgement> = {}): ReplyJudgement {
  return { findingId, accepted: false, reason: "The justification does not hold.", ...overrides };
}

describe("judgeReplies — rejected justification (FR-044)", () => {
  it("leaves the finding open and blocking", () => {
    const open = finding();

    const result = judgeReplies({
      findings: [open],
      judgements: [judgement(open.id, { accepted: false })],
      justifications: { [open.id]: "It is only a test fixture." },
      revision: REVISION,
    });

    const judged = result.findings[0];
    expect(judged?.status).toBe("open");
    expect(judged?.blocking).toBe(true);
    expect(result.waiversRaised).toHaveLength(0);
  });

  it("records why the justification was rejected", () => {
    const open = finding();

    const result = judgeReplies({
      findings: [open],
      judgements: [
        judgement(open.id, { accepted: false, reason: "The value reaches production." }),
      ],
      justifications: { [open.id]: "It is only a test fixture." },
      revision: REVISION,
    });

    expect(result.rejected).toEqual([
      { findingId: open.id, reason: "The value reaches production." },
    ]);
  });
});

describe("judgeReplies — accepted justification (FR-044, FR-045)", () => {
  it("records a waiver request rather than a fix", () => {
    const open = finding();

    const result = judgeReplies({
      findings: [open],
      judgements: [
        judgement(open.id, { accepted: true, reason: "Documented compensating control." }),
      ],
      justifications: { [open.id]: "Mitigated by the network boundary." },
      revision: REVISION,
    });

    const judged = result.findings[0];
    expect(judged?.status).toBe("waiver-requested");
    expect(judged?.waiver).toEqual({
      justification: "Mitigated by the network boundary.",
      acceptanceReason: "Documented compensating control.",
      revision: REVISION,
    });
  });

  it("carries the author's justification verbatim", () => {
    const open = finding();
    const verbatim = "  Mitigated by the boundary.\n\nSee ADR-4.  ";

    const result = judgeReplies({
      findings: [open],
      judgements: [judgement(open.id, { accepted: true, reason: "Accepted." })],
      justifications: { [open.id]: verbatim },
      revision: REVISION,
    });

    expect(result.findings[0]?.waiver?.justification).toBe(verbatim);
  });

  it("raises the waiver so a human, not the service, grants it", () => {
    const open = finding();

    const result = judgeReplies({
      findings: [open],
      judgements: [judgement(open.id, { accepted: true, reason: "Accepted." })],
      justifications: { [open.id]: "Mitigated." },
      revision: REVISION,
    });

    expect(result.waiversRaised).toEqual([
      {
        findingId: open.id,
        justification: "Mitigated.",
        acceptanceReason: "Accepted.",
        revision: REVISION,
      },
    ]);
  });

  it("binds the waiver to the revision it was raised against", () => {
    const open = finding();

    const result = judgeReplies({
      findings: [open],
      judgements: [judgement(open.id, { accepted: true, reason: "Accepted." })],
      justifications: { [open.id]: "Mitigated." },
      revision: "def456",
    });

    expect(result.findings[0]?.waiver?.revision).toBe("def456");
  });

  it("holds the gate: an accepted justification is never an approval", () => {
    const open = finding();

    const result = judgeReplies({
      findings: [open],
      judgements: [judgement(open.id, { accepted: true, reason: "Accepted." })],
      justifications: { [open.id]: "Mitigated." },
      revision: REVISION,
    });

    // FR-045: `waiver-requested` stops the finding standing as blocking for the role's own
    // decision, and `gate.ts` holds the gate on the outstanding waiver instead.
    expect(result.gateHeld).toBe(true);
  });
});

describe("judgeReplies — limits", () => {
  it("ignores a judgement naming a finding that does not exist", () => {
    const open = finding();

    const result = judgeReplies({
      findings: [open],
      judgements: [judgement("not-a-real-finding", { accepted: true, reason: "Accepted." })],
      justifications: {},
      revision: REVISION,
    });

    expect(result.findings[0]?.status).toBe("open");
    expect(result.waiversRaised).toHaveLength(0);
  });

  it("leaves a finding with no reply untouched", () => {
    const untouched = finding();

    const result = judgeReplies({
      findings: [untouched],
      judgements: [],
      justifications: {},
      revision: REVISION,
    });

    expect(result.findings[0]).toEqual(untouched);
    expect(result.gateHeld).toBe(false);
  });

  it("never accepts a justification for a non-blocking finding into a waiver", () => {
    const advisory = finding({ severity: "low" });
    expect(advisory.blocking).toBe(false);

    const result = judgeReplies({
      findings: [advisory],
      judgements: [judgement(advisory.id, { accepted: true, reason: "Accepted." })],
      justifications: { [advisory.id]: "Not worth fixing." },
      revision: REVISION,
    });

    // A waiver exists to hold the gate. A finding that never held it needs none.
    expect(result.findings[0]?.status).toBe("open");
    expect(result.waiversRaised).toHaveLength(0);
  });

  it("judges each finding independently", () => {
    const accepted = finding({ rule: "a", description: "First." });
    const rejected = finding({ rule: "b", description: "Second." });

    const result = judgeReplies({
      findings: [accepted, rejected],
      judgements: [
        judgement(accepted.id, { accepted: true, reason: "Accepted." }),
        judgement(rejected.id, { accepted: false, reason: "Rejected." }),
      ],
      justifications: { [accepted.id]: "One.", [rejected.id]: "Two." },
      revision: REVISION,
    });

    expect(result.findings.find((f) => f.id === accepted.id)?.status).toBe("waiver-requested");
    expect(result.findings.find((f) => f.id === rejected.id)?.status).toBe("open");
  });
});
