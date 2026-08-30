import { randomUUID } from "node:crypto";

import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";

import { MERGE_GATE_CHECK_NAME, type CheckRunSummary } from "../../../src/github/check-run.js";
import { ownThreads, readOwnMarker, type ReviewThread } from "../../../src/github/threads.js";
import type { OwnThread } from "../../../src/review/reconcile.js";
import { parseRoundRecord, type RoundRecord } from "../../../src/review/round-history.js";
import { createTarget, type TargetRepository } from "../../../src/config/target.js";

import { HarnessError, statusOf, type FixtureEnvironment } from "./environment.js";

/**
 * The fixture-repository client (tasks.md T032, research.md R-015).
 *
 * Two identities, deliberately not one. Branches, commits, pull requests, and author replies are
 * written with a **user** token; check runs and escalation issues are read with the **App's**
 * installation token. Collapsing them would quietly break two scenarios at once: a pull request
 * authored by the reviewing identity trips FR-004 on every scenario that is not scenario 18, and
 * scenario 19's whole assertion is that a user token *cannot* write a check run.
 *
 * Revisions are pushed through the Git Data API rather than by shelling out to `git`. The service
 * itself clones the fixture (`withWorktree`) and must see a real remote, but the harness writing
 * the revision has no reason to keep a working tree of its own — and a `git push` would need the
 * token on a command line or in a credential helper, which is exactly where FR-032 says it must
 * not go.
 *
 * Everything created is recorded and torn down. A fixture that accumulates a branch per run
 * becomes unreadable within a week, and the leftover pull requests are indistinguishable, to the
 * next run's reconciliation, from work waiting to be reviewed.
 */

/** A file written into a fixture revision. `base64` is how scenario 29 seeds its git-binary file. */
export interface FixtureFile {
  readonly path: string;
  readonly content: string;
  readonly encoding?: "utf-8" | "base64";
}

export interface FixturePullRequest {
  readonly number: number;
  readonly branch: string;
  readonly baseBranch: string;
  /** The revision at the head of the branch. FR-009 binds every verdict to one of these. */
  readonly headSha: string;
}

export interface OpenPullRequestOptions {
  /** Defaults to the gated base branch. Scenario 26 passes the ungated one instead. */
  readonly baseBranch?: string;
  readonly files: readonly FixtureFile[];
  readonly title: string;
  /** The description. Scenarios 5 and 6 differ only in whether it carries a justification. */
  readonly body?: string;
  readonly commitMessage?: string;
  /** Appears in the branch name, so a leftover branch says which scenario left it. */
  readonly label?: string;
  /**
   * Which identity opens it. Defaults to the authoring user, because a pull request opened by the
   * App trips FR-004's self-review refusal and no scenario but 18 wants that.
   */
  readonly openedBy?: "author" | "app";
}

export interface GateRunWait {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/** An escalation issue, matched by the service's own cause marker rather than by its title. */
export interface EscalationRecord {
  readonly number: number;
  readonly body: string;
  readonly labels: readonly string[];
  /**
   * The cause the service recorded in its own marker, or `null` when the marker is unreadable.
   *
   * Parsed here rather than left to each scenario, so a test asserts on a structural field the
   * service chose from a closed set rather than on the prose around it. The distinction matters:
   * the issue body is partly a rendering of a model-authored reason, and an assertion on that text
   * would break when the wording changed rather than when the behavior did (FR-030, SC-010).
   */
  readonly cause: string | null;
}

/**
 * One of the service's own posted findings, read back from the pull request.
 *
 * `readOwnThreads` answers reconciliation's question — which threads are ours — and carries no
 * anchor, because reconciliation has no use for one. Scenarios do: FR-010 is a claim about *where*
 * a finding was posted, and FR-014 is a claim about a finding that has no line at all. So this
 * carries the marker's identity fields alongside the thread's anchor, and no prose whatsoever.
 */
export interface PostedFinding {
  readonly threadId: string;
  readonly findingId: string;
  readonly role: string;
  readonly rule: string;
  readonly severity: string;
  readonly blocking: boolean;
  readonly isResolved: boolean;
  /** `null` for a finding recorded at pull-request level rather than anchored (FR-014). */
  readonly path: string | null;
  readonly line: number | null;
  readonly replyCount: number;
}

export interface CreatedResources {
  readonly branches: string[];
  readonly pullRequests: number[];
}

export interface FixtureClient {
  readonly environment: FixtureEnvironment;
  /** The authoring client: branches, commits, pull requests, replies. Never writes a check run. */
  readonly author: Octokit;
  /** An App-authenticated client on a fresh installation token. Reads checks and issues. */
  asApp(): Promise<Octokit>;

  openPullRequest(options: OpenPullRequestOptions): Promise<FixturePullRequest>;
  pushRevision(
    pullRequest: FixturePullRequest,
    files: readonly FixtureFile[],
    message?: string,
  ): Promise<FixturePullRequest>;

  /**
   * A file as the base branch currently has it.
   *
   * Every scenario diff is an *edit* of the fixture's files rather than a wholesale rewrite, and an
   * edit needs the original. Embedding copies in the scenarios instead would make each one a second
   * copy of the fixture that silently rots the moment the fixture is reseeded — and a scenario
   * whose "one-line change" had quietly become a whole-file rewrite would trip the size rules it
   * was never about.
   */
  readBaseFile(path: string, baseBranch?: string): Promise<string>;

  listGateRuns(headSha: string): Promise<readonly CheckRunSummary[]>;
  /** Waits for a gate run on this revision to conclude, or fails saying what it saw instead. */
  awaitGateConclusion(headSha: string, wait?: GateRunWait): Promise<CheckRunSummary>;
  /** Waits for *no* gate run to have concluded after a settling period — scenarios 17 and 24. */
  expectGateUnreported(headSha: string, settleMs?: number): Promise<readonly CheckRunSummary[]>;
  /** The round record the gate run wrote into its output, which the next round reads back. */
  readRoundRecord(headSha: string): Promise<RoundRecord | null>;

  readOwnThreads(pullRequest: number): Promise<readonly OwnThread[]>;
  /** The service's own findings with their anchors — what FR-010 and FR-014 are claims about. */
  readOwnFindings(pullRequest: number): Promise<readonly PostedFinding[]>;
  replyToThread(threadId: string, body: string): Promise<void>;

  /**
   * Closes one pull request ahead of teardown.
   *
   * Only the daemon scenarios need it, and they need it for a reason no single-review scenario
   * has: `runDaemon` reconciles *every* open pull request on the fixture, so a pull request left
   * open by an earlier test in the same file is work the daemon will pick up and review. Closing
   * it is how a daemon scenario is scoped to its own pull request.
   */
  closePullRequest(pullRequest: number): Promise<void>;

  /**
   * The states of the reviews on the pull request, newest last. `APPROVED` and `CHANGES_REQUESTED`
   * are GitHub's own words for the two verdicts FR-006 permits, so this is the platform's record
   * of what each role decided rather than the service's account of it.
   */
  readReviewStates(pullRequest: number): Promise<readonly string[]>;

  readEscalations(pullRequest: number): Promise<readonly EscalationRecord[]>;
  /** Just the causes, which is what every scenario asserting on an escalation actually asks. */
  readEscalationCauses(pullRequest: number): Promise<readonly string[]>;
  /**
   * Waits for an escalation with this cause, on both surfaces FR-035 requires.
   *
   * A plain read is not enough for a *positive* assertion. GitHub serves the issue listing from a
   * replica that trails the write by a second or two, so a scenario reading immediately after a run
   * concluded intermittently sees an escalation the service has already filed — observed failing
   * exactly that way. The wait is on the platform catching up with a write that already happened,
   * never on the service getting round to something: nothing here polls for a decision the service
   * has not yet made.
   */
  awaitEscalation(
    pullRequest: number,
    cause: string,
    wait?: GateRunWait,
  ): Promise<{ issue: EscalationRecord; statedOnPullRequest: boolean }>;
  readPullRequestComments(pullRequest: number): Promise<readonly string[]>;
  /**
   * The causes the service stated *on the pull request*. FR-035 requires both surfaces and forbids
   * substituting one for the other, so a scenario has to be able to read them apart.
   */
  readPullRequestEscalationCauses(pullRequest: number): Promise<readonly string[]>;

  /**
   * What GitHub answers when the *authoring* identity tries to report the gate — quickstart
   * scenario 19. The refusal is structural: check runs are writable only by an App installation,
   * so no scope on a user token changes the answer.
   */
  attemptGateReportAsAuthor(headSha: string): Promise<{ status: number; message: string }>;

  /** The service's target handle, addressed at a checkout the caller provisioned (FR-026). */
  target(checkoutPath: string): TargetRepository;

  readonly created: CreatedResources;
  teardown(): Promise<void>;
}

/**
 * The harness's own thread query. It asks for what the service's asks for and is deliberately a
 * separate string: the service may narrow its query to what it needs, and the harness reading less
 * than it asserts on would be a silent hole.
 */
const HARNESS_REVIEW_THREADS = `
  query HarnessReviewThreads($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            path
            line
            comments(first: 100) {
              nodes { body createdAt author { login } }
            }
          }
        }
      }
    }
  }
`;

const REPLY_TO_THREAD = `
  mutation HarnessReply($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(
      input: { pullRequestReviewThreadId: $threadId, body: $body }
    ) {
      comment { id }
    }
  }
`;

interface ThreadsQueryResult {
  readonly repository: {
    readonly pullRequest: {
      readonly reviewThreads: {
        readonly nodes: readonly {
          readonly id: string;
          readonly isResolved: boolean;
          readonly path: string | null;
          readonly line: number | null;
          readonly comments: {
            readonly nodes: readonly {
              readonly body: string;
              readonly createdAt: string;
              readonly author: { readonly login: string } | null;
            }[];
          };
        }[];
      };
    };
  };
}

/** A run tag, so a branch left behind by a crash says which run left it and when. */
function branchName(label: string | undefined): string {
  const slug = (label ?? "scenario").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  const tag = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;

  return `e2e/${slug === "" ? "scenario" : slug}/${tag}`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The cause out of the service's own escalation marker.
 *
 * Read from the marker rather than from the surrounding prose because the marker is the identity
 * R-012 deduplicates on: it is a value the service chose from a closed set, so an assertion on it
 * is an assertion about behavior. The prose beside it renders a reason that may be model-authored.
 */
function escalationCauseOf(body: string): string | null {
  const match = /independent-review-escalation:\s*(\{[\s\S]*?\})/u.exec(body);
  if (match?.[1] === undefined) return null;

  try {
    const parsed = JSON.parse(match[1]) as { cause?: unknown };

    return typeof parsed.cause === "string" ? parsed.cause : null;
  } catch {
    return null;
  }
}

/**
 * The cause out of an escalation comment on the pull request. The comment carries no HTML marker —
 * it is written for a human — so the cause is read from the one field of it the service renders
 * verbatim from the same closed set.
 */
function commentCauseOf(body: string): string | null {
  const match = /Cause:\s*`([a-z0-9_.]+)`/u.exec(body);

  return match?.[1] ?? null;
}

function messageOf(body: unknown): string {
  if (body !== null && typeof body === "object" && "message" in body) {
    const { message } = body;
    if (typeof message === "string") return message;
  }

  return "";
}

function toSummary(run: {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
  output: { title?: string | null; text?: string | null };
}): CheckRunSummary {
  return {
    id: run.id,
    name: run.name,
    headSha: run.head_sha,
    status: run.status as CheckRunSummary["status"],
    conclusion: run.conclusion,
    completedAt: run.completed_at,
    output: { title: run.output.title ?? null, text: run.output.text ?? null },
  };
}

export function createFixtureClient(environment: FixtureEnvironment): FixtureClient {
  const { owner, name: repo } = environment.repository;

  const author = new Octokit({ auth: environment.authorToken });
  const created: CreatedResources = { branches: [], pullRequests: [] };

  // Minted per call rather than captured. An installation token lasts an hour and one e2e file can
  // outlive one, so a client built once would 401 partway through a long scenario; the provider
  // behind `installationToken` caches until the token nears expiry, so this costs nothing.
  const asApp = async (): Promise<Octokit> =>
    new Octokit({ auth: (await environment.installationToken()).token });

  async function graphqlAsApp<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const { token } = await environment.installationToken();

    return graphql<T>(query, { ...variables, headers: { authorization: `token ${token}` } });
  }

  async function rawThreads(pullRequest: number): Promise<ReviewThread[]> {
    const result = await graphqlAsApp<ThreadsQueryResult>(HARNESS_REVIEW_THREADS, {
      owner,
      repo,
      number: pullRequest,
    });

    return result.repository.pullRequest.reviewThreads.nodes.map((node) => ({
      id: node.id,
      isResolved: node.isResolved,
      path: node.path,
      line: node.line,
      comments: node.comments.nodes.map((comment) => ({
        body: comment.body,
        createdAt: comment.createdAt,
        authorLogin: comment.author?.login ?? null,
      })),
    }));
  }

  async function writeBlobs(
    as: Octokit,
    files: readonly FixtureFile[],
  ): Promise<{ path: string; sha: string }[]> {
    const blobs: { path: string; sha: string }[] = [];

    for (const file of files) {
      const { data } = await as.rest.git.createBlob({
        owner,
        repo,
        content: file.content,
        encoding: file.encoding ?? "utf-8",
      });

      blobs.push({ path: file.path, sha: data.sha });
    }

    return blobs;
  }

  /**
   * One commit on top of `parentSha`, returning the new revision.
   *
   * `as` is the identity the commit — and therefore the pull request built on it — is attributed
   * to. Ordinarily the author; scenario 18 passes the App, because the only honest way to produce
   * a self-authored pull request is to have the reviewing identity author one.
   */
  async function commitOnto(
    as: Octokit,
    parentSha: string,
    files: readonly FixtureFile[],
    message: string,
  ): Promise<string> {
    if (files.length === 0) {
      throw new HarnessError(
        "a fixture revision needs at least one file. Scenario 27's empty diff is produced by a " +
          "whitespace-only change, not by an empty tree, which git will not record at all.",
      );
    }

    const parent = await as.rest.git.getCommit({ owner, repo, commit_sha: parentSha });
    const blobs = await writeBlobs(as, files);

    const { data: tree } = await as.rest.git.createTree({
      owner,
      repo,
      base_tree: parent.data.tree.sha,
      tree: blobs.map((blob) => ({
        path: blob.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha,
      })),
    });

    const { data: commit } = await as.rest.git.createCommit({
      owner,
      repo,
      message,
      tree: tree.sha,
      parents: [parentSha],
    });

    return commit.sha;
  }

  async function headOf(branch: string): Promise<string> {
    const { data } = await author.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });

    return data.object.sha;
  }

  /**
   * Waits until the pull request itself reports the revision the branch already points at.
   *
   * Updating a ref takes effect immediately; the pull request's `head.sha` is derived from it and
   * lags by a moment. Every scenario that pushes a revision and then reviews it — 7, 8, and the
   * staleness pair — reads the pull request rather than the ref, so without this wait they race
   * GitHub and review the revision they just replaced. Observed failing before it was added.
   *
   * The wait is on the *fixture's* consistency, not on the service: nothing here polls for a
   * result the service is meant to produce.
   */
  async function awaitPullRequestHead(
    pullRequest: number,
    headSha: string,
    timeoutMs = 30_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const { data } = await author.rest.pulls.get({ owner, repo, pull_number: pullRequest });
      if (data.head.sha === headSha) return;

      if (Date.now() >= deadline) {
        throw new HarnessError(
          `pull request #${pullRequest} still reports head ${data.head.sha} ${timeoutMs}ms after ` +
            `its branch was moved to ${headSha}`,
        );
      }

      await sleep(500);
    }
  }

  async function listGateRuns(headSha: string): Promise<readonly CheckRunSummary[]> {
    const app = await asApp();
    const { data } = await app.rest.checks.listForRef({
      owner,
      repo,
      ref: headSha,
      check_name: MERGE_GATE_CHECK_NAME,
    });

    return data.check_runs.map(toSummary);
  }

  return {
    environment,
    author,
    asApp,
    created,
    listGateRuns,

    async readBaseFile(path, baseBranch): Promise<string> {
      const { data } = await author.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: baseBranch ?? environment.gatedBaseBranch,
      });

      if (Array.isArray(data) || data.type !== "file") {
        throw new HarnessError(
          `${path} is not a file on ${baseBranch ?? environment.gatedBaseBranch}`,
        );
      }

      return Buffer.from(data.content, "base64").toString("utf8");
    },

    async openPullRequest(options): Promise<FixturePullRequest> {
      const baseBranch = options.baseBranch ?? environment.gatedBaseBranch;
      const branch = branchName(options.label);
      const baseSha = await headOf(baseBranch);

      // One identity for the whole sequence — ref, commit, and pull request — because a pull
      // request's author is whoever opened it, and a commit pushed by one identity under a pull
      // request opened by another would make scenario 18's premise ambiguous.
      const as = options.openedBy === "app" ? await asApp() : author;

      await as.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
      created.branches.push(branch);

      const headSha = await commitOnto(
        as,
        baseSha,
        options.files,
        options.commitMessage ?? options.title,
      );
      await as.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: headSha });

      const { data } = await as.rest.pulls.create({
        owner,
        repo,
        head: branch,
        base: baseBranch,
        title: options.title,
        ...(options.body === undefined ? {} : { body: options.body }),
      });
      created.pullRequests.push(data.number);

      return { number: data.number, branch, baseBranch, headSha };
    },

    async pushRevision(pullRequest, files, message): Promise<FixturePullRequest> {
      const parentSha = await headOf(pullRequest.branch);
      const headSha = await commitOnto(author, parentSha, files, message ?? "revise");

      await author.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${pullRequest.branch}`,
        sha: headSha,
      });

      await awaitPullRequestHead(pullRequest.number, headSha);

      return { ...pullRequest, headSha };
    },

    async awaitGateConclusion(headSha, wait = {}): Promise<CheckRunSummary> {
      const timeoutMs = wait.timeoutMs ?? 300_000;
      const intervalMs = wait.intervalMs ?? 2_000;
      const deadline = Date.now() + timeoutMs;

      for (;;) {
        const runs = await listGateRuns(headSha);
        const concluded = runs.find((run) => run.status === "completed");
        if (concluded !== undefined) return concluded;

        if (Date.now() >= deadline) {
          throw new HarnessError(
            `no ${MERGE_GATE_CHECK_NAME} run concluded on ${headSha} within ${timeoutMs}ms; ` +
              `${runs.length} run(s) present with status ` +
              `${runs.map((run) => run.status).join(", ") || "(none)"}`,
          );
        }

        await sleep(intervalMs);
      }
    },

    async expectGateUnreported(headSha, settleMs = 10_000): Promise<readonly CheckRunSummary[]> {
      // Waiting *then* reading, rather than reading immediately: "the gate stays unreported" is a
      // claim about a period, and a single read taken the instant after a pause began would pass
      // even if the service reported a conclusion a second later.
      await sleep(settleMs);

      const runs = await listGateRuns(headSha);
      const concluded = runs.filter((run) => run.status === "completed");

      if (concluded.length > 0) {
        throw new HarnessError(
          `${MERGE_GATE_CHECK_NAME} concluded on ${headSha} while the gate was required to stay ` +
            `unreported: ${concluded.map((run) => run.conclusion ?? "null").join(", ")}`,
        );
      }

      return runs;
    },

    async readRoundRecord(headSha): Promise<RoundRecord | null> {
      for (const run of await listGateRuns(headSha)) {
        const record = parseRoundRecord(run.output.text);
        if (record !== null) return record;
      }

      return null;
    },

    async readOwnThreads(pullRequest): Promise<readonly OwnThread[]> {
      // The service's own narrowing, not a second one: which threads are ours is a question with
      // exactly one answer, and a harness that re-read the marker itself could assert a resolution
      // the service would never have made (FR-015).
      return ownThreads(await rawThreads(pullRequest));
    },

    async readOwnFindings(pullRequest): Promise<readonly PostedFinding[]> {
      const threads = await rawThreads(pullRequest);

      // `ownThreads` decides which threads are ours; this only joins the anchor back on, keyed by
      // thread id. Deciding ownership a second time here is exactly the duplication FR-015 warns
      // about, so it is a lookup rather than a second marker read.
      const anchors = new Map(threads.map((thread) => [thread.id, thread]));

      return ownThreads(threads).flatMap((own) => {
        const thread = anchors.get(own.threadId);
        const marker = thread === undefined ? null : readOwnMarker(thread);
        if (thread === undefined || marker === null) return [];

        return [
          {
            threadId: own.threadId,
            findingId: own.findingId,
            role: marker.role,
            rule: marker.rule,
            severity: marker.severity,
            blocking: marker.blocking,
            isResolved: own.isResolved,
            path: thread.path,
            line: thread.line,
            replyCount: own.replies.length,
          },
        ];
      });
    },

    async closePullRequest(pullRequest): Promise<void> {
      await author.rest.pulls.update({ owner, repo, pull_number: pullRequest, state: "closed" });
    },

    async replyToThread(threadId, body): Promise<void> {
      // As the author. A reply is what FR-046 counts as forward progress, and progress made by the
      // reviewing identity would not be progress at all.
      await graphql<unknown>(REPLY_TO_THREAD, {
        threadId,
        body,
        headers: { authorization: `token ${environment.authorToken}` },
      });
    },

    async readReviewStates(pullRequest): Promise<readonly string[]> {
      const app = await asApp();
      const { data } = await app.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pullRequest,
        per_page: 100,
      });

      return data.map((review) => review.state);
    },

    async readEscalations(pullRequest): Promise<readonly EscalationRecord[]> {
      const app = await asApp();
      const { data } = await app.rest.issues.listForRepo({
        owner,
        repo,
        state: "all",
        per_page: 100,
      });

      // Matched on the cause marker the service embeds, never on the title: the title is prose and
      // may be reworded, while the marker is the identity R-012 deduplicates on.
      const marker = `"pullRequest":${pullRequest}`;

      return data
        .filter((issue) => issue.pull_request === undefined)
        .filter(
          (issue) =>
            typeof issue.body === "string" &&
            issue.body.includes("independent-review-escalation:") &&
            issue.body.includes(marker),
        )
        .map((issue) => ({
          number: issue.number,
          body: issue.body ?? "",
          labels: issue.labels.map((label) =>
            typeof label === "string" ? label : (label.name ?? ""),
          ),
          cause: escalationCauseOf(issue.body ?? ""),
        }));
    },

    async awaitEscalation(
      pullRequest,
      cause,
      wait = {},
    ): Promise<{ issue: EscalationRecord; statedOnPullRequest: boolean }> {
      const timeoutMs = wait.timeoutMs ?? 60_000;
      const intervalMs = wait.intervalMs ?? 2_000;
      const deadline = Date.now() + timeoutMs;

      for (;;) {
        const issues = await this.readEscalations(pullRequest);
        const issue = issues.find((record) => record.cause === cause);

        if (issue !== undefined) {
          const stated = await this.readPullRequestEscalationCauses(pullRequest);

          // Both surfaces are reported together rather than waited on separately, so a scenario
          // can assert FR-035's conjunction instead of two independent facts.
          return { issue, statedOnPullRequest: stated.includes(cause) };
        }

        if (Date.now() >= deadline) {
          throw new HarnessError(
            `no escalation with cause ${JSON.stringify(cause)} on #${pullRequest} within ` +
              `${timeoutMs}ms; ${issues.length} escalation issue(s) present with cause(s) ` +
              `${issues.map((record) => record.cause ?? "(unreadable)").join(", ") || "(none)"}`,
          );
        }

        await sleep(intervalMs);
      }
    },

    async readEscalationCauses(pullRequest): Promise<readonly string[]> {
      return (await this.readEscalations(pullRequest)).flatMap((record) =>
        record.cause === null ? [] : [record.cause],
      );
    },

    async readPullRequestComments(pullRequest): Promise<readonly string[]> {
      const app = await asApp();
      const { data } = await app.rest.issues.listComments({
        owner,
        repo,
        issue_number: pullRequest,
        per_page: 100,
      });

      return data.map((comment) => comment.body ?? "");
    },

    async readPullRequestEscalationCauses(pullRequest): Promise<readonly string[]> {
      return (await this.readPullRequestComments(pullRequest)).flatMap((body) => {
        const cause = commentCauseOf(body);

        return cause === null ? [] : [cause];
      });
    },

    async attemptGateReportAsAuthor(headSha): Promise<{ status: number; message: string }> {
      // The refusal is the result being measured, so it comes back as a status rather than as a
      // thrown error the caller would have to unwrap.
      const response = await statusOf(() =>
        author.request("POST /repos/{owner}/{repo}/check-runs", {
          owner,
          repo,
          name: MERGE_GATE_CHECK_NAME,
          head_sha: headSha,
          status: "completed",
          conclusion: "success",
        }),
      );

      return { status: response.status, message: messageOf(response.data) };
    },

    target(checkoutPath): TargetRepository {
      return createTarget({ owner, name: repo, checkoutPath });
    },

    async teardown(): Promise<void> {
      // Pull requests first: a branch deleted out from under an open pull request leaves the pull
      // request in a state nothing can reopen.
      for (const number of created.pullRequests) {
        try {
          await author.rest.pulls.update({ owner, repo, pull_number: number, state: "closed" });
        } catch {
          // Best effort throughout. A teardown error must never replace the scenario's own
          // failure — the leftover is visible in the fixture, the lost failure would not be.
        }
      }

      for (const branch of created.branches) {
        try {
          await author.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
        } catch {
          // As above.
        }
      }

      created.pullRequests.length = 0;
      created.branches.length = 0;
    },
  };
}
