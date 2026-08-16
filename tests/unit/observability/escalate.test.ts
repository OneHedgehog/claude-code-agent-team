import { describe, expect, it } from "vitest";

import {
  escalate,
  type EscalationSurfaces,
  type EscalationIssue,
} from "../../../src/observability/escalate.js";
import type { TargetRepository } from "../../../src/config/target.js";

/**
 * FR-035 and research.md R-012. Two obligations that look like one and are not: every escalation
 * notifies through the configured channel *and* states its reason on the pull request, and neither
 * is ever substituted for the other. A pull request comment nobody is watching is not a
 * notification; an issue filed without a word on the pull request leaves the author guessing.
 */

const TARGET: TargetRepository = {
  owner: "acme",
  name: "widgets",
  checkoutPath: "/tmp/checkout",
};

const CHANNEL = { type: "github-issue" as const, assignee: "a-human", label: "escalation" };

function surfaces(): EscalationSurfaces & {
  readonly issuesCreated: unknown[];
  readonly issuesUpdated: unknown[];
  readonly comments: unknown[];
} {
  const issuesCreated: unknown[] = [];
  const issuesUpdated: unknown[] = [];
  const comments: unknown[] = [];
  let existing: EscalationIssue | null = null;

  return {
    issuesCreated,
    issuesUpdated,
    comments,
    findEscalationIssue() {
      return Promise.resolve(existing);
    },
    createIssue(params) {
      issuesCreated.push(params);
      existing = { number: 42, body: params.body };
      return Promise.resolve({ number: 42 });
    },
    updateIssue(params) {
      issuesUpdated.push(params);
      return Promise.resolve();
    },
    commentOnPullRequest(params) {
      comments.push(params);
      return Promise.resolve();
    },
  };
}

const INPUT = {
  target: TARGET,
  pullRequest: 7,
  runId: "run-1",
  channel: CHANNEL,
  reason: "the token budget is exhausted",
  cause: "budget.exhausted" as const,
};

describe("escalate — both surfaces, always (FR-035)", () => {
  it("notifies through the channel and states the reason on the pull request", async () => {
    const api = surfaces();

    const result = await escalate(api, INPUT);

    expect(result.channelDelivered).toBe(true);
    expect(result.statedOnPullRequest).toBe(true);
    expect(api.issuesCreated).toHaveLength(1);
    expect(api.comments).toHaveLength(1);
  });

  it("carries the reason onto both surfaces", async () => {
    const api = surfaces();

    await escalate(api, INPUT);

    expect(JSON.stringify(api.issuesCreated[0])).toContain("the token budget is exhausted");
    expect(JSON.stringify(api.comments[0])).toContain("the token budget is exhausted");
  });

  it("assigns and labels the issue as configured", async () => {
    const api = surfaces();

    await escalate(api, INPUT);

    expect(api.issuesCreated[0]).toMatchObject({ assignee: "a-human", labels: ["escalation"] });
  });

  it("still states the reason on the pull request when the channel fails", async () => {
    const api = surfaces();
    const failing: EscalationSurfaces = {
      ...api,
      createIssue() {
        return Promise.reject(new Error("issues are disabled on this repository"));
      },
    };

    const result = await escalate(failing, INPUT);

    // A failed channel must not swallow the pull request statement — that is exactly the
    // substitution FR-035 forbids, in the direction that leaves the author with nothing.
    expect(result.channelDelivered).toBe(false);
    expect(result.statedOnPullRequest).toBe(true);
    expect(api.comments).toHaveLength(1);
  });

  it("reports failure to deliver rather than reporting success", async () => {
    const api = surfaces();
    const failing: EscalationSurfaces = {
      ...api,
      createIssue() {
        return Promise.reject(new Error("issues are disabled"));
      },
      commentOnPullRequest() {
        return Promise.reject(new Error("pull request is locked"));
      },
    };

    const result = await escalate(failing, INPUT);

    expect(result.channelDelivered).toBe(false);
    expect(result.statedOnPullRequest).toBe(false);
    expect(result.delivered).toBe(false);
  });
});

describe("escalate — recurrence (R-012)", () => {
  it("updates the existing issue rather than opening a second one", async () => {
    const api = surfaces();

    await escalate(api, INPUT);
    await escalate(api, INPUT);

    expect(api.issuesCreated).toHaveLength(1);
    expect(api.issuesUpdated).toHaveLength(1);
  });

  it("states the reason on the pull request on the recurrence too", async () => {
    const api = surfaces();

    await escalate(api, INPUT);
    await escalate(api, INPUT);

    // The issue is deduplicated; the statement is not. Silence on the second failure would read
    // as the problem having gone away.
    expect(api.comments).toHaveLength(2);
  });
});
