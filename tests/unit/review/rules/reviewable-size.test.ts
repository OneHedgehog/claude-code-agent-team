import { describe, expect, it } from "vitest";

import { checkReviewableSize } from "../../../../src/review/rules/reviewable-size.js";

/**
 * FR-037: past `maxReviewableDiffSize` no review is attempted at all. The point of the gate is
 * that it costs nothing — it sits before the model call, so an oversized pull request is refused
 * without spending a token on it.
 */

describe("checkReviewableSize (FR-037)", () => {
  it("permits a diff at the limit", () => {
    const result = checkReviewableSize({ changedLines: 2000, maxReviewableDiffSize: 2000 });

    expect(result.exceeds).toBe(false);
  });

  it("refuses a diff over the limit", () => {
    const result = checkReviewableSize({ changedLines: 2001, maxReviewableDiffSize: 2000 });

    expect(result.exceeds).toBe(true);
  });

  it("spends zero tokens when it refuses", () => {
    const result = checkReviewableSize({ changedLines: 5000, maxReviewableDiffSize: 2000 });

    expect(result.tokensSpent).toBe(0);
  });

  it("records no verdict when it refuses", () => {
    const result = checkReviewableSize({ changedLines: 5000, maxReviewableDiffSize: 2000 });

    expect(result.verdicts).toHaveLength(0);
  });

  it("states a split-the-pull-request reason naming both numbers", () => {
    const result = checkReviewableSize({ changedLines: 5000, maxReviewableDiffSize: 2000 });

    expect(result.reason).toContain("5000");
    expect(result.reason).toContain("2000");
    expect(result.reason).toContain("split");
  });

  it("states no reason when the diff is reviewable", () => {
    const result = checkReviewableSize({ changedLines: 10, maxReviewableDiffSize: 2000 });

    expect(result.reason).toBeNull();
  });

  it("measures the count it is given, which excludes the excluded set", () => {
    // The counter in rules/size.ts measures over `excluded-paths.ts`, and FR-053 exists so both
    // caps read the same number. Passing an already-reduced count is what keeps them from drifting.
    const result = checkReviewableSize({ changedLines: 1999, maxReviewableDiffSize: 2000 });

    expect(result.exceeds).toBe(false);
  });
});
