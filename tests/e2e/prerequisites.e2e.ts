import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REQUIRED_INSTALLATION_PERMISSIONS } from "../../src/github/auth.js";

import {
  bothApprove,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  runReview,
  ungatedPullRequest,
  type FixtureClient,
} from "./harness/index.js";

/**
 * Quickstart scenario 26 (tasks.md T084): the two prerequisites, each verified before anything is
 * spent (FR-051, SC-024).
 *
 * FR-051 exists because the failure it prevents is the quietest one in the system. A merge gate
 * that branch protection does not require still *runs*: the service reads the diff, calls the
 * model, posts findings, and reports a failing check run — and the pull request merges anyway,
 * because nothing required the check. Every surface looks healthy. The same is true of a missing
 * installation permission, which surfaces as an unrelated `403` several hundred lines into a run
 * that has already spent its tokens.
 *
 * So the assertion that carries the requirement is not "it failed" but **"it failed having spent
 * nothing"**: zero model requests, zero tokens, no verdict from either role. A service that
 * reached the same conclusion after reviewing would satisfy the words and none of the point.
 *
 * The two halves are produced rather than simulated, which is what keeps this an end-to-end test:
 *
 *   - the gate half opens against `unprotected-base`, a standing fixture branch whose protection
 *     deliberately omits the check, so the `404` the service classifies is GitHub's own;
 *   - the permission half authenticates with an installation token GitHub itself narrowed, so
 *     `administration: read` is genuinely absent from the token the run holds rather than absent
 *     from a map a stub returned.
 *
 * Neither half writes a check run, and that is deliberate rather than an omission: nothing got as
 * far as opening the gate, so there is no in-progress run to conclude. The visible artefact is the
 * escalation, on both surfaces FR-035 requires.
 */

/** Every permission the service requires except the one whose absence this scenario produces. */
const WITHOUT_ADMINISTRATION = Object.fromEntries(
  Object.entries(REQUIRED_INSTALLATION_PERMISSIONS).filter(([name]) => name !== "administration"),
) as Record<string, "read" | "write">;

describe("startup prerequisites", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("stops before spending when the gate is not required on the base branch (scenario 26)", async () => {
    const source = await client.readBaseFile(
      "src/greeting.js",
      client.environment.ungatedBaseBranch,
    );

    const pullRequest = await ungatedPullRequest(client, {
      title: "A change against a base branch that does not require the gate",
      body: "Staged for scenario 26, first half.",
      files: [{ path: "src/greeting.js", content: `${source}\nexport const UNGATED = true;\n` }],
    });

    expect(pullRequest.baseBranch).toBe(client.environment.ungatedBaseBranch);

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    // The whole of FR-051: the stop is ahead of the model call, not after it.
    expect(run.outcome.stoppedBeforeSpending).toBe(true);
    expect(run.outcome.tokensConsumed).toBe(0);
    expect(run.model.received).toHaveLength(0);
    expect(run.adapters.ledger.total("tokens")).toBe(0);

    expect(run.outcome.gate.conclusion).toBe("failure");

    // No verdict was recorded for either role — not an approving one, and not a missing one
    // either, because neither role was ever asked.
    expect(
      run.records.filter((record) =>
        ["role.verdict", "role.verdict_missing"].includes((record as { event: string }).event),
      ),
    ).toHaveLength(0);
    expect(await client.readReviewStates(pullRequest.number)).toHaveLength(0);

    // No check run at all. Nothing reached `reviewing`, so no gate was opened to conclude.
    expect(await client.listGateRuns(pullRequest.headSha)).toHaveLength(0);

    // Which leaves the escalation as the one place a human hears about it — on both surfaces.
    const escalation = await client.awaitEscalation(pullRequest.number, "prerequisites.missing");
    expect(escalation.statedOnPullRequest).toBe(true);
    expect(escalation.issue.labels).toContain("escalation");

    expect(
      run.records.filter(
        (record) => (record as { event: string }).event === "prerequisites.missing",
      ),
    ).toHaveLength(1);
  });

  it("stops before spending when the installation lacks a permission it needs (scenario 26)", async () => {
    const source = await client.readBaseFile("src/greeting.js");

    const pullRequest = await client.openPullRequest({
      label: "scenario-26-permission",
      title: "A change reviewed by an under-permissioned installation",
      body: "Staged for scenario 26, second half.",
      files: [{ path: "src/greeting.js", content: `${source}\nexport const NARROWED = true;\n` }],
    });

    // GitHub narrows the token; nothing here pretends to. The base branch *does* require the gate,
    // so the only prerequisite this run can fail is the permission one.
    const narrowed = await client.environment.restrictedInstallationToken(WITHOUT_ADMINISTRATION);
    expect(narrowed.permissions["administration"]).toBeUndefined();
    expect(narrowed.permissions["checks"]).toBe("write");

    const run = await runReview({
      client,
      pullRequest,
      script: bothApprove(),
      installationToken: () => Promise.resolve(narrowed),
    });

    expect(run.outcome.stoppedBeforeSpending).toBe(true);
    expect(run.outcome.tokensConsumed).toBe(0);
    expect(run.model.received).toHaveLength(0);

    expect(run.outcome.gate.conclusion).toBe("failure");
    expect(await client.listGateRuns(pullRequest.headSha)).toHaveLength(0);
    expect(await client.readReviewStates(pullRequest.number)).toHaveLength(0);

    const escalation = await client.awaitEscalation(pullRequest.number, "prerequisites.missing");
    expect(escalation.statedOnPullRequest).toBe(true);
  });
});
