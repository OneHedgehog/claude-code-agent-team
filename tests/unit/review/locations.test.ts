import { describe, expect, it } from "vitest";

import {
  changedLineCount,
  changedPaths,
  indexDiff,
  isAddressable,
  resolveLocation,
} from "../../../src/review/locations.js";
import { isPullRequestLevel } from "../../../src/model/client.js";

const DIFF = `diff --git a/src/cli.ts b/src/cli.ts
index 1111111..2222222 100644
--- a/src/cli.ts
+++ b/src/cli.ts
@@ -10,6 +10,8 @@ export function main() {
   const a = 1;
   const b = 2;
+  const apiKey = "sk-live-abcdef";
+  const c = 3;
   return a + b;
 }
diff --git a/docs/readme.md b/docs/readme.md
index 3333333..4444444 100644
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1,3 +1,3 @@
 # Title
-old line
+new line
 tail
`;

describe("indexing a unified diff (FR-010)", () => {
  it("finds every changed file", () => {
    expect(changedPaths(indexDiff(DIFF)).sort()).toEqual(["docs/readme.md", "src/cli.ts"]);
  });

  it("addresses an added line on the right side", () => {
    const index = indexDiff(DIFF);

    expect(isAddressable(index, "src/cli.ts", 12, "RIGHT")).toBe(true);
    expect(isAddressable(index, "src/cli.ts", 13, "RIGHT")).toBe(true);
  });

  it("addresses a removed line on the left side", () => {
    expect(isAddressable(indexDiff(DIFF), "docs/readme.md", 2, "LEFT")).toBe(true);
  });

  it("does not address a line the diff never touched", () => {
    expect(isAddressable(indexDiff(DIFF), "src/cli.ts", 500, "RIGHT")).toBe(false);
  });

  it("does not address a file the diff never touched", () => {
    expect(isAddressable(indexDiff(DIFF), "src/untouched.ts", 1, "RIGHT")).toBe(false);
  });

  it("treats an empty diff as addressing nothing", () => {
    expect(changedPaths(indexDiff(""))).toEqual([]);
  });
});

describe("resolving a finding's location (FR-010, FR-014)", () => {
  const index = indexDiff(DIFF);

  it("keeps a location that is addressable inside the diff", () => {
    const resolved = resolveLocation(index, { path: "src/cli.ts", line: 12, side: "RIGHT" }, []);

    expect(resolved).toEqual({ path: "src/cli.ts", line: 12, side: "RIGHT" });
  });

  it("records a location outside the diff at pull-request level rather than dropping it", () => {
    const resolved = resolveLocation(index, { path: "src/cli.ts", line: 500, side: "RIGHT" }, []);

    expect(isPullRequestLevel(resolved)).toBe(true);
  });

  it("records a finding on an untouched file at pull-request level", () => {
    const resolved = resolveLocation(index, { path: "elsewhere.ts", line: 1, side: "RIGHT" }, []);

    expect(isPullRequestLevel(resolved)).toBe(true);
  });

  it("never drops a finding: every input resolves to some location", () => {
    for (const line of [1, 12, 500]) {
      expect(resolveLocation(index, { path: "src/cli.ts", line, side: "RIGHT" }, [])).toBeTruthy();
    }
  });

  it("leaves a pull-request-level finding where it is", () => {
    expect(resolveLocation(index, { pullRequestLevel: true }, [])).toEqual({
      pullRequestLevel: true,
    });
  });

  it("moves a finding on an excluded path to pull-request level rather than anchoring it (FR-053)", () => {
    const resolved = resolveLocation(index, { path: "src/cli.ts", line: 12, side: "RIGHT" }, [
      "src/cli.ts",
    ]);

    expect(isPullRequestLevel(resolved)).toBe(true);
  });
});

describe("counting changed lines (FR-037, FR-043, FR-053)", () => {
  it("counts additions and removals across every file", () => {
    // src/cli.ts: 2 added. docs/readme.md: 1 added, 1 removed.
    expect(changedLineCount(indexDiff(DIFF), [])).toBe(4);
  });

  it("removes excluded paths from the count, so an exclusion cannot inflate a pull request", () => {
    expect(changedLineCount(indexDiff(DIFF), ["docs/readme.md"])).toBe(2);
  });

  it("counts nothing for an empty diff", () => {
    expect(changedLineCount(indexDiff(""), [])).toBe(0);
  });

  it("counts nothing when every changed path is excluded", () => {
    expect(changedLineCount(indexDiff(DIFF), ["src/cli.ts", "docs/readme.md"])).toBe(0);
  });

  it("does not count context lines", () => {
    const contextOnly = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 unchanged
 unchanged
 unchanged
`;

    expect(changedLineCount(indexDiff(contextOnly), [])).toBe(0);
  });

  it("does not count the file headers themselves as changed lines", () => {
    const oneLine = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,0 +1,1 @@
+added
`;

    expect(changedLineCount(indexDiff(oneLine), [])).toBe(1);
  });
});
