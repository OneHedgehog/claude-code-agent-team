import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compareWithLocal, reconstructTotal } from "../../src/ledger/reconstruct.js";
import { parseRoundRecord } from "../../src/review/round-history.js";

import {
  bothApprove,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  runReview,
  type FixtureClient,
} from "./harness/index.js";

/**
 * Quickstart scenario 22 (tasks.md T110): a concluded run is legible afterwards without re-running
 * it (FR-033, FR-034, SC-008).
 *
 * Two claims, and the second is the one with teeth. The first is that the run reports what it
 * spent — tokens consumed and budget remaining, on the run itself.
 *
 * The second is that the run is reconstructible **from its records and the pull request alone**.
 * Principle VII calls the local ledger a cache, and a cache has to be losable: the machine is a
 * developer laptop, and a rebuilt host, a cleared state directory, or a fresh clone must not hand
 * the next run the whole budget again. So the authoritative copy of every run's spend is written
 * into its own check-run output, on GitHub, and `reconstruct.ts` rebuilds the total from there.
 *
 * This test therefore does the reconstruction rather than asserting that it could be done: it
 * throws away nothing and reads the figure back off the platform, then checks that the two sources
 * agree. A disagreement is the one thing that must never be silently corrected — a ledger that
 * quietly repairs itself is a ledger nobody can audit.
 */

/** The record events a concluded run must leave behind for it to be reconstructible at all. */
const REQUIRED_EVENTS = ["run.started", "role.verdict", "gate.reported", "run.concluded"] as const;

describe("accountability", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("reports its spend and reconstructs from the pull request alone (scenario 22)", async () => {
    const [source, tests, document] = await Promise.all([
      client.readBaseFile("src/greeting.js"),
      client.readBaseFile("tests/greeting.test.js"),
      client.readBaseFile("docs/greeting.md"),
    ]);

    const pullRequest = await client.openPullRequest({
      label: "scenario-22-accountability",
      title: "A change whose review has to be legible afterwards",
      body: "Staged for scenario 22.",
      files: [
        { path: "src/greeting.js", content: `${source}\nexport const ACCOUNTED = true;\n` },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("the flag is exported", () => {\n  assert.equal(ACCOUNTED, true);\n});\n`,
        },
        { path: "docs/greeting.md", content: `${document}\nThe module exports a flag.\n` },
      ],
    });

    const run = await runReview({ client, pullRequest, script: bothApprove() });

    expect(run.outcome.gate.conclusion).toBe("success");
    expect(run.outcome.tokensConsumed).toBeGreaterThan(0);

    // Every record carries the run identifier, so a stream can be attributed to one run even when
    // several ran against the same repository (FR-033).
    expect(run.records.length).toBeGreaterThan(0);
    for (const record of run.records) {
      expect((record as { runId: string }).runId).toBe(run.runId);
    }

    const events = new Set(run.records.map((record) => (record as { event: string }).event));
    for (const required of REQUIRED_EVENTS) {
      expect(events.has(required)).toBe(true);
    }

    // ---- Reconstruction, from GitHub only. ----

    const concluded = await client.awaitGateConclusion(pullRequest.headSha);
    const record = parseRoundRecord(concluded.output.text);

    expect(record).not.toBeNull();
    expect(record?.concluded).toBe(true);
    expect(record?.headSha).toBe(pullRequest.headSha);

    // What the run spent, and what is left, both reported with the run rather than inferred.
    expect(record?.tokensConsumed).toBe(run.outcome.tokensConsumed);
    expect(record?.budgetRemaining).toBe(run.adapters.ledger.remaining("tokens"));

    // The figure the local ledger holds, rebuilt from the platform without consulting it.
    const remoteTotal = reconstructTotal([
      { runId: run.runId, tokensConsumed: record?.tokensConsumed ?? -1 },
    ]);

    expect(remoteTotal).toBe(run.outcome.tokensConsumed);

    const comparison = compareWithLocal({
      localTotal: run.adapters.ledger.total("tokens"),
      remoteTotal,
    });

    // They agree, so nothing is escalated — and had they not, the escalation would be the answer
    // rather than a silent repair.
    expect(comparison.agrees).toBe(true);
    expect(comparison.authoritativeTotal).toBe(remoteTotal);
    expect(comparison.escalation).toBeUndefined();

    // A run whose ledger was lost entirely still reconstructs, which is the property that makes
    // the local file a cache rather than the record.
    expect(compareWithLocal({ localTotal: undefined, remoteTotal }).authoritativeTotal).toBe(
      remoteTotal,
    );

    // And the account lives on the pull request rather than only in this process: the concluded
    // check run is still there to be read by anything that comes along later.
    expect(concluded.status).toBe("completed");
    expect(concluded.headSha).toBe(pullRequest.headSha);
    expect(await client.readRoundRecord(pullRequest.headSha)).not.toBeNull();
  });
});
