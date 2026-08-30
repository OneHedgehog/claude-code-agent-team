import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateSettings, type LoadedSettings } from "../../src/config/settings.js";

import {
  bothApprove,
  createFixtureClient,
  fixtureEnvironment,
  ledgerExhausted,
  requireFixtureEnvironment,
  runReview,
  type FixtureClient,
  type FixturePullRequest,
} from "./harness/index.js";

/**
 * Quickstart scenario 21 (tasks.md T121): every escalation reaches **both** surfaces (FR-035,
 * SC-011, SC-021).
 *
 * FR-035 reads like one obligation and is two, joined by an "and" that is the entire requirement:
 * notify through the configured channel, *and* state the reason on the pull request. Either alone
 * fails a different person. An issue filed with nothing on the pull request leaves the author
 * staring at a failing check with no explanation; a pull request comment nobody is watching is not
 * a notification, and the run has effectively stopped silently — which Principle VII prohibits
 * outright, because a system that stops without saying so is indistinguishable from one still
 * working.
 *
 * So the assertion here is deliberately the *conjunction*, checked per escalation and then checked
 * again as a set: the causes present on the issues surface and the causes present on the pull
 * request surface must be the same set, in both directions. A test that asserted only "an issue
 * exists" would pass on a service that had quietly stopped writing comments.
 *
 * Two causes are driven rather than all fourteen, and they are chosen to be structurally different
 * — one refuses the pull request outright, one runs out of budget — so the conjunction is
 * established at two independent exits rather than twice at one. That every *other* cause takes
 * the same `notify` path is asserted exhaustively where it is cheap to do so: `CAUSE_EVENT` in the
 * composition root is total over `EscalationCause`, and T083 covers `escalate` itself.
 *
 * The last case is R-012's deduplication, which is the other half of a usable notification: a
 * cause that recurs on the same pull request updates its issue instead of filing a second one. A
 * channel that files one issue per tick is a channel a human mutes.
 */

/** A whitespace-only change, which the service refuses outright — cheap, and spends nothing. */
async function nothingToReview(client: FixtureClient, label: string): Promise<FixturePullRequest> {
  const source = await client.readBaseFile("src/greeting.js");

  return client.openPullRequest({
    label,
    title: "A change with nothing to review",
    body: "Staged for scenario 21.",
    files: [
      {
        path: "src/greeting.js",
        content: source.replace("  if (names.length === 0) {", "    if (names.length === 0) {"),
      },
    ],
  });
}

describe("escalation reaches both surfaces", () => {
  let client: FixtureClient;
  let loaded: LoadedSettings;
  let slug: string;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
    loaded = validateSettings(JSON.parse(await client.readBaseFile(".agents/settings.json")));
    slug = `${client.environment.repository.owner}/${client.environment.repository.name}`;
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("notifies through the channel and states the reason on the pull request (scenario 21)", async () => {
    const pullRequest = await nothingToReview(client, "scenario-21-both-surfaces");

    const run = await runReview({ client, pullRequest, script: bothApprove() });
    expect(run.outcome.gate.conclusion).toBe("failure");

    const escalation = await client.awaitEscalation(pullRequest.number, "diff.empty");

    // The channel: an issue, filed under the configured label and carrying the cause marker.
    expect(escalation.issue.cause).toBe("diff.empty");
    expect(escalation.issue.labels).toContain(loaded.settings.escalationChannel.label);

    // And the pull request, separately. Neither substituted for the other.
    expect(escalation.statedOnPullRequest).toBe(true);

    // Recorded as two fields rather than one, so a half-delivered escalation cannot be reported as
    // a whole one.
    const [notified] = run.records.filter(
      (record) => (record as { event: string }).event === "escalation.notified",
    ) as {
      escalation?: { channelDelivered?: boolean; statedOnPullRequest?: boolean };
    }[];

    expect(notified?.escalation?.channelDelivered).toBe(true);
    expect(notified?.escalation?.statedOnPullRequest).toBe(true);
  });

  it("carries the same causes on both surfaces, in both directions (scenario 21)", async () => {
    const source = await client.readBaseFile("src/greeting.js");

    const pullRequest = await client.openPullRequest({
      label: "scenario-21-budget",
      title: "A change reviewed against an exhausted budget",
      body: "Staged for scenario 21's second exit.",
      files: [{ path: "src/greeting.js", content: `${source}\nexport const ESCALATED = true;\n` }],
    });

    await runReview({
      client,
      pullRequest,
      script: bothApprove(),
      ledger: ledgerExhausted(loaded.settings, slug),
    });

    await client.awaitEscalation(pullRequest.number, "budget.exhausted");

    const onIssues = [...new Set(await client.readEscalationCauses(pullRequest.number))].sort();
    const onPullRequest = [
      ...new Set(await client.readPullRequestEscalationCauses(pullRequest.number)),
    ].sort();

    // Set equality in both directions is what "neither substituted for the other" means when
    // there is more than one escalation in play.
    expect(onIssues).toEqual(onPullRequest);
    expect(onIssues).toContain("budget.exhausted");
  });

  it("updates the existing issue when the same cause recurs (scenario 21)", async () => {
    const pullRequest = await nothingToReview(client, "scenario-21-recurring");

    await runReview({ client, pullRequest, script: bothApprove() });
    const first = await client.awaitEscalation(pullRequest.number, "diff.empty");

    // The daemon would reach this pull request again on the next tick, and the condition has not
    // changed — which is exactly when a channel starts filing duplicates.
    await runReview({ client, pullRequest, script: bothApprove() });
    await client.awaitEscalation(pullRequest.number, "diff.empty");

    const issues = (await client.readEscalations(pullRequest.number)).filter(
      (record) => record.cause === "diff.empty",
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe(first.issue.number);
  });
});
