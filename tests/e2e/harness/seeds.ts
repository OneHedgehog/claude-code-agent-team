import { randomUUID } from "node:crypto";

import type { OperatingSettings } from "../../../src/config/settings.js";
import { MERGE_GATE_CHECK_NAME } from "../../../src/github/check-run.js";
import { acquireHostLease, hostSlotsDirectory, type HostLease } from "../../../src/host-lease.js";
import {
  createLedger,
  InMemoryLedgerStore,
  type Ledger,
  type LedgerEntry,
} from "../../../src/ledger/tokens.js";
import { renderRoundRecord, type RoundRecord } from "../../../src/review/round-history.js";

import { HarnessError } from "./environment.js";
import type {
  FixtureClient,
  FixturePullRequest,
  OpenPullRequestOptions,
} from "./fixture-repository.js";

/**
 * The setup six scenarios need and the happy paths do not (quickstart.md, "Scenarios 11, 12, 15,
 * 17, 19, and 26 need fixture setup…").
 *
 * Every seed here **arranges a real condition**. None of them mocks the platform, and that is the
 * whole design constraint: a no-progress round is a real prior check run the service reads back
 * through its own round-history reader; a drawn-down budget is real ledger entries a real
 * `check()` refuses against; a full host is real slot files a real `acquireHostLease` cannot get
 * past. A seed that stubbed the reader instead would assert that the stub was called, which is a
 * statement about the harness rather than about the service.
 *
 *   11 — a concluded prior round on the same revision, with no push and no reply since
 *   12 — a prior round left *unconcluded*, which must not count as a failed round
 *   15 — a budget drawn to the reviewer reserve by non-review spend
 *   17 — the platform allowance drawn to its reserve
 *   19 — the authoring identity, which lives on the client because it is an identity, not a state
 *   26 — a base branch whose protection omits the gate
 */

/**
 * Quickstart 11. Writes a *concluded* round record onto the revision, exactly as a previous round
 * would have left it, so the next run reads a real baseline and finds no progress against it.
 *
 * The check run is created by the App because only an App installation can create one — which is
 * also scenario 19's assertion, arrived at from the other side.
 */
export async function seedConcludedRound(
  client: FixtureClient,
  pullRequest: FixturePullRequest,
  overrides: Partial<RoundRecord> = {},
): Promise<RoundRecord> {
  const record: RoundRecord = {
    roundNumber: 1,
    headSha: pullRequest.headSha,
    concluded: true,
    openBlockingFingerprints: [],
    // Backdated by a minute so a reply posted immediately after this seed is unambiguously
    // *after* the round concluded. FR-046 compares those timestamps, and two events written in
    // the same second would make the comparison decide the test.
    concludedAt: new Date(Date.now() - 60_000).toISOString(),
    tokensConsumed: 0,
    budgetRemaining: 0,
    excludedPathCount: 0,
    ...overrides,
  };

  const app = await client.asApp();
  await app.rest.checks.create({
    owner: client.environment.repository.owner,
    repo: client.environment.repository.name,
    name: MERGE_GATE_CHECK_NAME,
    head_sha: record.headSha,
    status: "completed",
    conclusion: "failure",
    completed_at: record.concludedAt,
    output: {
      title: "seeded prior round",
      summary: "Seeded by the end-to-end harness (tasks.md T032).",
      text: renderRoundRecord(record),
    },
  });

  return record;
}

/**
 * Quickstart 12. A round that started and never concluded — a crashed runner, a killed process, a
 * budget stop partway through.
 *
 * `concluded: false` is the load-bearing field. `round-history.ts` ignores an unconcluded round
 * entirely, which is what stops a retry after a crash from being read as an author who pushed
 * nothing; the check run is left `in_progress` as well, so the seed matches the shape a real crash
 * leaves rather than only the shape the parser reads.
 */
export async function seedCrashedRound(
  client: FixtureClient,
  pullRequest: FixturePullRequest,
  overrides: Partial<RoundRecord> = {},
): Promise<RoundRecord> {
  const record: RoundRecord = {
    roundNumber: 1,
    headSha: pullRequest.headSha,
    concluded: false,
    openBlockingFingerprints: [],
    concludedAt: new Date(Date.now() - 60_000).toISOString(),
    tokensConsumed: 0,
    budgetRemaining: 0,
    excludedPathCount: 0,
    ...overrides,
  };

  const app = await client.asApp();
  await app.rest.checks.create({
    owner: client.environment.repository.owner,
    repo: client.environment.repository.name,
    name: MERGE_GATE_CHECK_NAME,
    head_sha: record.headSha,
    status: "in_progress",
    started_at: record.concludedAt,
    output: {
      title: "seeded crashed round",
      summary: "Seeded by the end-to-end harness (tasks.md T032).",
      text: renderRoundRecord(record),
    },
  });

  return record;
}

function entry(actor: string, resource: LedgerEntry["resource"], amount: number): LedgerEntry {
  return {
    runId: randomUUID(),
    at: new Date().toISOString(),
    actor,
    resource,
    amount,
  };
}

function limitsOf(settings: OperatingSettings): {
  tokenBudget: number;
  reviewerTokenReserve: number;
  platformApiBudget: number;
  platformApiReserve: number;
} {
  return {
    tokenBudget: settings.tokenBudget,
    reviewerTokenReserve: settings.reviewerTokenReserve,
    platformApiBudget: settings.platformApiBudget,
    platformApiReserve: settings.platformApiReserve,
  };
}

/**
 * Quickstart 15. A budget drawn down to — and no further than — the reviewer reserve, entirely by
 * a **non-review** actor.
 *
 * That last word is the scenario. FR-047 exists so other agents draining the budget cannot leave a
 * pull request ungated, so the drawing actor must not be `review`: an identical total spent by the
 * reviewer itself would prove nothing about the reserve.
 */
export function ledgerDrawnToReviewerReserve(
  settings: OperatingSettings,
  target: string,
  actor = "implementer",
): Ledger {
  if (actor === "review") {
    throw new HarnessError(
      "scenario 15 draws the budget down with non-review spend; drawing it with `review` would " +
        "exercise the reserve from the one actor permitted to spend it (FR-047)",
    );
  }

  const drawn = settings.tokenBudget - settings.reviewerTokenReserve;

  return createLedger({
    target,
    limits: limitsOf(settings),
    store: new InMemoryLedgerStore([entry(actor, "tokens", drawn)]),
  });
}

/**
 * Quickstart 14. Drawn past the reserve as well, so even the reviewer cannot proceed — the case
 * that must stop *before* spending rather than partway through.
 */
export function ledgerExhausted(
  settings: OperatingSettings,
  target: string,
  actor = "implementer",
): Ledger {
  return createLedger({
    target,
    limits: limitsOf(settings),
    store: new InMemoryLedgerStore([
      entry(actor, "tokens", settings.tokenBudget - settings.reviewerTokenReserve),
      entry("review", "tokens", settings.reviewerTokenReserve),
    ]),
  });
}

/**
 * Quickstart 17. The platform allowance drawn to its reserve, which is what makes the next
 * content-creating call reach the reserve mid-review rather than before it.
 */
export function ledgerAtPlatformReserve(
  settings: OperatingSettings,
  target: string,
  actor = "implementer",
): Ledger {
  const drawn = settings.platformApiBudget - settings.platformApiReserve;

  return createLedger({
    target,
    limits: limitsOf(settings),
    store: new InMemoryLedgerStore([entry(actor, "platform-requests", drawn)]),
  });
}

/**
 * Quickstart 26. A pull request opened against the base branch whose protection deliberately omits
 * the gate, so FR-051 stops the run before it spends anything.
 *
 * The branch is standing rather than reconfigured per run: rewriting protection would need
 * `administration: write` on the fixture, and a run that crashed between the two writes would
 * leave the fixture in whichever half-state it reached.
 */
export function ungatedPullRequest(
  client: FixtureClient,
  options: Omit<OpenPullRequestOptions, "baseBranch">,
): Promise<FixturePullRequest> {
  return client.openPullRequest({
    ...options,
    baseBranch: client.environment.ungatedBaseBranch,
    label: options.label ?? "ungated-base",
  });
}

export interface SaturatedHost {
  readonly held: readonly HostLease[];
  readonly slotsDirectory: string;
  release(): void;
}

/**
 * Quickstart 24 and 25. Fills the host's slots with real leases, so a review genuinely cannot
 * start and the wait FR-041 measures is a wait rather than a simulation.
 *
 * The slots directory is the run's own — `runReview` and `runDaemonUntil` redirect
 * `XDG_STATE_HOME` per run — so saturating it blocks the suite's reviews and not the developer's
 * actual agent jobs.
 */
export function saturateHostSlots(
  stateDirectory: string,
  capacity: number,
  leave = 0,
): SaturatedHost {
  const slotsDirectory = hostSlotsDirectory({ XDG_STATE_HOME: stateDirectory });
  const held: HostLease[] = [];

  for (let taken = 0; taken < capacity - leave; taken += 1) {
    const lease = acquireHostLease({ directory: slotsDirectory, capacity });

    if (lease === null) {
      for (const acquired of held) acquired.release();

      throw new HarnessError(
        `could not fill ${capacity - leave} of ${capacity} host slots in ${slotsDirectory}: ` +
          `slot ${taken + 1} was already held. The state directory is meant to be this run's own.`,
      );
    }

    held.push(lease);
  }

  return {
    held,
    slotsDirectory,
    release(): void {
      for (const lease of held) lease.release();
    },
  };
}
