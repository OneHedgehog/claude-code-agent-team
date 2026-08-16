import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { toConclusion, GateReportError } from "../../../src/github/check-run.js";
import { aggregate, missingVerdict, type GateFinding } from "../../../src/review/gate.js";

/**
 * FR-023 and FR-024, asserted as properties of the whole module rather than of one function:
 * no code path yields `neutral`, `skipped`, or `cancelled`, and every `failure` carries a reason.
 *
 * GitHub treats `neutral` and `skipped` as non-failing, which makes either of them precisely the
 * "absent gate that reads as no objection" Principle IV prohibits. The source assertion below is
 * deliberately crude — it is a tripwire for the day someone adds one back.
 */

const FORBIDDEN = ["neutral", "skipped", "cancelled"] as const;

function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../src/${relative}`, import.meta.url)), "utf8");
}

describe("forbidden conclusions never appear (FR-023)", () => {
  for (const module of ["github/check-run.ts", "review/gate.ts"]) {
    it(`${module} names no forbidden conclusion outside a comment`, () => {
      const code = sourceOf(module)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");

      for (const forbidden of FORBIDDEN) {
        expect(code).not.toContain(`"${forbidden}"`);
      }
    });
  }
});

describe("every failure carries a reason (FR-024)", () => {
  it("refuses to report a failure with no reason", () => {
    expect(() => toConclusion({ conclusion: "failure" })).toThrow(GateReportError);
  });

  it("refuses to report a failure whose reason is empty", () => {
    expect(() => toConclusion({ conclusion: "failure", reason: "" })).toThrow(GateReportError);
  });

  it("accepts a failure that states a reason", () => {
    expect(toConclusion({ conclusion: "failure", reason: "security requested changes" })).toBe(
      "failure",
    );
  });

  it("maps success without requiring a reason", () => {
    expect(toConclusion({ conclusion: "success" })).toBe("success");
  });

  it("maps unreported to no conclusion at all rather than to a passing one", () => {
    expect(toConclusion({ conclusion: "unreported" })).toBeNull();
  });
});

describe("aggregate only ever yields the three permitted conclusions", () => {
  const permitted = new Set(["success", "failure", "unreported"]);

  const findings: GateFinding[] = [
    { id: "a", role: "security", blocking: true, status: "open" },
    { id: "b", role: "implementation", blocking: false, status: "resolved" },
    { id: "c", role: "security", blocking: true, status: "waiver-requested" },
  ];

  const outcomes = [
    { role: "security" as const, decision: "approve" as const, revision: "abc" },
    { role: "security" as const, decision: "request-changes" as const, revision: "abc" },
    { role: "security" as const, decision: "approve" as const, revision: "stale" },
    missingVerdict("security", "the model produced no verdict"),
  ];

  it("across every combination of outcome, finding, and conclusion state", () => {
    for (const outcome of outcomes) {
      for (let mask = 0; mask < 1 << findings.length; mask += 1) {
        for (const concluded of [true, false]) {
          const selected = findings.filter((_, index) => (mask & (1 << index)) !== 0);

          const result = aggregate({
            requiredRoles: ["security"],
            outcomes: [outcome],
            findings: selected,
            revision: "abc",
            concluded,
          });

          expect(permitted.has(result.conclusion)).toBe(true);

          if (result.conclusion === "failure") {
            expect(result.reason ?? "").not.toBe("");
          }
        }
      }
    }
  });

  it("never passes on a missing verdict, whatever else is true", () => {
    const result = aggregate({
      requiredRoles: ["security"],
      outcomes: [missingVerdict("security", "the model produced no verdict")],
      findings: [],
      revision: "abc",
      concluded: true,
    });

    expect(result.conclusion).toBe("failure");
  });

  it("never passes with no outcome recorded at all", () => {
    const result = aggregate({
      requiredRoles: ["security", "implementation"],
      outcomes: [],
      findings: [],
      revision: "abc",
      concluded: true,
    });

    expect(result.conclusion).toBe("failure");
  });
});
