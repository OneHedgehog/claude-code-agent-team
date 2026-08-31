import { randomUUID } from "node:crypto";

import { composeService, notify, reviewPullRequest, type ServiceAdapters } from "./composition.js";
import { hostSlotsDirectory, withHostLease, noSlot } from "./host-lease.js";
import { createTarget, parseTargetSlug, type TargetRepository } from "./config/target.js";
import {
  MERGE_GATE_CHECK_NAME,
  openGate,
  reportGate,
  type CheckRunSummary,
} from "./github/check-run.js";
import { readOwnThreads } from "./github/threads.js";
import { measureQueueWait } from "./review/queue.js";
import { parseRoundRecord } from "./review/round-history.js";

/**
 * The reconciling daemon (research.md R-017, R-018, R-019).
 *
 * The service is a long-lived local process that discovers work by **reconciling state**, not by
 * receiving events. Edge-triggered delivery to a developer laptop loses events — the machine
 * sleeps, changes networks, and reboots — and every pull request opened during that window would
 * go unreviewed, quietly, with the gate never reported and nothing anywhere saying why.
 *
 * A level-triggered loop has no missed-event class of bug because it observes no events. Asleep
 * for a week, crashed mid-review, killed between posting findings and posting the gate: the next
 * tick reads the same facts back from GitHub and converges. Nothing here outlives a tick except an
 * `ETag`, and an `ETag` that is wrong costs one wasted listing rather than a lost review.
 */

export class DaemonError extends Error {
  override readonly name = "DaemonError";
}

export interface OpenPullRequest {
  readonly number: number;
  readonly headSha: string;
}

/**
 * The result of a conditional listing. `pullRequests` is `null` when the server answered `304` —
 * nothing has changed since the cached `ETag`, and the response cost no rate limit (FR-040).
 */
export interface PullRequestListing {
  readonly pullRequests: readonly OpenPullRequest[] | null;
  readonly etag: string | null;
}

/** One thread of ours, reduced to the two facts clause (b) asks about. */
export interface ThreadReplySummary {
  readonly findingId: string;
  /** When the newest reply arrived, or `null` when the author has not replied. */
  readonly latestReplyAt: string | null;
}

/** Why a pull request was selected. Both are review-triggering; they differ in what changed. */
export type SelectionReason = "no-gate-run-for-revision" | "reply-since-conclusion";

/** Why it was not. Each names the cheap condition that excluded it, for the log. */
export type SkipReason =
  | "gate-run-not-concluded"
  | "gate-run-did-not-fail"
  | "no-round-record"
  | "no-open-blocking-findings"
  | "no-reply-since-conclusion";

export interface Selection {
  readonly pullRequest: number;
  readonly headSha: string;
  readonly select: boolean;
  readonly reason: SelectionReason | SkipReason;
  /** Whether reaching this decision cost a review-thread read, which FR-040 budgets. */
  readonly threadsRead: boolean;
}

function gateRunFor(
  checkRuns: readonly CheckRunSummary[],
  headSha: string,
): CheckRunSummary | undefined {
  // Both filters matter. Another app's check run on the same revision says nothing about ours, and
  // our own run on a superseded revision says nothing about this one.
  return checkRuns.find((run) => run.name === MERGE_GATE_CHECK_NAME && run.headSha === headSha);
}

export interface DecideInput {
  readonly pullRequest: OpenPullRequest;
  /** The check runs on this pull request's head SHA. */
  readonly checkRuns: readonly CheckRunSummary[];
  /** Called only when the cheap conditions leave a reply able to matter (FR-040). */
  readonly readThreads: () => Promise<readonly ThreadReplySummary[]>;
}

/**
 * The reconciliation predicate, both clauses (R-018).
 *
 * Clause (a) — no gate check run exists for this head SHA — is R-017's original key, and it is
 * complete for code changes and blind to conversation. Clause (b) exists because FR-044 requires
 * the service to judge a justification an author offers *instead of* changing the code, which by
 * definition leaves the head SHA exactly where it was. Under clause (a) alone such a pull request
 * is skipped on every tick from then on: the reply is never read, FR-045's waiver request is never
 * raised, and FR-046's no-progress detector can never fire, because a second round on that
 * revision never starts.
 *
 * The order of the checks is the cost model. Reading review threads costs an API request per pull
 * request per tick; everything above the thread read is already in hand from the listing and the
 * check-run output, so a passing gate and a clean pull request cost nothing beyond the listing.
 */
export async function decideReview(input: DecideInput): Promise<Selection> {
  const { pullRequest } = input;
  const base = { pullRequest: pullRequest.number, headSha: pullRequest.headSha };

  const run = gateRunFor(input.checkRuns, pullRequest.headSha);

  // Clause (a).
  if (run === undefined) {
    return { ...base, select: true, reason: "no-gate-run-for-revision", threadsRead: false };
  }

  // Clause (b), cheap conditions first — each one alone rules a reply out of mattering.
  if (run.status !== "completed") {
    return { ...base, select: false, reason: "gate-run-not-concluded", threadsRead: false };
  }
  if (run.conclusion !== "failure") {
    return { ...base, select: false, reason: "gate-run-did-not-fail", threadsRead: false };
  }

  const record = parseRoundRecord(run.output.text);
  if (record === null) {
    // Without the round record there is no list of open blocking findings to compare replies
    // against. Treated as "nothing to reply to" rather than as a reason to review again: a
    // re-review costs tokens to reach a verdict already reached (FR-031).
    return { ...base, select: false, reason: "no-round-record", threadsRead: false };
  }

  const blocking = new Set(record.openBlockingFingerprints);
  if (blocking.size === 0) {
    return { ...base, select: false, reason: "no-open-blocking-findings", threadsRead: false };
  }

  // Only now does the read happen.
  const replies = await input.readThreads();
  const concludedAt = Date.parse(record.concludedAt);

  // "Newer than the conclusion time", not "unanswered" — the comparison FR-046 already defines,
  // reused rather than reinvented as a second notion of new.
  const replied = replies.some(
    (reply) =>
      blocking.has(reply.findingId) &&
      reply.latestReplyAt !== null &&
      Date.parse(reply.latestReplyAt) > concludedAt,
  );

  return replied
    ? { ...base, select: true, reason: "reply-since-conclusion", threadsRead: true }
    : { ...base, select: false, reason: "no-reply-since-conclusion", threadsRead: true };
}

export interface TickInput {
  readonly target: { readonly owner: string; readonly repo: string };
  /** The `ETag` from the previous tick's listing, or `null` on the first one. */
  readonly etag: string | null;
  listOpen(params: {
    owner: string;
    repo: string;
    etag: string | null;
  }): Promise<PullRequestListing>;
  listGateRuns(params: { owner: string; repo: string; ref: string }): Promise<CheckRunSummary[]>;
  readThreads(params: { pullRequest: number }): Promise<readonly ThreadReplySummary[]>;
}

export interface TickResult {
  /** True when the listing answered `304`: nothing changed, and nothing was selected. */
  readonly unchanged: boolean;
  readonly selected: readonly Selection[];
  readonly considered: readonly Selection[];
  /** Carried into the next tick so it can be conditional too. */
  readonly etag: string | null;
}

/**
 * One reconciliation pass. Decides every open pull request independently: one skip is not a reason
 * to stop, because the pull requests are unrelated and a stop would silently drop the rest.
 */
export async function reconcileTick(input: TickInput): Promise<TickResult> {
  const { owner, repo } = input.target;

  const listing = await input.listOpen({ owner, repo, etag: input.etag });

  if (listing.pullRequests === null) {
    return { unchanged: true, selected: [], considered: [], etag: listing.etag ?? input.etag };
  }

  const considered: Selection[] = [];

  for (const pullRequest of listing.pullRequests) {
    const checkRuns = await input.listGateRuns({ owner, repo, ref: pullRequest.headSha });

    considered.push(
      await decideReview({
        pullRequest,
        checkRuns,
        readThreads: () => input.readThreads({ pullRequest: pullRequest.number }),
      }),
    );
  }

  return {
    unchanged: false,
    selected: considered.filter((selection) => selection.select),
    considered,
    etag: listing.etag,
  };
}

export interface PublishInput {
  /** The revision the review actually examined. */
  readonly reviewed: string;
  /** Re-read at the last moment, immediately before anything is posted. */
  readHeadSha(): Promise<string>;
  publish(): Promise<void>;
}

export interface PublishResult {
  readonly published: boolean;
  readonly reason: string | null;
}

/**
 * The FR-019 superseded-run discard, made explicit.
 *
 * R-013 got this free from `cancel-in-progress`: a new push cancelled the in-flight workflow. A
 * reconciling process has no such mechanism, so the check is written out — the head SHA is re-read
 * immediately before posting, and an outcome about a revision the author has replaced is discarded
 * rather than published. Publishing it would anchor findings to lines that have moved and report a
 * gate for code nobody is proposing to merge.
 *
 * A head SHA that cannot be re-read discards too. The alternative is to assume it has not moved,
 * which is the assumption this check exists to stop making.
 */
export async function publishIfCurrent(input: PublishInput): Promise<PublishResult> {
  let current: string;
  try {
    current = await input.readHeadSha();
  } catch (error) {
    return {
      published: false,
      reason:
        `the head SHA could not be re-read before posting, so this run's outcome for ` +
        `${input.reviewed} is discarded rather than posted against an unknown revision ` +
        `(${error instanceof Error ? error.message : String(error)}) (FR-019)`,
    };
  }

  if (current !== input.reviewed) {
    return {
      published: false,
      reason:
        `this run reviewed ${input.reviewed}, which ${current} has since superseded; neither the ` +
        `findings nor the gate are posted, and the next tick reviews the new revision (FR-019)`,
    };
  }

  await input.publish();

  return { published: true, reason: null };
}

/** A review the tick selected, waiting for a worker and a host lease. */
interface QueuedReview {
  readonly pullRequest: number;
  readonly headSha: string;
  /** The tick that enqueued it — where FR-041's wait is measured from under R-017. */
  readonly queuedAt: string;
}

/**
 * The key a queue wait is remembered under: a pull request *at a revision*.
 *
 * Keyed on both because a push is a new review rather than a continuation of the old one. A wait
 * carried across a push would escalate on a revision that had only just appeared, which is the
 * opposite of what FR-041 measures.
 */
function queueKey(pullRequest: number, headSha: string): string {
  return `${pullRequest}@${headSha}`;
}

export interface DaemonOptions {
  readonly target: TargetRepository;
  /** Injected so the loop can be driven deterministically. Defaults to the real composition root. */
  readonly compose?: () => Promise<ServiceAdapters>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Runs until this returns false. Defaults to forever, which is what `launchd` supervises. */
  readonly running?: () => boolean;
  readonly env?: Record<string, string | undefined>;
}

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs one selected review under both caps: a worker from `maxConcurrentReviews`, and a host lease
 * from `host.maxConcurrentAgents` (R-019).
 *
 * Holding both is what makes the reviewer count against the same cap as every other agent job on
 * the machine, which FR-041's last sentence requires in as many words. A worker pool alone counts
 * only this process's own work, so a `/speckit-implement` task, a local CI run, and a review would
 * each stay inside "the cap" while three of them ran against a cap of two.
 */
async function runOne(
  adapters: ServiceAdapters,
  queued: QueuedReview,
  options: { readonly slotsDirectory: string; readonly now: () => Date },
): Promise<{ started: boolean }> {
  const { settings, host } = adapters.settings;

  const outcome = await withHostLease(
    { directory: options.slotsDirectory, capacity: host.maxConcurrentAgents },
    async () => {
      // Measured here rather than at enqueue: the wait ends when the review *starts*, which under
      // R-019 means holding both a worker and a host lease.
      const wait = measureQueueWait({
        queuedAt: queued.queuedAt,
        startedAt: options.now().toISOString(),
        maxQueueWaitSeconds: settings.maxQueueWaitSeconds,
      });

      if (wait.exceeded) {
        const runId = randomUUID();
        const reason = wait.reason ?? "this review waited past the configured maximum (FR-041)";

        adapters.logger.warn("queue.wait_exceeded", {
          pullRequest: queued.pullRequest,
          revision: queued.headSha,
        });

        // Reported rather than merely logged. Up to this point the gate has been *unreported*,
        // which is correct while the delay could still be ordinary scheduling — but a wait past
        // the configured maximum is no longer ordinary, and a queue nobody is told about is
        // indistinguishable from a service that has stopped (Principle VII). So FR-041's last
        // clause is discharged on all three surfaces it names: the gate fails, a human is
        // notified, and it escalates.
        //
        // The check run is opened and concluded in one step because there is no review between
        // the two: an `in_progress` run left behind would claim work that is not happening.
        const startedAt = options.now().toISOString();
        const gate = await openGate(adapters.checkRuns, adapters.target, queued.headSha, startedAt);

        await reportGate(
          adapters.checkRuns,
          adapters.target,
          gate,
          { conclusion: "failure", reason },
          options.now().toISOString(),
        );

        adapters.logger.warn("gate.reported", {
          pullRequest: queued.pullRequest,
          revision: queued.headSha,
          gate: { conclusion: "failure", reason },
        });

        await notify(adapters, {
          pullRequest: queued.pullRequest,
          runId,
          cause: "queue.wait_exceeded",
          reason,
          revision: queued.headSha,
        });

        return;
      }

      await reviewPullRequest(adapters, queued.pullRequest, { runId: randomUUID() });
    },
  );

  if (noSlot(outcome)) {
    // Not an error and not a failure of this review: the host is full. The gate stays unreported,
    // branch protection holds the merge, and the next tick tries again (FR-041).
    adapters.logger.info("queue.wait_started", {
      pullRequest: queued.pullRequest,
      revision: queued.headSha,
    });

    return { started: false };
  }

  return { started: true };
}

/**
 * The poll loop. Ticks every `pollIntervalSeconds`, reconciles, and runs what it selected through
 * a bounded worker pool.
 *
 * Settings are re-read on every tick through the composition root, so changing a budget or the
 * host's cap takes effect without restarting the process — which matters because the thing under
 * `launchd` is meant to be forgettable.
 */
export async function runDaemon(options: DaemonOptions): Promise<void> {
  const now = options.now ?? ((): Date => new Date());
  const sleep = options.sleep ?? sleepFor;
  const running = options.running ?? ((): boolean => true);
  const env = options.env ?? process.env;
  const slotsDirectory = hostSlotsDirectory(env);

  const compose =
    options.compose ?? (() => composeService({ target: options.target, env, runId: randomUUID() }));

  let etag: string | null = null;

  /**
   * When each waiting review first entered the queue, remembered across ticks (FR-041, R-017).
   *
   * This is the only state the loop keeps besides the `ETag`, and it is what makes the wait a wait
   * at all. `withHostLease` does not block — it takes a slot or reports that it could not — so a
   * review that finds the host full is simply re-selected on the next tick. Re-stamping
   * `queuedAt` each time would make every wait measure one tick, whatever the host had been doing
   * for the last hour, and FR-041's maximum could never be reached however saturated the machine.
   *
   * It is deliberately in-memory rather than persisted. A restarted daemon has no idea how long a
   * review was queued before it died, and inventing one would escalate on a wait nobody observed;
   * starting the clock again is the honest answer, and the gate stays unreported meanwhile.
   */
  const queuedSince = new Map<string, string>();

  while (running()) {
    const adapters = await compose();
    const { settings } = adapters.settings;

    const tick = await reconcileTick({
      target: { owner: options.target.owner, repo: options.target.name },
      etag,
      // A `304` costs no rate limit at all, which is what makes a short poll interval affordable
      // against FR-040's budget.
      listOpen: (params) => adapters.listOpenPullRequests(params),
      listGateRuns: (params) =>
        adapters.checkRuns.listForRef({
          owner: params.owner,
          repo: params.repo,
          ref: params.ref,
          check_name: MERGE_GATE_CHECK_NAME,
        }),
      readThreads: async (params) => {
        // `readOwnThreads` is what decides which threads are ours, and it decides it in one place.
        // A second marker reader here would be a second answer to that question.
        const own = await readOwnThreads(adapters.threads, options.target, params.pullRequest);

        return own.map((thread) => ({
          findingId: thread.findingId,
          latestReplyAt: thread.latestReplyAt,
        }));
      },
    });

    // The heartbeat (Principle VII).
    //
    // Every branch below this point is conditional -- a tick that selects nothing logs nothing --
    // so a daemon idling correctly and a daemon that has died produce byte-identical output:
    // none. That is not a theoretical complaint. This process ran for twenty-four minutes and
    // then exited, and the only way to tell the difference at any point was `ps`.
    //
    // One line per tick, at `info`, costs nothing against FR-040 -- a `304` is free and this is
    // not even a request -- and turns silence back into a signal.
    adapters.logger.info("tick.completed", {
      tick: {
        unchanged: tick.unchanged,
        considered: tick.considered.length,
        selected: tick.selected.length,
        skipped: tick.considered
          .filter((selection) => !selection.select)
          .map((selection) => ({ pullRequest: selection.pullRequest, reason: selection.reason })),
      },
    });

    etag = tick.etag;

    const enqueuedAt = now().toISOString();
    const queue: QueuedReview[] = tick.selected.map((selection) => {
      const key = queueKey(selection.pullRequest, selection.headSha);
      const queuedAt = queuedSince.get(key) ?? enqueuedAt;
      queuedSince.set(key, queuedAt);

      return { pullRequest: selection.pullRequest, headSha: selection.headSha, queuedAt };
    });

    // Anything no longer selected has been reviewed, superseded by a push, or closed. Forgetting
    // it keeps the map bounded by what is actually waiting rather than by everything ever seen.
    const stillQueued = new Set(queue.map((entry) => queueKey(entry.pullRequest, entry.headSha)));
    for (const key of [...queuedSince.keys()]) {
      if (!stillQueued.has(key)) queuedSince.delete(key);
    }

    // Bounded workers, each draining the same queue. `maxConcurrentReviews` is this process's
    // share; the host lease inside `runOne` is the real cap (R-019).
    const workers = Math.max(1, Math.min(settings.maxConcurrentReviews, queue.length));
    let next = 0;

    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (;;) {
          const queued = queue[next];
          next += 1;
          if (queued === undefined) return;

          const { started } = await runOne(adapters, queued, { slotsDirectory, now });

          // The wait ended, however it ended. Keeping the entry would let a review that has
          // already run carry an old `queuedAt` into a later tick and escalate on a wait that
          // finished.
          if (started) queuedSince.delete(queueKey(queued.pullRequest, queued.headSha));
        }
      }),
    );

    if (!running()) return;
    await sleep(settings.pollIntervalSeconds * 1000);
  }
}

/**
 * The daemon's own argument parsing. `cli.ts` requires `--pull-request`; the daemon has none — it
 * discovers pull requests rather than being told about one — so the two do not share a parser.
 * What they do share is the rule that matters: there is no default target, and no fallback to the
 * working directory (FR-027).
 */
export function parseDaemonArgs(argv: readonly string[]): TargetRepository {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);

    if (name !== "--target" && name !== "--checkout") {
      throw new DaemonError(`unrecognized argument ${JSON.stringify(token)}`);
    }

    if (equals !== -1) {
      values.set(name, token.slice(equals + 1));
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new DaemonError(`${name} requires a value`);
    }

    values.set(name, value);
    i += 1;
  }

  const slug = values.get("--target");
  const checkoutPath = values.get("--checkout");

  if (slug === undefined || checkoutPath === undefined) {
    throw new DaemonError(
      "--target and --checkout are both required: the daemon resolves everything through them " +
        "and never through the working directory (FR-027)",
    );
  }

  const { owner, name } = parseTargetSlug(slug);

  return createTarget({ owner, name, checkoutPath });
}

/**
 * The entry point `scripts/com.agents.review.plist` runs under `launchd`.
 *
 * Argument parsing is inside the same handler as the loop, because it throws synchronously and a
 * `.catch()` on the loop alone would let a missing `--target` reach stderr as a stack trace. Under
 * `KeepAlive` that stack would be reprinted every `ThrottleInterval` forever, which is the least
 * readable possible way to say "you forgot a flag".
 */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const fail = (error: unknown): void => {
    // stdout is the record stream (R-014); a fatal goes to stderr, which `launchd` captures
    // separately.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  };

  try {
    runDaemon({ target: parseDaemonArgs(process.argv.slice(2)) }).catch(fail);
  } catch (error) {
    fail(error);
  }
}
