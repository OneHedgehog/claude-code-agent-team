import type { EscalationChannel } from "../config/settings.js";
import type { TargetRepository } from "../config/target.js";

/**
 * Escalation (FR-035, research.md R-012).
 *
 * Principle VII prohibits silent halting: "an unattended system that stops without saying so is
 * indistinguishable from one still working." FR-035 turns that into two obligations that look like
 * one and are not — notify through the configured channel, *and* state the reason on the pull
 * request — with neither ever substituted for the other. An issue filed without a word on the pull
 * request leaves the author guessing why the gate failed; a pull request comment nobody watches is
 * not a notification.
 *
 * Delivery failures are reported rather than thrown. An escalation is already the unhappy path,
 * and a throw here would replace a stated reason with a stack trace at the exact moment somebody
 * needs the reason.
 */

/** Causes that deduplicate against each other on the same pull request (R-012). */
export type EscalationCause =
  | "settings.invalid"
  | "prerequisites.missing"
  | "identity.self_authored"
  | "progress.no_forward_progress"
  | "rounds.cap_exceeded"
  | "diff.empty"
  | "size.exceeds_reviewable"
  | "budget.exhausted"
  | "platform.rate_limit"
  | "queue.wait_exceeded"
  | "roles.disagreement"
  | "waiver.requested"
  | "ledger.mismatch"
  | "error.unhandled";

export interface EscalationIssue {
  readonly number: number;
  readonly body: string;
}

/**
 * The platform surfaces escalation touches, narrowed so the escalation logic is testable without
 * a network and so a later channel (Slack, a desktop notification) is an adapter rather than a
 * rewrite.
 */
export interface EscalationSurfaces {
  findEscalationIssue(params: {
    owner: string;
    repo: string;
    pullRequest: number;
    cause: EscalationCause;
    label: string;
  }): Promise<EscalationIssue | null>;

  createIssue(params: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    assignee: string;
    labels: readonly string[];
  }): Promise<{ number: number }>;

  updateIssue(params: {
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<void>;

  commentOnPullRequest(params: {
    owner: string;
    repo: string;
    pullRequest: number;
    body: string;
  }): Promise<void>;
}

export interface EscalationInput {
  readonly target: TargetRepository;
  readonly pullRequest: number;
  readonly runId: string;
  readonly channel: EscalationChannel;
  readonly reason: string;
  readonly cause: EscalationCause;
}

export interface EscalationResult {
  readonly channelDelivered: boolean;
  readonly statedOnPullRequest: boolean;
  /** True only when both surfaces received it — FR-035 requires both, not either. */
  readonly delivered: boolean;
}

/** Ties an issue to one pull request and one cause, so a recurrence updates rather than duplicates. */
function causeMarker(pullRequest: number, cause: EscalationCause): string {
  return `<!-- independent-review-escalation: ${JSON.stringify({ pullRequest, cause })} -->`;
}

function issueBody(input: EscalationInput): string {
  return [
    causeMarker(input.pullRequest, input.cause),
    "",
    `The independent review service stopped on #${input.pullRequest} and needs a human.`,
    "",
    `**Reason.** ${input.reason}`,
    "",
    `**Cause.** \`${input.cause}\``,
    `**Run.** \`${input.runId}\``,
    "",
    "The branch, its checkouts, and the full comment history are left intact for inspection.",
  ].join("\n");
}

function pullRequestBody(input: EscalationInput): string {
  return [
    `**Independent review escalated to a human.**`,
    "",
    input.reason,
    "",
    `Cause: \`${input.cause}\` · Run: \`${input.runId}\``,
  ].join("\n");
}

/**
 * Runs one delivery attempt and reports whether it landed. Failures are swallowed deliberately:
 * an escalation is already the unhappy path, and throwing here would replace a stated reason with
 * a stack trace at the exact moment somebody needs the reason. Crucially, it also keeps a failure
 * on one surface from skipping the other — which is the substitution FR-035 forbids.
 */
async function attempt(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch {
    return false;
  }
}

export async function escalate(
  surfaces: EscalationSurfaces,
  input: EscalationInput,
): Promise<EscalationResult> {
  const { target, pullRequest, channel } = input;
  const owner = target.owner;
  const repo = target.name;

  const channelDelivered = await attempt(async () => {
    const existing = await surfaces.findEscalationIssue({
      owner,
      repo,
      pullRequest,
      cause: input.cause,
      label: channel.label,
    });

    if (existing === null) {
      return surfaces.createIssue({
        owner,
        repo,
        title: `Independent review escalation: ${input.cause} on #${pullRequest}`,
        body: issueBody(input),
        assignee: channel.assignee,
        labels: [channel.label],
      });
    }

    // R-012: a recurring cause on the same pull request updates its issue rather than filing a
    // second one, so the escalation label stays a list of open problems.
    return surfaces.updateIssue({
      owner,
      repo,
      issueNumber: existing.number,
      body: issueBody(input),
    });
  });

  const statedOnPullRequest = await attempt(() =>
    surfaces.commentOnPullRequest({
      owner,
      repo,
      pullRequest,
      body: pullRequestBody(input),
    }),
  );

  return {
    channelDelivered,
    statedOnPullRequest,
    delivered: channelDelivered && statedOnPullRequest,
  };
}
