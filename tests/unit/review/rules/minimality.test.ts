import { describe, expect, it } from "vitest";

import {
  MINIMALITY_CATEGORIES,
  checkMinimality,
  detectCommentedOutCode,
  type MinimalityObservation,
} from "../../../../src/review/rules/minimality.js";

function check(observations: readonly MinimalityObservation[]) {
  return checkMinimality({ observations, excludedPaths: [] });
}

describe("the categories Principle X names (FR-042)", () => {
  it("declares each one the constitution lists", () => {
    expect([...MINIMALITY_CATEGORIES].sort()).toEqual(
      [
        "unrelated-refactor",
        "opportunistic-rename",
        "formatting-only",
        "unrequired-dependency",
        "dead-code",
      ].sort(),
    );
  });
});

describe("each category is a blocking finding naming the content (FR-042)", () => {
  it.each(MINIMALITY_CATEGORIES)("blocks on %s", (category) => {
    const findings = check([
      { category, path: "src/other.ts", line: 12, detail: "renamed `foo` to `bar`" },
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.blocking).toBe(true);
    expect(findings[0]?.severity).toBe("high");
  });

  it.each(MINIMALITY_CATEGORIES)("names the content in the finding for %s", (category) => {
    const findings = check([
      { category, path: "src/other.ts", line: 12, detail: "renamed `foo` to `bar`" },
    ]);

    expect(findings[0]?.description).toContain("src/other.ts");
    expect(findings[0]?.description).toContain("renamed `foo` to `bar`");
  });

  it("carries the category as the rule, so reconciliation can match it across rounds", () => {
    expect(check([{ category: "dead-code", path: "a.ts", detail: "x" }])[0]?.rule).toBe(
      "minimality:dead-code",
    );
  });
});

describe("anchoring", () => {
  it("anchors to the offending line when one is known (FR-010)", () => {
    const findings = check([
      { category: "unrelated-refactor", path: "src/a.ts", line: 7, detail: "x" },
    ]);

    expect(findings[0]?.location).toEqual({ path: "src/a.ts", line: 7, side: "RIGHT" });
  });

  it("falls back to pull-request level when no line is known (FR-014)", () => {
    const findings = check([
      { category: "unrequired-dependency", path: "package.json", detail: "x" },
    ]);

    expect(findings[0]?.location).toEqual({ pullRequestLevel: true });
  });
});

describe("nothing to report", () => {
  it("reports nothing when the diff carries only what the spec asked for", () => {
    expect(check([])).toEqual([]);
  });

  it("ignores an observation on an excluded path (FR-053)", () => {
    const findings = checkMinimality({
      observations: [{ category: "formatting-only", path: "package-lock.json", detail: "x" }],
      excludedPaths: ["package-lock.json"],
    });

    expect(findings).toEqual([]);
  });
});

describe("detecting commented-out code (FR-042)", () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,6 @@
 const kept = 1;
+// const old = compute(a, b);
+// return old + 1;
+// This explains why the algorithm works.
+const added = 2;
`;

  it("flags added lines that are commented-out statements", () => {
    const observations = detectCommentedOutCode(diff);

    expect(observations.map((o) => o.line)).toEqual([2, 3]);
    expect(observations.every((o) => o.category === "dead-code")).toBe(true);
  });

  it("does not flag an ordinary prose comment", () => {
    const observations = detectCommentedOutCode(diff);

    expect(observations.some((o) => o.detail.includes("This explains why"))).toBe(false);
  });

  it("does not flag live code", () => {
    const observations = detectCommentedOutCode(diff);

    expect(observations.some((o) => o.detail.includes("const added"))).toBe(false);
  });

  it("reports nothing for a diff with no commented-out code", () => {
    const clean = `--- a/a.ts
+++ b/a.ts
@@ -1 +1,2 @@
 const a = 1;
+const b = 2;
`;

    expect(detectCommentedOutCode(clean)).toEqual([]);
  });
});
