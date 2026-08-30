import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  composeService,
  reviewPullRequest,
  type ReviewOutcome,
  type ServiceAdapters,
} from "../../../src/composition.js";
import type { LoadedSettings } from "../../../src/config/settings.js";
import { appConfigDirectory } from "../../../src/github/auth.js";
import { hostSlotsDirectory, noSlot, withHostLease } from "../../../src/host-lease.js";
import type { Ledger } from "../../../src/ledger/tokens.js";
import { ScriptedModelClient, type Script } from "../../../src/model/scripted.js";
import { createLogger } from "../../../src/observability/logger.js";
import { runGit, withWorktree } from "../../../src/worktree.js";
import { runDaemon } from "../../../src/daemon.js";

import { HarnessError, type InstallationCredential } from "./environment.js";
import type { FixtureClient, FixturePullRequest } from "./fixture-repository.js";

/**
 * Driving the real service against a fixture pull request (tasks.md T032, R-015, Principle II).
 *
 * The rule this file exists to hold is a negative one: **`ScriptedModelClient` is the only
 * substitution.** Everything else runs — the real composition root, the real installation token,
 * the real worktree provisioning, the real check-run writes, the real branch-protection read. A
 * second stub anywhere here would turn the end-to-end layer into a slower integration layer, and
 * the layer that catches "the App is not installed" would be catching nothing at all.
 *
 * Two things *are* redirected, and neither is a substitution of behavior:
 *
 *   - `XDG_STATE_HOME` points at a per-run directory, so the token ledger and the host-lease slots
 *     are the suite's own rather than the developer machine's. A scenario asserting on budget
 *     remaining must not read a total that yesterday's real review contributed to, and a suite
 *     that took slots from the machine's actual cap would block real work while it ran.
 *   - `HOME` is redirected only when a scenario asks for an *absent* model credential
 *     (quickstart 13), with `GITHUB_APP_CONFIG_DIR` pinned back at the real one so the App
 *     credential stays real while the model credential genuinely is not there. That is the
 *     condition FR-051 checks, produced rather than mocked.
 */

/** Whether the run should find a model credential. `absent` is quickstart scenario 13. */
export type ModelCredentialState = "resolved" | "absent";

export interface RunEnvironmentOptions {
  /** Isolated per run unless a caller pins one, e.g. to share slots with a saturating seed. */
  readonly stateDirectory?: string;
  readonly modelCredential?: ModelCredentialState;
}

export interface ComposeFixtureOptions extends RunEnvironmentOptions {
  readonly client: FixtureClient;
  /** The checkout the run is addressed at (FR-026). Normally a worktree at the revision. */
  readonly checkoutPath: string;
  readonly model?: ScriptedModelClient;
  /** Pre-drawn for scenarios 14, 15, and 17; the real JSONL ledger otherwise. */
  readonly ledger?: Ledger;
  /** Supplied by scenario 28, which is about settings the fixture does not carry. */
  readonly settings?: LoadedSettings;
  readonly runId?: string;
  /** Every record the run emitted is appended here rather than written to stdout. */
  readonly records?: unknown[];
  /**
   * The installation token the composed service authenticates with. Supplied only by scenario 26's
   * missing-permission half, which mints a genuinely narrowed one; every other scenario leaves it
   * absent and gets the real, full-permission token.
   */
  readonly installationToken?: () => Promise<InstallationCredential>;
}

export interface ReviewRun {
  readonly outcome: ReviewOutcome;
  readonly model: ScriptedModelClient;
  readonly adapters: ServiceAdapters;
  /** The records the run emitted, in order — what scenario 22 reconstructs a run from. */
  readonly records: readonly unknown[];
  readonly runId: string;
  readonly checkoutPath: string;
  readonly stateDirectory: string;
}

export interface RunReviewOptions extends RunEnvironmentOptions {
  readonly client: FixtureClient;
  readonly pullRequest: FixturePullRequest;
  /** Keyed by role, so the security and implementation reviewers are scripted apart. */
  readonly script: Script;
  readonly ledger?: Ledger;
  readonly settings?: LoadedSettings;
  readonly runId?: string;
  /** Scenario 26's narrowed token. Absent everywhere else, which gets the real one. */
  readonly installationToken?: () => Promise<InstallationCredential>;
}

/** A per-run state directory, so ledgers and host slots never cross between scenarios. */
export function isolatedStateDirectory(): string {
  return mkdtempSync(join(tmpdir(), "review-service-e2e-state-"));
}

/**
 * The environment the composed service reads. Real in every respect except the two redirections
 * documented at the top of this file.
 */
export function runEnvironment(
  options: RunEnvironmentOptions & { readonly stateDirectory: string },
): Record<string, string | undefined> {
  const base = { ...process.env, XDG_STATE_HOME: options.stateDirectory };

  if (options.modelCredential !== "absent") return base;

  // A home with no `~/.config/anthropic/credentials` in it, which is what makes the credential
  // genuinely absent rather than reported absent. `GITHUB_APP_CONFIG_DIR` is pinned back at the
  // real directory so this removes the *model* credential and nothing else.
  const emptyHome = mkdtempSync(join(tmpdir(), "review-service-e2e-home-"));

  return {
    ...base,
    HOME: emptyHome,
    GITHUB_APP_CONFIG_DIR: appConfigDirectory(process.env),
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
  };
}

/**
 * Composes the real service against the fixture. Exposed on its own because the queue scenarios
 * drive `runDaemon` rather than a single review and need the same adapters.
 */
export async function composeAgainstFixture(options: ComposeFixtureOptions): Promise<{
  adapters: ServiceAdapters;
  records: unknown[];
  runId: string;
  env: Record<string, string | undefined>;
}> {
  const stateDirectory = options.stateDirectory ?? isolatedStateDirectory();
  const env = runEnvironment({ ...options, stateDirectory });
  const runId = options.runId ?? randomUUID();
  const records = options.records ?? [];

  const adapters = await composeService({
    target: options.client.target(options.checkoutPath),
    runId,
    env,
    // The one permitted substitution (FR-029, FR-030).
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.installationToken === undefined
      ? {}
      : { installationToken: options.installationToken }),
    // Captured rather than printed: the records *are* the assertion surface for FR-033 and
    // FR-034, and a suite that only wrote them to stdout could not read them back.
    logger: createLogger({
      runId,
      write: (line) => records.push(JSON.parse(line)),
    }),
    // No keychain read: `security` on a developer machine may hold an Anthropic key that would
    // silently satisfy the credential a scenario is trying to remove, and shelling out per compose
    // would make the suite depend on the machine's keychain state.
    readKeychain: () => null,
  });

  return { adapters, records, runId, env };
}

/**
 * Reviews one fixture pull request end to end.
 *
 * The worktree and the host lease are both real. The lease matters even for a single review: R-019
 * makes the reviewer count against the same host-wide cap as every other agent job, and a harness
 * that skipped it would exercise a path the daemon never takes.
 */
export async function runReview(options: RunReviewOptions): Promise<ReviewRun> {
  const { client, pullRequest } = options;
  const stateDirectory = options.stateDirectory ?? isolatedStateDirectory();
  const model = new ScriptedModelClient(options.script);
  const records: unknown[] = [];

  const { token } = await client.environment.installationToken();
  const { owner, name } = client.environment.repository;
  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${name}.git`;

  const environmentForLease = runEnvironment({ ...options, stateDirectory });

  const outcome = await withWorktree(
    {
      // `withWorktree` reads only owner and name from the target — the checkout it provisions is
      // what it returns. The path here names the cache the mirror lives in rather than any tree
      // the service inspects, which `composeAgainstFixture` is handed below.
      target: client.target(client.environment.cacheDirectory),
      remoteUrl,
      pullRequest: pullRequest.number,
      headSha: pullRequest.headSha,
      cacheDirectory: client.environment.cacheDirectory,
    },
    async (tree) => {
      const composed = await composeAgainstFixture({
        ...options,
        checkoutPath: tree.path,
        stateDirectory,
        model,
        records,
      });

      const result = await withHostLease(
        {
          directory: hostSlotsDirectory(environmentForLease),
          capacity: composed.adapters.settings.host.maxConcurrentAgents,
        },
        () => reviewPullRequest(composed.adapters, pullRequest.number, { runId: composed.runId }),
      );

      if (noSlot(result)) {
        throw new HarnessError(
          `no host slot free in ${hostSlotsDirectory(environmentForLease)} at capacity ` +
            `${composed.adapters.settings.host.maxConcurrentAgents}. A scenario that saturates the ` +
            "cap on purpose should drive `runDaemonUntil`, which treats a full host as the wait " +
            "FR-041 measures rather than as a failure.",
        );
      }

      return { outcome: result, adapters: composed.adapters, runId: composed.runId };
    },
  );

  return {
    outcome: outcome.outcome,
    model,
    adapters: outcome.adapters,
    records,
    runId: outcome.runId,
    checkoutPath: outcome.adapters.target.checkoutPath,
    stateDirectory,
  };
}

export interface DaemonRunOptions extends RunEnvironmentOptions {
  readonly client: FixtureClient;
  readonly script: Script;
  /**
   * The checkout the daemon is addressed at (FR-027). The daemon is pointed at a static clone —
   * `--checkout` — rather than at a per-review worktree, so this is a clone of the fixture's base
   * branch; `fixtureCheckout` below provisions one.
   */
  readonly checkoutPath: string;
  /** How many poll ticks to run before stopping. The daemon otherwise runs forever. */
  readonly ticks: number;
  /**
   * What happens between ticks. Defaults to a no-op, so the loop advances at the speed of the API
   * rather than of the wall clock.
   *
   * Scenario 25 supplies its own, because the wait FR-041 measures is only observable across
   * ticks: the host has to be full when the review is first selected and free by the time it is
   * selected again, and the seam between two ticks is the only place a scenario can arrange that.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly ledger?: Ledger;
  readonly settings?: LoadedSettings;
}

export interface DaemonRun {
  readonly model: ScriptedModelClient;
  readonly records: readonly unknown[];
  readonly ticks: number;
  readonly stateDirectory: string;
}

/**
 * Runs the real reconciling daemon for a bounded number of ticks — what quickstart scenarios 24
 * and 25 need, because the queue wait R-017 measures is a property of the daemon's loop and does
 * not exist on the single-review path at all.
 *
 * The poll interval is not slept through: `sleep` is a no-op so the loop advances at the speed of
 * the API rather than of the wall clock. That is a substitution of *time*, not of behavior — the
 * queue wait itself is still measured from real timestamps.
 */
export async function runDaemonUntil(options: DaemonRunOptions): Promise<DaemonRun> {
  const stateDirectory = options.stateDirectory ?? isolatedStateDirectory();
  const model = new ScriptedModelClient(options.script);
  const records: unknown[] = [];

  let remaining = options.ticks;

  await runDaemon({
    target: options.client.target(options.checkoutPath),
    env: runEnvironment({ ...options, stateDirectory }),
    sleep: options.sleep ?? ((): Promise<void> => Promise.resolve()),
    running: () => {
      if (remaining <= 0) return false;
      remaining -= 1;

      return true;
    },
    compose: async () =>
      (
        await composeAgainstFixture({
          ...options,
          checkoutPath: options.checkoutPath,
          stateDirectory,
          model,
          records,
        })
      ).adapters,
  });

  return { model, records, ticks: options.ticks - remaining, stateDirectory };
}

/**
 * A plain clone of the fixture's base branch, for the daemon path.
 *
 * The daemon reads the constitution and settings through `--checkout`, which in production is a
 * static clone kept beside the service rather than a per-review worktree. Scenarios that drive the
 * daemon need the same shape, and they need it to be the *fixture's* files — a checkout of this
 * repository would resolve this repository's constitution, which is precisely the confusion FR-026
 * exists to prevent.
 */
export async function fixtureCheckout(client: FixtureClient): Promise<string> {
  const { token } = await client.environment.installationToken();
  const { owner, name } = client.environment.repository;
  const path = mkdtempSync(join(tmpdir(), "review-service-e2e-checkout-"));

  await runGit({
    program: "git",
    args: [
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      client.environment.gatedBaseBranch,
      `https://x-access-token:${token}@github.com/${owner}/${name}.git`,
      path,
    ],
  });

  return path;
}
