import { describe, expect, it } from "vitest";

import { checkDocumentation, isDocPath, isTestPath } from "../../../../src/review/rules/docs.js";

function rules(input: {
  changedPaths: readonly string[];
  staleDocuments?: readonly string[];
  excludedPaths?: readonly string[];
}) {
  return checkDocumentation({
    changedPaths: input.changedPaths,
    excludedPaths: input.excludedPaths ?? [],
    staleDocuments: input.staleDocuments ?? [],
  });
}

const ruleNames = (findings: ReturnType<typeof rules>): string[] =>
  findings.map((finding) => finding.rule);

describe("classifying paths", () => {
  it.each(["tests/unit/a.test.ts", "src/a.test.ts", "tests/e2e/a.e2e.ts", "src/a.spec.ts"])(
    "treats %s as a test",
    (path) => {
      expect(isTestPath(path)).toBe(true);
    },
  );

  it.each(["src/cli.ts", "docs/feature.md"])("does not treat %s as a test", (path) => {
    expect(isTestPath(path)).toBe(false);
  });

  it("treats docs/ as documentation and specs/ as something else (Principle IX)", () => {
    expect(isDocPath("docs/independent-review-service.md")).toBe(true);
    // A link to the spec is not documentation, and a spec is never rewritten.
    expect(isDocPath("specs/001-feature/spec.md")).toBe(false);
  });
});

describe("behavior change requires a test (FR-016)", () => {
  it("blocks a source change with no test alongside it", () => {
    const findings = rules({ changedPaths: ["src/cli.ts", "docs/feature.md"] });

    expect(ruleNames(findings)).toContain("missing-tests");
    expect(findings.find((f) => f.rule === "missing-tests")?.severity).toBe("high");
  });

  it("accepts a source change that ships its test", () => {
    const findings = rules({
      changedPaths: ["src/cli.ts", "tests/unit/cli.test.ts", "docs/feature.md"],
    });

    expect(ruleNames(findings)).not.toContain("missing-tests");
  });
});

describe("behavior change requires a current document (FR-016, Principle IX)", () => {
  it("blocks a source change with no docs/ update", () => {
    const findings = rules({ changedPaths: ["src/cli.ts", "tests/unit/cli.test.ts"] });

    expect(ruleNames(findings)).toContain("missing-or-stale-document");
  });

  it("accepts a source change that updates its document", () => {
    const findings = rules({
      changedPaths: ["src/cli.ts", "tests/unit/cli.test.ts", "docs/feature.md"],
    });

    expect(findings).toEqual([]);
  });

  it("does not accept a spec update in place of a document", () => {
    const findings = rules({
      changedPaths: ["src/cli.ts", "tests/unit/cli.test.ts", "specs/001-x/spec.md"],
    });

    expect(ruleNames(findings)).toContain("missing-or-stale-document");
  });
});

describe("the stale-document case (FR-016)", () => {
  it("blocks a docs/ file that is present but still describes the superseded behavior", () => {
    const findings = rules({
      changedPaths: ["src/cli.ts", "tests/unit/cli.test.ts", "docs/feature.md"],
      staleDocuments: ["docs/other.md"],
    });

    expect(ruleNames(findings)).toContain("stale-document");
  });

  it("names the stale document, so the finding is actionable", () => {
    const findings = rules({
      changedPaths: ["src/cli.ts", "tests/unit/cli.test.ts", "docs/feature.md"],
      staleDocuments: ["docs/other.md"],
    });

    expect(findings.find((f) => f.rule === "stale-document")?.description).toContain(
      "docs/other.md",
    );
  });

  it("anchors the stale-document finding to the document itself", () => {
    const findings = rules({
      changedPaths: ["src/cli.ts", "tests/unit/cli.test.ts", "docs/feature.md"],
      staleDocuments: ["docs/other.md"],
    });

    expect(findings.find((f) => f.rule === "stale-document")?.location).toEqual({
      pullRequestLevel: true,
    });
  });

  it("treats staleness as blocking rather than as a cleanup task (Principle IX)", () => {
    const findings = rules({
      changedPaths: ["src/cli.ts", "tests/unit/cli.test.ts", "docs/feature.md"],
      staleDocuments: ["docs/other.md"],
    });

    expect(findings.find((f) => f.rule === "stale-document")?.severity).toBe("high");
  });
});

describe("the documentation-only exemption (FR-016)", () => {
  it("asks for neither a test nor a document when only docs changed", () => {
    expect(rules({ changedPaths: ["docs/feature.md"] })).toEqual([]);
  });

  it("asks for neither when only tests changed", () => {
    expect(rules({ changedPaths: ["tests/unit/cli.test.ts"] })).toEqual([]);
  });

  it("asks for neither when the diff is empty", () => {
    expect(rules({ changedPaths: [] })).toEqual([]);
  });

  it("still reports a stale document even under the exemption, since staleness is its own defect", () => {
    const findings = rules({
      changedPaths: ["docs/feature.md"],
      staleDocuments: ["docs/feature.md"],
    });

    expect(ruleNames(findings)).toEqual(["stale-document"]);
  });

  it("ignores an excluded path when deciding whether behavior changed (FR-053)", () => {
    const findings = rules({
      changedPaths: ["package-lock.json"],
      excludedPaths: ["package-lock.json"],
    });

    expect(findings).toEqual([]);
  });
});
