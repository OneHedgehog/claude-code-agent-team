import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";

import { loadSettings, type LoadedSettings, type RoleName } from "./config/settings.js";
import { resolveInTarget, targetSlug, type TargetRepository } from "./config/target.js";
import {
  appIdPath,
  appPrivateKeyPath,
  AuthError,
  createInstallationTokenExchange,
  InstallationTokenProvider,
  readAppId,
  readAppPrivateKey,
  type PermissionLevel,
} from "./github/auth.js";
import {
  classifyProtectionResponse,
  type BranchProtectionApi,
  type ProtectionOutcome,
} from "./github/branch-protection.js";
import {
  buildGateOutput,
  listGateRuns,
  MERGE_GATE_CHECK_NAME,
  openGate,
  reportGate,
  type CheckRunApi,
  type CheckRunSummary,
} from "./github/check-run.js";
import { readDiff, readPullRequest, type PullRequestApi } from "./github/pull-request.js";
import { assess, type RateLimitSignals } from "./github/rate-limit.js";
import { buildRoleReview, submitReview, type ReviewsApi } from "./github/reviews.js";
import {
  ownThreads as narrowOwnThreads,
  readOwnMarker,
  resolveThreads,
  REVIEW_THREADS_QUERY,
  RESOLVE_THREAD_MUTATION,
  type ReviewThread,
  type ThreadsApi,
} from "./github/threads.js";
import { createLedger, JsonlLedgerStore, type Ledger } from "./ledger/tokens.js";
import Anthropic from "@anthropic-ai/sdk";

import { AgentSdkModelClient } from "./model/agent-sdk.js";
import {
  AnthropicModelClient,
  MAX_OUTPUT_TOKENS,
  MISSING_CREDENTIAL_REASON,
  MissingCredentialError,
  type MessagesApi,
  macosKeychainReader,
  resolveModelCredential,
  type ModelCredential,
} from "./model/anthropic.js";
import {
  isPullRequestLevel as isPullRequestLevelLocation,
  type FindingLocation,
  type ModelClient,
  type PriorFinding,
  type PullRequestContext,
} from "./model/client.js";
import {
  escalate,
  type EscalationCause,
  type EscalationSurfaces,
} from "./observability/escalate.js";
import {
  createLogger,
  type Logger,
  type RecordFields,
  type ReviewEvent,
} from "./observability/logger.js";
import { binaryPathsFromDiff, resolveExcludedPaths } from "./review/excluded-paths.js";
import {
  aggregate,
  deriveDecision,
  isMissing,
  type GateResult,
  type RoleOutcome,
} from "./review/gate.js";
import { createFinding, type Finding } from "./review/findings.js";
import { changedLineCount, changedPaths, indexDiff, resolveLocation } from "./review/locations.js";
import { checkPrerequisites } from "./review/prerequisites.js";
import { checkProgress } from "./review/progress.js";
import { resolvePrecedence, ROLE_PRECEDENCE } from "./review/precedence.js";
import { reconcile } from "./review/reconcile.js";
import { judgeReplies } from "./review/replies.js";
import { createImplementationRole } from "./review/roles/implementation.js";
import { securityRole } from "./review/roles/security.js";
import type { RoleResult } from "./review/roles/role.js";
import { baselineRound, nextRoundNumber, type RoundRecord } from "./review/round-history.js";
import { checkEmptyDiff } from "./review/rules/empty-diff.js";
import { checkReviewableSize } from "./review/rules/reviewable-size.js";
import { checkSelfReview } from "./review/self-review.js";

/**
 * The composition root (FR-026, FR-027, tasks.md T127).
 *
 * Every other module in `src/` names its platform edge as an interface and never constructs one.
 * That is what makes them unit-testable without a network, and it is also why, until this file
 * existed, nothing in the tree could actually run: `src/` contained no `@octokit` import at all
 * and `parseArgs` was never called. This is the one place concrete adapters are built. A second
 * place constructing an Octokit would be a merge conflict by construction, and — worse — a second
 * place for a credential to be read.
 *
 * Everything is resolved through the `TargetRepository` parameter and never through
 * `process.cwd()`: the constitution's Scope clause requires the service to be addressed at its
 * target rather than to infer one from whatever happens to be checked out.
 */

export class CompositionError extends Error {
  override readonly name = "CompositionError";
}

/** Where the token ledger persists between runs. Local state, treated as a cache (R-010). */
export function ledgerPath(
  env: Record<string, string | undefined>,
  target: TargetRepository,
): string {
  const base = env["XDG_STATE_HOME"] ?? join(env["HOME"] ?? homedir(), ".local", "state");

  return join(base, "review-service", `${target.owner}__${target.name}.ledger.jsonl`);
}

/**
 * Every concrete adapter the service runs on. Assembled once and passed down, so no module below
 * this one has to know that GitHub is reached over HTTP at all.
 */
export interface ServiceAdapters {
  readonly target: TargetRepository;
  readonly settings: LoadedSettings;
  readonly checkRuns: CheckRunApi;
  readonly pullRequests: PullRequestApi;
  readonly reviews: ReviewsApi;
  readonly threads: ThreadsApi;
  readonly branchProtection: BranchProtectionApi;
  readonly escalation: EscalationSurfaces;
  readonly model: ModelClient;
  readonly modelCredential: ModelCredential | null;
  readonly logger: Logger;
  readonly ledger: Ledger;
  /**
   * The open pull requests, listed conditionally: an unchanged listing answers `304`, returns no
   * pull requests, and costs no rate limit (R-017, FR-040).
   */
  listOpenPullRequests(params: { owner: string; repo: string; etag: string | null }): Promise<{
    pullRequests: readonly { number: number; headSha: string }[] | null;
    etag: string | null;
  }>;
  /** The permissions the installation token actually carries, for the FR-051 check. */
  permissions(): Promise<Record<string, PermissionLevel>>;
  /**
   * The App's own author login — `<slug>[bot]` — which is what FR-004 compares a pull request's
   * author against. Resolved once, when the service is composed, from the installation itself.
   */
  readonly reviewingIdentity: string;
  /**
   * The installation's remaining platform allowance, read from GitHub rather than counted locally
   * (FR-040, R-007).
   *
   * Read rather than counted because the allowance **refills**, and a local counter of requests
   * made has no way to know when. GitHub reports the remaining figure and the reset instant
   * together, which is exactly the pair `assess` needs; a ledger of our own would be a second,
   * always-stale opinion about a number the platform already publishes.
   *
   * `null` when the figures are absent or unparseable. Inventing a ceiling, or defaulting to zero
   * remaining, would each be a guess in the one place this must not guess — the first would spend
   * past a real limit and the second would pause a service that was not throttled at all.
   */
  rateLimitSignals(): Promise<RateLimitSignals | null>;
  /** The authenticated remote `worktree.ts` clones and fetches from. */
  remoteUrl(): Promise<string>;
}

/** The seams a test substitutes. Absent, each is built from the machine's real credentials. */
export interface ComposeOptions {
  readonly target: TargetRepository;
  readonly runId?: string;
  readonly env?: Record<string, string | undefined>;
  /** Injected so a test can compose the whole graph without a private key or a network. */
  readonly octokit?: Octokit;
  readonly graphqlClient?: typeof graphql;
  readonly model?: ModelClient;
  /**
   * The transport the real adapter is built on. Injectable for the same reason `octokit` is: it is
   * the only way to exercise what this root *wires* -- the rejected-location record, the clamp --
   * rather than substituting the adapter and testing neither.
   */
  readonly messages?: MessagesApi;
  readonly logger?: Logger;
  readonly ledger?: Ledger;
  readonly settings?: LoadedSettings;
  /**
   * The keychain reader. Injected so composing does not shell out to the OS keychain — a test
   * that did would be testing the developer's machine, and `security` writes to stderr when it
   * finds nothing.
   */
  readonly readKeychain?: () => string | null;
  readonly installationToken?: () => Promise<{
    token: string;
    permissions: Record<string, PermissionLevel>;
    /** The App the token belongs to. Whatever mints a token knows which App it is minting for. */
    appSlug: string;
  }>;
}

function octokitCheckRuns(octokit: Octokit): CheckRunApi {
  return {
    async create(params) {
      // Spread rather than pass through: under `exactOptionalPropertyTypes` an explicitly
      // `undefined` optional is not the same as an absent one, and Octokit's generated types
      // reject the former.
      const { data } = await octokit.rest.checks.create({
        owner: params.owner,
        repo: params.repo,
        name: params.name,
        head_sha: params.head_sha,
        status: params.status,
        ...(params.started_at === undefined ? {} : { started_at: params.started_at }),
        ...(params.output === undefined ? {} : { output: { ...params.output } }),
      });

      return { id: data.id };
    },

    async update(params) {
      await octokit.rest.checks.update({
        owner: params.owner,
        repo: params.repo,
        check_run_id: params.check_run_id,
        ...(params.status === undefined ? {} : { status: params.status }),
        ...(params.conclusion === undefined ? {} : { conclusion: params.conclusion }),
        ...(params.completed_at === undefined ? {} : { completed_at: params.completed_at }),
        ...(params.output === undefined ? {} : { output: { ...params.output } }),
      });
    },

    async listForRef(params): Promise<CheckRunSummary[]> {
      const { data } = await octokit.rest.checks.listForRef({
        owner: params.owner,
        repo: params.repo,
        ref: params.ref,
        ...(params.check_name === undefined ? {} : { check_name: params.check_name }),
      });

      return data.check_runs.map((run) => ({
        id: run.id,
        name: run.name,
        headSha: run.head_sha,
        status: run.status as "queued" | "in_progress" | "completed",
        conclusion: run.conclusion ?? null,
        completedAt: run.completed_at ?? null,
        output: { title: run.output.title ?? null, text: run.output.text ?? null },
      }));
    },
  };
}

function octokitPullRequests(octokit: Octokit): PullRequestApi {
  return {
    async get(params) {
      const { data } = await octokit.rest.pulls.get(params);

      return {
        number: data.number,
        title: data.title,
        body: data.body,
        user: data.user === null ? null : { login: data.user.login, type: data.user.type },
        head: { sha: data.head.sha },
        base: { ref: data.base.ref },
        ...(data.draft === undefined ? {} : { draft: data.draft }),
      };
    },

    async getDiff(params) {
      const response = await octokit.rest.pulls.get({
        ...params,
        mediaType: { format: "diff" },
      });

      // Under the diff media type Octokit hands back the raw patch as `data`, typed as the JSON
      // shape. The cast is the media type, not an assumption about the payload.
      return response.data as unknown as string;
    },
  };
}

function octokitReviews(octokit: Octokit): ReviewsApi {
  return {
    async create(params) {
      const { data } = await octokit.rest.pulls.createReview(params);

      return { id: data.id };
    },
  };
}

/**
 * Review threads are not exposed in the REST API at all, so this one adapter speaks GraphQL
 * (R-006). Paging is followed to the end: a truncated thread list would make reconciliation
 * silently resolve fewer findings than it should.
 */
function graphqlThreads(client: typeof graphql, token: string): ThreadsApi {
  const authorized = client.defaults({ headers: { authorization: `token ${token}` } });

  interface ThreadPage {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            id: string;
            isResolved: boolean;
            path: string | null;
            line: number | null;
            comments: {
              nodes: { body: string; createdAt: string; author: { login: string } | null }[];
            };
          }[];
        };
      };
    };
  }

  return {
    async listReviewThreads(params): Promise<ReviewThread[]> {
      const threads: ReviewThread[] = [];
      let cursor: string | null = null;

      for (;;) {
        const page: ThreadPage = await authorized<ThreadPage>(REVIEW_THREADS_QUERY, {
          owner: params.owner,
          repo: params.repo,
          number: params.pullRequest,
          cursor,
        });

        const { nodes, pageInfo } = page.repository.pullRequest.reviewThreads;

        for (const node of nodes) {
          threads.push({
            id: node.id,
            isResolved: node.isResolved,
            path: node.path,
            line: node.line,
            comments: node.comments.nodes.map((comment) => ({
              body: comment.body,
              createdAt: comment.createdAt,
              authorLogin: comment.author?.login ?? null,
            })),
          });
        }

        if (!pageInfo.hasNextPage || pageInfo.endCursor === null) return threads;
        cursor = pageInfo.endCursor;
      }
    },

    async resolveReviewThread(params) {
      await authorized(RESOLVE_THREAD_MUTATION, { threadId: params.threadId });
    },
  };
}

function octokitBranchProtection(octokit: Octokit): BranchProtectionApi {
  return {
    async getBranchProtection(params): Promise<{ status: number; body: unknown }> {
      try {
        const response = await octokit.rest.repos.getBranchProtection(params);

        return { status: response.status, body: response.data };
      } catch (error) {
        // A 403 and a 404 are both *answers* here, not failures: `classifyProtectionResponse`
        // reads the message to tell a plan limitation from a missing grant, and that distinction
        // is lost if the throw propagates.
        const { status, response } = error as {
          status?: number;
          response?: { data?: unknown };
        };

        if (typeof status === "number") {
          return { status, body: response?.data ?? {} };
        }

        throw error;
      }
    },
  };
}

/**
 * The remaining allowance, from GitHub's own accounting.
 *
 * `resources.core` is the figure available to read. R-007 records that the *binding* constraint is
 * expected to be the secondary limit on content-creating requests — 80/minute, 500/hour — which
 * GitHub deliberately does not publish as a counter. `platformApiReserve` is therefore configured
 * against the figure that can be read, and its default (50 against a 400 budget) is set with that
 * in mind. A reserve compared against a number nobody can observe would be a setting that never
 * fires.
 */
function octokitRateLimit(octokit: Octokit): () => Promise<RateLimitSignals | null> {
  return async () => {
    try {
      const { data } = await octokit.rest.rateLimit.get();
      const core = data.resources.core;

      if (
        !Number.isInteger(core.limit) ||
        !Number.isInteger(core.remaining) ||
        !Number.isInteger(core.reset)
      ) {
        return null;
      }

      return { limit: core.limit, remaining: core.remaining, resetAt: new Date(core.reset * 1000) };
    } catch {
      // Unreadable is not throttled. A run that paused because it could not read the allowance
      // would turn one flaky request into an unreported gate.
      return null;
    }
  };
}

function octokitEscalation(octokit: Octokit): EscalationSurfaces {
  return {
    async findEscalationIssue(params) {
      const { data } = await octokit.rest.issues.listForRepo({
        owner: params.owner,
        repo: params.repo,
        state: "open",
        labels: params.label,
        per_page: 100,
      });

      // Matched on the marker rather than the title: a human may retitle an issue, and a
      // duplicate escalation is worse than an ugly title (R-012).
      const marker = `"pullRequest":${params.pullRequest},"cause":${JSON.stringify(params.cause)}`;
      const found = data.find((issue) => (issue.body ?? "").includes(marker));

      return found === undefined ? null : { number: found.number, body: found.body ?? "" };
    },

    async createIssue(params) {
      const { data } = await octokit.rest.issues.create({
        owner: params.owner,
        repo: params.repo,
        title: params.title,
        body: params.body,
        assignees: [params.assignee],
        labels: [...params.labels],
      });

      return { number: data.number };
    },

    async updateIssue(params) {
      await octokit.rest.issues.update({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.issueNumber,
        body: params.body,
      });
    },

    async commentOnPullRequest(params) {
      await octokit.rest.issues.createComment({
        owner: params.owner,
        repo: params.repo,
        issue_number: params.pullRequest,
        body: params.body,
      });
    },
  };
}

/**
 * The real token source: the App's credentials on disk, its installation on the target discovered
 * with its own JWT, and a provider that refreshes before expiry rather than on a `401` (FR-002,
 * FR-022).
 *
 * Nothing below this function ever sees the private key. Everything below it sees an hour-long
 * installation token, which is the whole point of the exchange.
 */
async function appInstallationTokenSource(
  env: Record<string, string | undefined>,
  target: TargetRepository,
): Promise<
  () => Promise<{
    token: string;
    permissions: Record<string, PermissionLevel>;
    appSlug: string;
  }>
> {
  const exchange = createInstallationTokenExchange({
    appId: readAppId(appIdPath(env)),
    privateKey: readAppPrivateKey(appPrivateKeyPath(env)),
  });

  let installation: { installationId: number; appSlug: string };
  try {
    installation = await exchange.installationForRepo({
      owner: target.owner,
      repo: target.name,
    });
  } catch (error) {
    throw new AuthError(
      `the App is not installed on ${targetSlug(target)}, or its credentials do not authenticate: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const provider = new InstallationTokenProvider({
    exchange,
    installationId: installation.installationId,
  });

  return async () => {
    const auth = await provider.authenticate();

    return { token: auth.token, permissions: auth.permissions, appSlug: installation.appSlug };
  };
}

/**
 * Stands in for the model client when no credential resolved. It exists so that composition never
 * fails on an absent credential — the prerequisite check is what reports that, before any spend —
 * and so that nothing downstream has to hold a nullable model client. Called, it throws, which is
 * unreachable: `checkPrerequisites` stops the run first.
 */
/**
 * The SDK's `messages` resource, narrowed to the one method the adapter calls. The cast is the
 * narrowing itself — the SDK's `create` is heavily overloaded, and `MessagesApi` exists precisely
 * so that nothing below this line depends on which overload was selected.
 */
function anthropicMessages(credential: ModelCredential): MessagesApi {
  // An `oauth-profile` credential carries no key: the SDK reads the profile from disk itself, so a
  // bare constructor is correct rather than an omission (CLAUDE.md, verified 2026-08-17).
  const client = new Anthropic(credential.apiKey === null ? {} : { apiKey: credential.apiKey });

  return {
    create: (params) =>
      client.messages.create(params as unknown as Parameters<typeof client.messages.create>[0]),
  };
}

function unavailableModel(reason: string): ModelClient {
  return {
    review: () => Promise.reject(new MissingCredentialError(reason)),
  };
}

/**
 * Builds every adapter the service runs on.
 *
 * The credential is read once, here, and the token it mints is what every adapter authenticates
 * with. Nothing below this function ever sees the private key.
 */
export async function composeService(options: ComposeOptions): Promise<ServiceAdapters> {
  const env = options.env ?? process.env;
  const { target } = options;
  const runId = options.runId ?? randomUUID();

  const settings = options.settings ?? loadSettings(target);
  const logger = options.logger ?? createLogger({ runId });

  const mintToken = options.installationToken ?? (await appInstallationTokenSource(env, target));

  const authenticated = await mintToken();

  const octokit = options.octokit ?? new Octokit({ auth: authenticated.token });
  const graphqlClient = options.graphqlClient ?? graphql;

  // `agent-sdk` runs Claude Code as a library, which authenticates itself against the operator's
  // subscription -- so this process holds no model credential at all, and FR-051's presence check
  // has nothing to check. Reported as a credential whose source is the transport, rather than as
  // an absent one, so a run that cannot reach the model still fails for a stated reason.
  const transport = settings.settings.modelTransport;

  // Annotated rather than asserted. `as ModelCredential` would have silenced the compiler on the
  // one value in this file that no resolver ever checked; an annotation keeps it checking, and it
  // passes today because `apiKey` is genuinely nullable -- the `oauth-profile` source already
  // carries no key.
  const agentSdkCredential: ModelCredential = { source: "agent-sdk", apiKey: null };

  const modelCredential =
    transport === "agent-sdk"
      ? agentSdkCredential
      : resolveModelCredential({
          env,
          keychain: options.readKeychain ?? macosKeychainReader("anthropic-api-key"),
        });

  // Constructed only when a credential exists. An absent one is not an error *here* — it is a
  // startup prerequisite, reported with a reason and zero spend rather than as a 401 mid-review
  // (FR-032, FR-051) — so the client is only built once there is something to build it from.
  const model =
    options.model ??
    (transport === "agent-sdk"
      ? new AgentSdkModelClient({
          // The same record on both transports: a refused location is a fact about model output,
          // and one of its causes is an attempt to name a path outside the checkout (FR-024).
          onRejectedLocation: (rejection) =>
            logger.warn("location.rejected", {
              location: { path: rejection.path, reason: rejection.reason },
            }),
        })
      : modelCredential === null
        ? unavailableModel(MISSING_CREDENTIAL_REASON)
        : new AnthropicModelClient({
            credential: modelCredential,
            // An `oauth-profile` credential carries no key: the SDK reads the profile itself, so a
            // bare constructor is correct rather than lazy (CLAUDE.md, verified 2026-08-17).
            messages: options.messages ?? anthropicMessages(modelCredential),
            // A refused location is a fact about model output, and one of its causes is an attempt
            // to name a path outside the checkout. Recorded rather than silently corrected (FR-024).
            onRejectedLocation: (rejection) =>
              logger.warn("location.rejected", {
                location: { path: rejection.path, reason: rejection.reason },
              }),
          }));

  const ledger =
    options.ledger ??
    createLedger({
      target: targetSlug(target),
      limits: {
        tokenBudget: settings.settings.tokenBudget,
        reviewerTokenReserve: settings.settings.reviewerTokenReserve,
        platformApiBudget: settings.settings.platformApiBudget,
        platformApiReserve: settings.settings.platformApiReserve,
      },
      store: new JsonlLedgerStore(ledgerPath(env, target)),
    });

  return {
    target,
    settings,
    checkRuns: octokitCheckRuns(octokit),
    pullRequests: octokitPullRequests(octokit),
    reviews: octokitReviews(octokit),
    threads: graphqlThreads(graphqlClient, authenticated.token),
    branchProtection: octokitBranchProtection(octokit),
    escalation: octokitEscalation(octokit),
    listOpenPullRequests: (params) => listOpenConditionally(octokit, params),
    model,
    modelCredential,
    logger,
    ledger,
    permissions: async () => (await mintToken()).permissions,
    // GitHub appends `[bot]` to an App's login wherever it appears as an author, so the identity
    // FR-004 compares against is the slug plus that suffix (`self-review.ts` canonicalizes it
    // either way, but the value stored here is the login as GitHub actually reports it).
    reviewingIdentity: `${authenticated.appSlug}[bot]`,
    rateLimitSignals: octokitRateLimit(octokit),
    remoteUrl: async () =>
      `https://x-access-token:${(await mintToken()).token}@github.com/${targetSlug(target)}.git`,
  };
}

/**
 * The conditional listing behind `ServiceAdapters.listOpenPullRequests`.
 *
 * `If-None-Match` is what makes a short poll interval affordable: GitHub answers an unchanged
 * listing with `304` and charges nothing against the rate limit. Octokit surfaces the `304` as a
 * thrown error rather than a response, which is why it is caught here and turned back into the
 * answer it actually is.
 */
async function listOpenConditionally(
  octokit: Octokit,
  params: { owner: string; repo: string; etag: string | null },
): Promise<{
  pullRequests: readonly { number: number; headSha: string }[] | null;
  etag: string | null;
}> {
  try {
    const response = await octokit.rest.pulls.list({
      owner: params.owner,
      repo: params.repo,
      state: "open",
      per_page: 100,
      ...(params.etag === null ? {} : { headers: { "if-none-match": params.etag } }),
    });

    return {
      pullRequests: response.data.map((pull) => ({ number: pull.number, headSha: pull.head.sha })),
      etag: response.headers.etag ?? null,
    };
  } catch (error) {
    const { status } = error as { status?: number };

    // Not a failure: it is the whole point of sending the ETag.
    if (status === 304) return { pullRequests: null, etag: params.etag };

    throw error;
  }
}

/** What one review of one pull request concluded, for the caller that has to report an exit code. */
export interface ReviewOutcome {
  readonly runId: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly gate: GateResult;
  readonly findings: readonly Finding[];
  readonly tokensConsumed: number;
  /** True when the run stopped before spending anything — a prerequisite, size, or identity stop. */
  readonly stoppedBeforeSpending: boolean;
}

/**
 * The record each escalation cause writes before the escalation itself, so a reader of the record
 * stream can tell *which* stop happened without parsing the prose of the reason.
 *
 * The mapping is exhaustive by type rather than by a default branch: a cause added later without a
 * record to go with it should fail to compile, not fall silently into a generic bucket.
 */
const CAUSE_EVENT: Readonly<Record<EscalationCause, ReviewEvent>> = {
  "settings.invalid": "settings.invalid",
  "prerequisites.missing": "prerequisites.missing",
  "identity.self_authored": "identity.self_authored_refused",
  "progress.no_forward_progress": "progress.no_forward_progress",
  "rounds.cap_exceeded": "rounds.cap_exceeded",
  "diff.empty": "diff.empty",
  "size.exceeds_reviewable": "size.exceeds_reviewable",
  "budget.exhausted": "budget.exhausted",
  "platform.rate_limit": "platform.reserve_reached",
  "queue.wait_exceeded": "queue.wait_exceeded",
  "roles.disagreement": "roles.disagreement_escalated",
  "waiver.requested": "finding.waiver_requested",
  "ledger.mismatch": "error.unhandled",
  "error.unhandled": "error.unhandled",
};

/**
 * Escalates and records that it did, on both surfaces separately (FR-035).
 *
 * `escalate` already refuses to let a failure on one surface skip the other; this adds the half
 * that makes it auditable. The record carries `channelDelivered` and `statedOnPullRequest` as two
 * fields rather than one, because FR-035's requirement is conjunctive and a single "delivered"
 * boolean would report a half-delivered escalation as a whole one.
 */
export async function notify(
  adapters: ServiceAdapters,
  input: {
    readonly pullRequest: number;
    readonly runId: string;
    readonly cause: EscalationCause;
    readonly reason: string;
    readonly revision?: string;
  },
): Promise<void> {
  const result = await escalate(adapters.escalation, {
    target: adapters.target,
    pullRequest: input.pullRequest,
    runId: input.runId,
    channel: adapters.settings.settings.escalationChannel,
    reason: input.reason,
    cause: input.cause,
  });

  adapters.logger.warn("escalation.notified", {
    pullRequest: input.pullRequest,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    escalation: {
      reason: input.reason,
      channelDelivered: result.channelDelivered,
      statedOnPullRequest: result.statedOnPullRequest,
    },
  });
}

/**
 * Roughly four characters per token, the standard approximation for prose and code. Exact counting
 * needs an API round trip per review; this number only has to be close enough to refuse a run that
 * cannot afford itself, and being approximate is why the overhead below is generous rather than
 * measured.
 */
const CHARS_PER_TOKEN = 4;

/**
 * What a role's prompt carries besides the diff: the constitution, the role brief, the injection
 * guard, and any prior findings. Deliberately an over-estimate -- reserving slightly too much
 * refuses a review at the very edge of the budget, while reserving too little lets one run past it,
 * and only the second failure spends money it did not have.
 */
const PROMPT_OVERHEAD_TOKENS = 25_000;

/** What one role is expected to consume: its prompt, plus everything it may emit. */
export function estimateReviewTokens(diffLength: number, maxOutputTokens: number): number {
  return Math.ceil(diffLength / CHARS_PER_TOKEN) + PROMPT_OVERHEAD_TOKENS + maxOutputTokens;
}

async function stop(
  adapters: ServiceAdapters,
  pullRequest: number,
  runId: string,
  headSha: string,
  cause: EscalationCause,
  reason: string,
  gate: GateResult,
): Promise<ReviewOutcome> {
  adapters.logger.warn(CAUSE_EVENT[cause], { pullRequest, revision: headSha });

  adapters.logger.warn("run.concluded", {
    pullRequest,
    revision: headSha,
    gate: {
      conclusion: gate.conclusion,
      ...(gate.reason === undefined ? {} : { reason: gate.reason }),
    },
  });

  await notify(adapters, { pullRequest, runId, cause, reason, revision: headSha });

  return {
    runId,
    pullRequest,
    headSha,
    gate,
    findings: [],
    tokensConsumed: 0,
    stoppedBeforeSpending: true,
  };
}

/**
 * Reviews one named pull request end to end.
 *
 * The order of the checks is not arbitrary and is not this function's to choose: it is the
 * statechart in `review/machine.ts`, which data-model.md declares and `tests/integration/
 * review/machine.test.ts` asserts. Every stop below corresponds to one of its guarded exits, and
 * every stop ahead of `reviewing` spends zero model tokens — which is the whole of FR-051.
 */
export async function reviewPullRequest(
  adapters: ServiceAdapters,
  pullRequest: number,
  options: { readonly runId?: string; readonly now?: () => Date } = {},
): Promise<ReviewOutcome> {
  const runId = options.runId ?? adapters.logger.runId;
  const now = options.now ?? ((): Date => new Date());
  const { target, settings, logger } = adapters;
  const operating = settings.settings;

  const snapshot = await readPullRequest(adapters.pullRequests, target, pullRequest);
  const headSha = snapshot.headSha;

  logger.info("run.started", { pullRequest, revision: headSha, target: targetSlug(target) });

  // checkingPrerequisites — both verifications, ahead of everything that costs anything (FR-051).
  const protection: ProtectionOutcome = classifyProtectionResponse(
    ...(await (async (): Promise<[number, unknown]> => {
      const response = await adapters.branchProtection.getBranchProtection({
        owner: target.owner,
        repo: target.name,
        branch: snapshot.baseBranch,
      });

      return [response.status, response.body];
    })()),
  );

  const prerequisites = checkPrerequisites({
    granted: await adapters.permissions(),
    protection,
    gateName: MERGE_GATE_CHECK_NAME,
    baseBranch: snapshot.baseBranch,
    modelCredential: adapters.modelCredential,
  });

  if (!prerequisites.satisfied) {
    const reason = prerequisites.reason ?? "a startup prerequisite is not satisfied (FR-051)";

    return stop(adapters, pullRequest, runId, headSha, "prerequisites.missing", reason, {
      conclusion: "failure",
      reason,
    });
  }

  // checkingIdentity (FR-004). The reviewing identity is the App's own login, `<slug>[bot]`,
  // resolved from the installation rather than guessed from the repository's name — the two
  // coincide only by accident, and a check that compares the wrong pair never fires at all.
  const identity = checkSelfReview(snapshot.authorLogin, adapters.reviewingIdentity);
  if (identity.selfAuthored) {
    const reason = identity.reason ?? "this pull request is self-authored (FR-004)";

    return stop(adapters, pullRequest, runId, headSha, "identity.self_authored", reason, {
      conclusion: "failure",
      reason,
    });
  }

  // checkingProgress (FR-020, FR-046), read back from our own prior check runs (Principle VII).
  const priorRuns: readonly CheckRunSummary[] = await listGateRuns(
    adapters.checkRuns,
    target,
    headSha,
  );
  const baseline = baselineRound(priorRuns);

  // Read once and narrowed twice: `ownThreads` for reconciliation, and the raw threads for the
  // prior findings a role is shown, which need the marker's rule, severity, and anchor — fields
  // reconciliation has no use for and therefore does not carry.
  const rawThreads: readonly ReviewThread[] = await adapters.threads.listReviewThreads({
    owner: target.owner,
    repo: target.name,
    pullRequest,
  });
  const priorThreads = narrowOwnThreads(rawThreads);

  const progress = checkProgress({
    baseline,
    headSha,
    repliesSinceBaseline: priorThreads.flatMap((thread) =>
      thread.latestReplyAt === null
        ? []
        : [{ findingId: thread.findingId, at: thread.latestReplyAt }],
    ),
    maxReviewRounds: operating.maxReviewRounds,
  });

  if (progress.escalate) {
    const reason = progress.reason ?? "the review loop stopped (FR-020, FR-046)";
    const cause: EscalationCause = progress.roundCapExceeded
      ? "rounds.cap_exceeded"
      : "progress.no_forward_progress";

    return stop(adapters, pullRequest, runId, headSha, cause, reason, {
      conclusion: "failure",
      reason,
    });
  }

  // checkingSize (FR-037, FR-052). Both exits spend nothing and record no verdict.
  const diff = await readDiff(adapters.pullRequests, target, pullRequest);
  const empty = checkEmptyDiff(diff);

  if (empty.empty) {
    const reason = empty.reason ?? "there is nothing to review (FR-052)";

    return stop(adapters, pullRequest, runId, headSha, "diff.empty", reason, {
      conclusion: "failure",
      reason,
    });
  }

  const index = indexDiff(diff);

  // A binary file carries neither hunks nor line numbers, so `indexDiff` never sees one and
  // `changedPaths` cannot report it. Unioning git's own binary report in is what lets an excluded
  // binary be *recorded* as excluded rather than merely absent — and FR-053 requires the excluded
  // set to be visible, not just to have been left out of the count.
  const binaryPaths = binaryPathsFromDiff(diff);
  const excluded = resolveExcludedPaths({
    changedPaths: [...new Set([...changedPaths(index), ...binaryPaths])],
    binaryPaths,
    patterns: operating.excludedPathPatterns,
  });
  const changedLines = changedLineCount(index, excluded.paths);

  // Recorded on every run, including the runs that exclude nothing. FR-053 requires the excluded
  // set to be visible, and a record written only when it is non-empty makes "nothing was excluded"
  // and "the exclusion step never ran" the same observation.
  logger.info("paths.excluded", {
    pullRequest,
    revision: headSha,
    excludedPaths: {
      count: excluded.entries.length,
      paths: excluded.paths,
      source: excluded.entries.map((entry) => entry.source),
    },
  });

  const size = checkReviewableSize({
    changedLines,
    maxReviewableDiffSize: operating.maxReviewableDiffSize,
  });

  if (size.exceeds) {
    const reason = size.reason ?? "this diff is too large to review (FR-037)";

    return stop(adapters, pullRequest, runId, headSha, "size.exceeds_reviewable", reason, {
      conclusion: "failure",
      reason,
    });
  }

  // What a review may emit, and what it is expected to cost. They are different numbers and each
  // has been wrong once.
  //
  // `maxTokens` is the per-response ceiling: the model's own limit, nothing to do with budget.
  // Deriving it from `reviewerTokenReserve` asked for 1.25M output tokens and failed every call
  // before it was sent.
  //
  // The reservation is what the ledger is asked to authorise, and it must be what the work can
  // actually consume -- Principle IV checks a metered resource *before* the work that spends it,
  // which is only meaningful if the number checked resembles the bill. A slice of
  // `reviewerTokenReserve` did not: it reserved 1,250,000 per role for a review that spends tens
  // of thousands, so a run could be refused for failing to reserve millions it was never going to
  // use.
  //
  // Input dominates, and it is knowable here: the diff is already in hand. An observed run spent
  // roughly 58,000 tokens across two roles against a 16,000-token ceiling, almost all of it prompt.
  const maxTokens = MAX_OUTPUT_TOKENS;
  const reservation = estimateReviewTokens(diff.length, maxTokens);

  // checkingBudgets (FR-031, FR-047). One role's estimated cost, times the roles that run.
  const budget = adapters.ledger.check(
    targetSlug(target),
    "review",
    "tokens",
    reservation * operating.requiredReviewerRoles.length,
  );

  if (!budget.allowed) {
    return stop(adapters, pullRequest, runId, headSha, "budget.exhausted", budget.reason, {
      conclusion: "failure",
      reason: budget.reason,
    });
  }

  // waitingForReset (FR-040). The platform allowance is the one budget that does not hard-stop,
  // because it costs nothing and refills on a documented reset: failing a pull request over the
  // hour's requests would report a review result for a scheduling fact, and the author would have
  // to push a commit to clear a gate that would have cleared itself.
  //
  // Checked here, alongside the token budget and ahead of the first content-creating call, which
  // is what FR-040's "checked before it starts work that consumes it" asks for.
  const signals = await adapters.rateLimitSignals();

  if (signals !== null) {
    logger.info("budget.checked", {
      pullRequest,
      revision: headSha,
      usage: {
        platformRequestsRemaining: signals.remaining,
      },
    });
  }

  const allowance =
    signals === null
      ? ({ action: "proceed" } as const)
      : assess(
          signals,
          {
            platformApiReserve: operating.platformApiReserve,
            maxRateLimitWaitSeconds: operating.maxRateLimitWaitSeconds,
          },
          now(),
        );

  if (allowance.action === "wait") {
    // Unreported, not failed. Branch protection requires a check that has not reported, so the
    // pull request stays un-mergeable while the service waits — which is what FR-040 means by
    // "MUST NOT report the gate as success, neutral, or skipped at any point". The next run
    // resumes, and reconciliation is what keeps it from reposting what this one already posted.
    logger.info("platform.wait_started", { pullRequest, revision: headSha });

    const reason =
      `the platform allowance has reached its reserve of ${operating.platformApiReserve} ` +
      `requests; further calls stop and the service waits ${allowance.seconds}s for the ` +
      `documented reset rather than failing this pull request (FR-040)`;

    return stop(adapters, pullRequest, runId, headSha, "platform.rate_limit", reason, {
      conclusion: "unreported",
    });
  }

  if (allowance.action === "escalate") {
    // The one case FR-040 fails on: the wait itself is longer than the operator agreed to. A
    // service that waited anyway would be indistinguishable from one that had stopped.
    return stop(adapters, pullRequest, runId, headSha, "platform.rate_limit", allowance.reason, {
      conclusion: "failure",
      reason: allowance.reason,
    });
  }

  // reviewing. The gate is opened first so a crash mid-review leaves a visible in-progress check
  // rather than nothing at all.
  const gate = await openGate(adapters.checkRuns, target, headSha, now().toISOString());

  const constitution = readFileSync(
    resolveInTarget(target, ".specify", "memory", "constitution.md"),
    "utf8",
  );

  const priorFindings: readonly PriorFinding[] = rawThreads.flatMap((thread) => {
    const marker = readOwnMarker(thread);
    if (marker === null) return [];

    const location: FindingLocation =
      thread.path === null || thread.line === null
        ? { pullRequestLevel: true }
        : { path: thread.path, line: thread.line, side: "RIGHT" };

    return [
      {
        id: marker.id,
        role: marker.role,
        rule: marker.rule,
        severity: marker.severity,
        blocking: marker.blocking,
        location,
        // The body carries the rendered finding; the marker carries the identity. A role is shown
        // the reply history, which is what FR-044's judgement is about.
        description: thread.comments[0]?.body ?? "",
        replies: thread.comments.slice(1).map((comment) => comment.body),
      },
    ];
  });

  const pullRequestContext: PullRequestContext = {
    title: snapshot.title,
    body: snapshot.body,
    // The specs the pull request touches are the specs it claims to implement. Derived from the
    // diff rather than parsed out of the description, which an author can leave empty.
    specPaths: changedPaths(index).filter((path) => path.startsWith("specs/")),
  };

  const implementationRole = createImplementationRole({
    excludedPaths: excluded.paths,
    maxPullRequestSize: operating.maxPullRequestSize,
  });

  const roles = new Map<RoleName, () => Promise<RoleResult>>([
    [
      "security",
      () =>
        securityRole.review({
          runId,
          revision: headSha,
          effort: operating.modelEffort,
          diff,
          constitution,
          pullRequestContext: pullRequestContext,
          priorFindings,
          maxTokens,
          model: adapters.model,
        }),
    ],
    [
      "implementation",
      () =>
        implementationRole.review({
          runId,
          revision: headSha,
          effort: operating.modelEffort,
          diff,
          constitution,
          pullRequestContext: pullRequestContext,
          priorFindings,
          maxTokens,
          model: adapters.model,
        }),
    ],
  ]);

  const results: RoleResult[] = [];
  for (const role of operating.requiredReviewerRoles) {
    const run = roles.get(role);
    if (run === undefined) {
      throw new CompositionError(`no reviewer role is registered under ${JSON.stringify(role)}`);
    }

    results.push(await run());
  }

  for (const result of results) {
    if (isMissing(result.outcome)) {
      // Recorded as an explicit absence rather than left out. A role whose verdict is simply
      // missing from the stream is indistinguishable from a role that was never asked (FR-007).
      logger.error("role.verdict_missing", {
        pullRequest,
        revision: headSha,
        role: result.role,
      });
      continue;
    }

    logger.info("role.verdict", {
      pullRequest,
      revision: headSha,
      role: result.role,
      verdict: result.outcome.decision,
    });
  }

  const tokensConsumed = results.reduce((sum, result) => sum + result.tokensConsumed, 0);
  adapters.ledger.record({
    runId,
    at: now().toISOString(),
    actor: "review",
    resource: "tokens",
    amount: tokensConsumed,
  });

  const raised: Finding[] = results.flatMap((result) =>
    result.findings.map((draft) =>
      createFinding(
        { ...draft, location: resolveLocation(index, draft.location, excluded.paths) },
        operating.blockingSeverityThreshold,
      ),
    ),
  );

  const findingRecord = (finding: Finding): NonNullable<RecordFields["finding"]> => ({
    id: finding.id,
    severity: finding.severity,
    blocking: finding.blocking,
    ...(isPullRequestLevelLocation(finding.location)
      ? { pullRequestLevel: true }
      : { path: finding.location.path, line: finding.location.line }),
  });

  // judgingReplies (FR-044, FR-045). An author may answer a blocking finding by changing the code
  // or by justifying it; this is the second way. A rejected justification leaves the finding
  // exactly as it was, and an accepted one raises a waiver *request* rather than resolving
  // anything — the service never grants its own waiver, because a reviewer that can waive its own
  // findings is not a gate.
  //
  // The justification carried into the waiver is the author's newest reply on that thread. Newest
  // rather than first: an author who replies twice has restated their case, and the waiver a human
  // reads should be the one the author last stood behind.
  const judged = judgeReplies({
    findings: raised,
    judgements: results.flatMap((result) => result.replyJudgements),
    justifications: Object.fromEntries(
      priorThreads.flatMap((thread) => {
        const latest = thread.replies.at(-1);

        return latest === undefined ? [] : [[thread.findingId, latest] as const];
      }),
    ),
    revision: headSha,
  });

  const findings: readonly Finding[] = judged.findings;

  for (const waiver of judged.waiversRaised) {
    const finding = findings.find((candidate) => candidate.id === waiver.findingId);

    logger.warn("finding.waiver_requested", {
      pullRequest,
      revision: headSha,
      ...(finding === undefined ? {} : { role: finding.role, finding: findingRecord(finding) }),
    });
  }

  // reconciling (FR-039). Only the service's own threads are ever touched.
  const plan = reconcile({ priorThreads, currentFindings: findings, revision: headSha });
  await resolveThreads(
    adapters.threads,
    plan.toResolve.map((entry) => entry.threadId),
  );

  for (const finding of plan.toPost) {
    logger.info("finding.posted", {
      pullRequest,
      revision: headSha,
      role: finding.role,
      finding: findingRecord(finding),
    });
  }

  // Resolutions are recorded by finding rather than by thread: the thread id is a platform handle
  // that means nothing across rounds, while the fingerprint is the identity FR-039 reconciles on.
  for (const resolved of plan.toResolve) {
    logger.info("finding.resolved", {
      pullRequest,
      revision: headSha,
      finding: { id: resolved.findingId, severity: "low", blocking: false },
    });
  }

  const outcomes: readonly RoleOutcome[] = results.map((result) => result.outcome);

  for (const result of results) {
    const roleFindings = findings.filter((finding) => finding.role === result.role);
    const posted = plan.toPost.some((finding) => finding.role === result.role);

    if (!posted && roleFindings.length === 0) continue;

    await submitReview(
      adapters.reviews,
      target,
      pullRequest,
      buildRoleReview({
        role: result.role,
        decision: roleFindings.some((finding) => finding.blocking) ? "request-changes" : "approve",
        revision: headSha,
        findings: plan.toPost.filter((finding) => finding.role === result.role),
        summary: `The ${result.role} reviewer examined revision \`${headSha}\`.`,
      }),
    );
  }

  // Precedence (FR-048, FR-049), applied to the roles' own derived conclusions rather than to the
  // verdicts they stated: `gate.ts` already refuses to let a role assert `approve` over its own
  // standing blocking finding, and reading the stated verdict here would reintroduce exactly that.
  const gateFindings = findings.map((finding) => ({
    id: finding.id,
    role: finding.role,
    blocking: finding.blocking,
    status: finding.status,
  }));

  const precedence = resolvePrecedence({
    precedence: ROLE_PRECEDENCE,
    conclusions: operating.requiredReviewerRoles.map((role) => ({
      role,
      decision: deriveDecision(role, gateFindings),
      hasBlockingFinding: gateFindings.some(
        (finding) => finding.role === role && finding.blocking && finding.status === "open",
      ),
    })),
  });

  // Recorded, not escalated: precedence settled these, and a settled disagreement that left no
  // trace would be indistinguishable from one nobody noticed (FR-048).
  for (const contradiction of precedence.contradictions) {
    logger.warn("roles.contradiction_recorded", {
      pullRequest,
      revision: headSha,
      role: contradiction.prevailing,
    });
  }

  // A tie has no principled winner, so it is the one disagreement that stops for a human (FR-049).
  if (precedence.disagreement !== null) {
    logger.error("roles.disagreement_escalated", { pullRequest, revision: headSha });

    await notify(adapters, {
      pullRequest,
      runId,
      cause: "roles.disagreement",
      reason: precedence.disagreement.reason,
      revision: headSha,
    });
  }

  // reportingGate (FR-021, FR-024).
  const result = aggregate({
    requiredRoles: operating.requiredReviewerRoles,
    outcomes,
    findings: gateFindings,
    revision: headSha,
    concluded: true,
  });

  const round: RoundRecord = {
    roundNumber: nextRoundNumber(baseline),
    headSha,
    concluded: true,
    openBlockingFingerprints: findings
      .filter((finding) => finding.blocking && finding.status !== "resolved")
      .map((finding) => finding.id),
    concludedAt: now().toISOString(),
    tokensConsumed,
    budgetRemaining: adapters.ledger.remaining("tokens"),
    excludedPathCount: excluded.entries.length,
  };

  await reportGate(
    adapters.checkRuns,
    target,
    gate,
    result,
    now().toISOString(),
    buildGateOutput({
      result,
      round,
      effectiveOptionalSettings: settings.effectiveOptionalSettings,
    }),
  );

  logger.info("gate.reported", {
    pullRequest,
    revision: headSha,
    round: round.roundNumber,
    gate: {
      conclusion: result.conclusion,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    },
  });

  // Escalated after the gate is reported rather than before it: the waiver is a question for a
  // human, and the gate the human is being asked about has to already say what it says (FR-045,
  // FR-035).
  for (const waiver of judged.waiversRaised) {
    await notify(adapters, {
      pullRequest,
      runId,
      cause: "waiver.requested",
      reason:
        `finding ${waiver.findingId} is held by a waiver request: the reviewer accepted the ` +
        `author's justification, which does not resolve the finding — a waiver requires a ` +
        `recorded, human-approved reason (FR-045)`,
      revision: headSha,
    });
  }

  logger.info("run.concluded", {
    pullRequest,
    revision: headSha,
    gate: {
      conclusion: result.conclusion,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    },
    usage: { tokensConsumed, budgetRemaining: round.budgetRemaining },
  });

  return {
    runId,
    pullRequest,
    headSha,
    gate: result,
    findings,
    tokensConsumed,
    stoppedBeforeSpending: false,
  };
}
