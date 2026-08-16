import { describe, expect, it } from "vitest";

import { checkEmptyDiff } from "../../../../src/review/rules/empty-diff.js";

/**
 * FR-052: a pull request with nothing to review is refused outright. Neither an approval nor a
 * skip — an approval would make a degenerate pull request look ordinary, and a skip is the
 * non-failing gate Principle IV prohibits.
 */

const WHITESPACE_ONLY = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 2;${" "}
 const c = 3;
`;

const REAL_CHANGE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;
`;

describe("checkEmptyDiff (FR-052)", () => {
  it("refuses a completely empty diff", () => {
    const result = checkEmptyDiff("");

    expect(result.empty).toBe(true);
  });

  it("refuses a diff of only whitespace", () => {
    const result = checkEmptyDiff("   \n\n\t\n");

    expect(result.empty).toBe(true);
  });

  it("refuses a diff whose only change is whitespace on a line", () => {
    const result = checkEmptyDiff(WHITESPACE_ONLY);

    expect(result.empty).toBe(true);
  });

  it("refuses a diff with headers but no changed lines", () => {
    const headersOnly = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
 const a = 1;
`;

    expect(checkEmptyDiff(headersOnly).empty).toBe(true);
  });

  it("does not refuse a diff carrying a real change", () => {
    const result = checkEmptyDiff(REAL_CHANGE);

    expect(result.empty).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("does not mistake the +++ and --- file headers for changed lines", () => {
    // Both start with the same characters as an added or removed line. Counting them would make
    // every empty diff look like it had two changes.
    const result = checkEmptyDiff(WHITESPACE_ONLY);

    expect(result.empty).toBe(true);
  });

  it("states that there is nothing to review", () => {
    const result = checkEmptyDiff("");

    expect(result.reason).toContain("nothing to review");
  });

  it("records no verdict for either role", () => {
    const result = checkEmptyDiff("");

    // FR-052 is explicit: no verdict for either role. A verdict policy for a degenerate pull
    // request would make it a normal case.
    expect(result.verdicts).toHaveLength(0);
  });

  it("spends zero tokens", () => {
    const result = checkEmptyDiff("");

    expect(result.tokensSpent).toBe(0);
  });
});
