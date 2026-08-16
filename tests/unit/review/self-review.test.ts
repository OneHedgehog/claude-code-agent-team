import { describe, expect, it } from "vitest";

import { isSelfAuthored, checkSelfReview } from "../../../src/review/self-review.js";

/**
 * FR-004: the reviewing identity never reviews its own work. The comparison has to survive the
 * shapes GitHub actually returns — a bot author carries the `[bot]` suffix on the pull request
 * while the App's own slug does not — so both the positive and the negative case are asserted.
 */

describe("isSelfAuthored (FR-004)", () => {
  it("recognizes the reviewing identity as the author", () => {
    expect(isSelfAuthored("independent-review[bot]", "independent-review")).toBe(true);
  });

  it("recognizes it when GitHub reports the slug without the bot suffix", () => {
    expect(isSelfAuthored("independent-review", "independent-review")).toBe(true);
  });

  it("recognizes it when the App slug itself carries the suffix", () => {
    expect(isSelfAuthored("independent-review[bot]", "independent-review[bot]")).toBe(true);
  });

  it("ignores case, since GitHub logins are case-insensitive", () => {
    expect(isSelfAuthored("Independent-Review[bot]", "independent-review")).toBe(true);
  });

  it("does not trip on another author", () => {
    expect(isSelfAuthored("a-human", "independent-review")).toBe(false);
  });

  it("does not trip on a different bot", () => {
    expect(isSelfAuthored("dependabot[bot]", "independent-review")).toBe(false);
  });

  it("does not trip on an author whose name merely contains the slug", () => {
    // A substring match here would refuse to review a real contributor's pull request.
    expect(isSelfAuthored("not-independent-review-either", "independent-review")).toBe(false);
  });

  it("treats an unknown author as not self-authored", () => {
    // An absent author is a different failure, handled where the pull request is read. Guessing
    // "self" here would refuse every pull request GitHub reported oddly.
    expect(isSelfAuthored(null, "independent-review")).toBe(false);
  });
});

describe("checkSelfReview (FR-004)", () => {
  it("refuses, states the reason, and escalates when self-authored", () => {
    const result = checkSelfReview("independent-review[bot]", "independent-review");

    expect(result.selfAuthored).toBe(true);
    expect(result.escalate).toBe(true);
    expect(result.reason).toContain("independent-review");
  });

  it("records no approving verdict when self-authored", () => {
    const result = checkSelfReview("independent-review[bot]", "independent-review");

    // FR-004 is about independence, so the refusal must not leave anything an aggregator could
    // read as approval.
    expect(result.verdicts).toHaveLength(0);
  });

  it("proceeds without escalation for another author", () => {
    const result = checkSelfReview("a-human", "independent-review");

    expect(result.selfAuthored).toBe(false);
    expect(result.escalate).toBe(false);
    expect(result.reason).toBeNull();
  });
});
