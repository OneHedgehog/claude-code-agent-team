import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateSettings, type LoadedSettings } from "../../src/config/settings.js";

import {
  bothApprove,
  createFixtureClient,
  fixtureEnvironment,
  isolatedStateDirectory,
  requireFixtureEnvironment,
  runDaemonUntil,
  saturateHostSlots,
  fixtureCheckout,
  type FixtureClient,
} from "./harness/index.js";

/**
 * Quickstart scenarios 24 and 25 (tasks.md T091): the host concurrency cap, and the wait it
 * produces (FR-041, SC-017).
 *
 * **Amended 2026-08-20 (R-017, R-019.)** FR-041 was written against a GitHub Actions runner, where
 * the wait was readable off a workflow run's `created_at`. There is no workflow run. The service is
 * a reconciling daemon, reviewer jobs take an ordinary slot in the host-wide cap like every other
 * agent on the machine, and the wait now runs from the tick that selected the review to the review
 * actually starting — which means holding both a worker and a host lease.
 *
 * That amendment is what makes these two scenarios daemon tests rather than review tests. A single
 * `runReview` cannot exhibit either: it takes a lease or it does not, and a wait that never spans a
 * tick is not a wait at all.
 *
 * The two halves are the same mechanism read at two thresholds, and the difference between them is
 * the whole of SC-017:
 *
 *   - **Under the maximum** the gate is *unreported* — not success, not failure, not neutral. The
 *     pull request stays un-mergeable because branch protection requires a check that has not
 *     reported, which is the correct way for a busy machine to look. Reporting anything here would
 *     turn ordinary scheduling delay into a review result.
 *   - **Over it** the silence has gone on too long to be scheduling. A queue nobody is told about
 *     is indistinguishable from a service that has stopped, which Principle VII prohibits, so the
 *     gate fails, a human is notified, and it escalates.
 *
 * The host is filled with **real leases** in the run's own slots directory, so the review genuinely
 * cannot start. Nothing here simulates contention, and nothing takes a slot from the developer's
 * actual agent jobs.
 */

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The fixture's settings with one value replaced, validated by the real loader. */
function withMaxQueueWait(text: string, seconds: number): LoadedSettings {
  const parsed = JSON.parse(text) as { reviewService: Record<string, unknown> };

  return validateSettings({
    ...parsed,
    reviewService: { ...parsed.reviewService, maxQueueWaitSeconds: seconds },
  });
}

describe("host concurrency and queue waits", () => {
  let client: FixtureClient;
  let settingsText: string;
  let checkoutPath: string;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
    settingsText = await client.readBaseFile(".agents/settings.json");
    checkoutPath = await fixtureCheckout(client);
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("leaves the gate unreported while it waits, then reviews (scenario 24)", async () => {
    const [source, tests, document] = await Promise.all([
      client.readBaseFile("src/greeting.js"),
      client.readBaseFile("tests/greeting.test.js"),
      client.readBaseFile("docs/greeting.md"),
    ]);

    // A test and a document ship with the change, so the review that eventually runs concludes
    // `success`. This scenario is about *when* the review runs, and a structural finding firing on
    // every round would make the conclusion say something about the diff instead.
    const pullRequest = await client.openPullRequest({
      label: "scenario-24-queued",
      title: "A change that has to wait for a host slot",
      body: "Staged for scenario 24.",
      files: [
        { path: "src/greeting.js", content: `${source}\nexport const QUEUED = true;\n` },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("the flag is exported", () => {\n  assert.equal(QUEUED, true);\n});\n`,
        },
        { path: "docs/greeting.md", content: `${document}\nThe module exports a flag.\n` },
      ],
    });

    const stateDirectory = isolatedStateDirectory();
    const capacity = validateSettings(JSON.parse(settingsText)).host.maxConcurrentAgents;
    const saturated = saturateHostSlots(stateDirectory, capacity);

    try {
      const waiting = await runDaemonUntil({
        client,
        script: bothApprove(),
        checkoutPath,
        stateDirectory,
        ticks: 1,
      });

      // The review was selected and could not start. Not an error, and not a review that failed.
      const started = waiting.records.filter(
        (record) => (record as { event: string }).event === "queue.wait_started",
      ) as { pullRequest: number }[];
      expect(started.map((record) => record.pullRequest)).toContain(pullRequest.number);

      // Nothing was reviewed: no model call, and no verdict.
      expect(waiting.model.received).toHaveLength(0);
      expect(
        waiting.records.filter((record) => (record as { event: string }).event === "role.verdict"),
      ).toHaveLength(0);

      // And the gate says nothing at all — which is what holds the merge (FR-041).
      await client.expectGateUnreported(pullRequest.headSha);
      expect(await client.readEscalationCauses(pullRequest.number)).not.toContain(
        "queue.wait_exceeded",
      );
    } finally {
      saturated.release();
    }

    // A slot frees, and the next tick reviews it. The wait ended below the maximum, so it ends in
    // a review rather than in an escalation.
    const ran = await runDaemonUntil({
      client,
      script: bothApprove(),
      checkoutPath,
      stateDirectory,
      ticks: 1,
    });

    expect(ran.model.requestsFor("security")).toHaveLength(1);
    expect(ran.model.requestsFor("implementation")).toHaveLength(1);

    const concluded = await client.awaitGateConclusion(pullRequest.headSha);
    expect(concluded.conclusion).toBe("success");

    await client.closePullRequest(pullRequest.number);
  });

  it("fails the gate and escalates when the wait exceeds the maximum (scenario 25)", async () => {
    const source = await client.readBaseFile("src/greeting.js");

    const pullRequest = await client.openPullRequest({
      label: "scenario-25-queue-timeout",
      title: "A change that waits too long for a host slot",
      body: "Staged for scenario 25.",
      files: [{ path: "src/greeting.js", content: `${source}\nexport const TIMED_OUT = true;\n` }],
    });

    const stateDirectory = isolatedStateDirectory();
    const capacity = validateSettings(JSON.parse(settingsText)).host.maxConcurrentAgents;
    const saturated = saturateHostSlots(stateDirectory, capacity);

    // One second, so a wait that spans two ticks of a real daemon against a real API exceeds it.
    // The threshold is the setting, not the clock: a production maximum of half an hour and this
    // one differ in magnitude and in nothing else.
    let released = false;

    try {
      const timedOut = await runDaemonUntil({
        client,
        script: bothApprove(),
        checkoutPath,
        stateDirectory,
        settings: withMaxQueueWait(settingsText, 1),
        // Three, for two tick bodies: `runDaemon` consults `running()` twice per iteration — once
        // to enter the loop and once before sleeping — so the budget is not a count of ticks.
        ticks: 3,
        // Between the two ticks: long enough that the accumulated wait passes the maximum, and
        // then the host frees up. The review therefore *starts*, which is the case SC-017 is
        // scoped to — a review that never starts leaves the gate unreported instead.
        sleep: async () => {
          await delay(2_500);

          if (!released) {
            saturated.release();
            released = true;
          }
        },
      });

      const exceeded = timedOut.records.filter(
        (record) => (record as { event: string }).event === "queue.wait_exceeded",
      ) as { pullRequest: number }[];
      expect(exceeded.map((record) => record.pullRequest)).toContain(pullRequest.number);

      // It failed rather than reviewing late: no role was ever asked.
      expect(timedOut.model.received).toHaveLength(0);

      const concluded = await client.awaitGateConclusion(pullRequest.headSha);
      expect(concluded.conclusion).toBe("failure");

      // A human is told, on both surfaces (FR-035).
      const escalation = await client.awaitEscalation(pullRequest.number, "queue.wait_exceeded");
      expect(escalation.statedOnPullRequest).toBe(true);
      expect(escalation.issue.labels).toContain("escalation");
    } finally {
      if (!released) saturated.release();
    }
  });
});
