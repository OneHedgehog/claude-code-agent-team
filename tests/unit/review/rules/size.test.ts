import { describe, expect, it } from "vitest";

import { indexDiff } from "../../../../src/review/locations.js";
import { checkPullRequestSize, hasSizeJustification } from "../../../../src/review/rules/size.js";

/** Ten added lines in `src/a.ts` and four in `package-lock.json`. */
const DIFF = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,0 +1,10 @@",
  ...Array.from({ length: 10 }, (_, i) => `+const v${i} = ${i};`),
  "--- a/package-lock.json",
  "+++ b/package-lock.json",
  "@@ -1,0 +1,4 @@",
  ...Array.from({ length: 4 }, (_, i) => `+  "line${i}": 1,`),
  "",
].join("\n");

function check(input: { max: number; excluded?: readonly string[]; body?: string }) {
  return checkPullRequestSize({
    index: indexDiff(DIFF),
    excludedPaths: input.excluded ?? [],
    maxPullRequestSize: input.max,
    pullRequestBody: input.body ?? "",
  });
}

describe("the changed-line count is measured over the excluded set (FR-053)", () => {
  it("counts every changed line when nothing is excluded", () => {
    expect(check({ max: 100 }).changedLines).toBe(14);
  });

  it("removes excluded paths from the count", () => {
    expect(check({ max: 100, excluded: ["package-lock.json"] }).changedLines).toBe(10);
  });

  it("uses one counter, so the cap cannot drift from what the reviewer measured", () => {
    const withExclusion = check({ max: 100, excluded: ["package-lock.json"] });

    expect(withExclusion.changedLines).toBe(check({ max: 100 }).changedLines - 4);
  });
});

describe("the maxPullRequestSize cap (FR-043, Principle X)", () => {
  it("reports nothing when the diff is within the cap", () => {
    expect(check({ max: 100 }).findings).toEqual([]);
  });

  it("reports nothing exactly at the cap", () => {
    expect(check({ max: 14 }).findings).toEqual([]);
  });

  it("blocks one line over the cap", () => {
    const findings = check({ max: 13 }).findings;

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("pull-request-size");
    expect(findings[0]?.blocking).toBe(true);
  });

  it("states both figures so the author can see how far over it is", () => {
    const description = check({ max: 10 }).findings[0]?.description ?? "";

    expect(description).toContain("14");
    expect(description).toContain("10");
  });

  it("passes once an exclusion brings it under the cap", () => {
    expect(check({ max: 12, excluded: ["package-lock.json"] }).findings).toEqual([]);
  });
});

describe("the justification escape (FR-043)", () => {
  const JUSTIFIED = [
    "This pull request establishes the repository baseline.",
    "",
    "## Size justification",
    "",
    "The toolchain and the reviewer cannot ship separately: a reviewer cannot be built without a",
    "toolchain, and a toolchain alone is not independently shippable under Principle I.",
  ].join("\n");

  it("recognizes a stated justification", () => {
    expect(hasSizeJustification(JUSTIFIED)).toBe(true);
  });

  it("clears the size finding when the description states one", () => {
    expect(check({ max: 10, body: JUSTIFIED }).findings).toEqual([]);
  });

  it("clears that finding and only that finding", () => {
    // The escape is scoped to size. Nothing else in the pull request becomes acceptable because
    // the author explained why the diff is large.
    const result = check({ max: 10, body: JUSTIFIED });

    expect(result.findings).toEqual([]);
    expect(result.changedLines).toBe(14);
    expect(result.justified).toBe(true);
  });

  it.each([
    ["an empty description", ""],
    ["a description with no such section", "Implements the spec."],
    ["a heading with nothing under it", "## Size justification\n"],
    ["a heading followed only by whitespace", "## Size justification\n   \n\n"],
    ["the phrase used in passing rather than as a section", "I have no size justification here."],
  ])("does not accept %s", (_label, body) => {
    expect(hasSizeJustification(body)).toBe(false);
  });

  it("still blocks an oversized pull request whose description explains nothing", () => {
    expect(check({ max: 10, body: "Implements the spec." }).findings).toHaveLength(1);
  });
});
