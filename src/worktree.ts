import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { TargetRepository } from "./config/target.js";

/**
 * Working-tree provisioning (research.md R-017).
 *
 * `actions/checkout` used to do this. The service now does it itself: one bare mirror per target,
 * a `git fetch` of the pull request head, a detached worktree per review, removed afterwards.
 *
 * What this module does *not* do is the part that matters. R-013's design ran `npm ci` and
 * `npm run build` against the pull request's own code on the host, which is exactly why the old
 * workflow needed the `head.repo.full_name == github.repository` guard and why fork pull requests
 * were excluded from review. Nothing here executes anything the tree contains: the reviewed code is
 * read as data — a diff and a file listing — and the only program this module runs is `git`, with
 * arguments this module chose. That is what makes removing the fork exclusion safe rather than
 * merely convenient.
 *
 * Every command is passed as an argv array and never as a command string, so a branch name, a path,
 * or a repository name containing shell metacharacters is inert rather than interesting.
 */

export class WorktreeError extends Error {
  override readonly name = "WorktreeError";
}

export interface GitCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

export type GitRunner = (command: GitCommand) => Promise<string>;

const execFileAsync = promisify(execFile);

/** The default runner: `execFile`, which takes an argv array and never involves a shell. */
export const runGit: GitRunner = async (command) => {
  try {
    const { stdout } = await execFileAsync(command.program, [...command.args], {
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      encoding: "utf8",
    });

    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new WorktreeError(
      `\`${command.program} ${command.args.join(" ")}\` failed: ${stderr.trim() || String(error)}`,
    );
  }
};

/** Where the mirrors and worktrees live when the caller does not say (R-017). */
export function defaultCacheDirectory(env: Record<string, string | undefined>): string {
  return join(env["HOME"] ?? homedir(), ".cache", "review-service");
}

/** One flat name per target, so a mirror is findable by eye in the cache directory. */
function targetSlug(target: TargetRepository): string {
  return `${target.owner}__${target.name}`;
}

export function mirrorDirectory(cacheDirectory: string, target: TargetRepository): string {
  return join(cacheDirectory, "mirrors", `${targetSlug(target)}.git`);
}

/** A worktree per review rather than one shared tree: two reviews may run at once (FR-041). */
export function worktreeDirectory(
  cacheDirectory: string,
  target: TargetRepository,
  id: string,
): string {
  return join(cacheDirectory, "worktrees", targetSlug(target), id);
}

/** Where GitHub publishes a pull request's head, including one from a fork. */
export function pullRequestHeadRef(pullRequest: number): string {
  return `refs/pull/${pullRequest}/head`;
}

export interface Worktree {
  readonly path: string;
  readonly headSha: string;
}

export interface WorktreeOptions {
  readonly target: TargetRepository;
  /** The URL the mirror is cloned from, carrying whatever credential the caller authenticated with. */
  readonly remoteUrl: string;
  readonly pullRequest: number;
  /** The exact revision under review; the worktree is detached at it (FR-009). */
  readonly headSha: string;
  readonly cacheDirectory: string;
  /** Distinguishes concurrent reviews of the same target. */
  readonly id?: string;
  readonly git?: GitRunner;
  /** Observes every command issued, so a test can assert what is *not* run. */
  readonly onCommand?: (command: GitCommand) => void;
}

/**
 * Runs work against a detached worktree at the revision under review, and removes the worktree on
 * both the success and the failure path. The failure is re-thrown: the tree is cleaned up because
 * the review stopped, not because it succeeded.
 */
export async function withWorktree<T>(
  options: WorktreeOptions,
  work: (tree: Worktree) => Promise<T>,
): Promise<T> {
  const git = options.git ?? runGit;
  const observe = options.onCommand;

  const run = async (args: readonly string[], cwd?: string): Promise<string> => {
    const command: GitCommand = { program: "git", args, ...(cwd === undefined ? {} : { cwd }) };
    observe?.(command);

    return git(command);
  };

  const mirror = mirrorDirectory(options.cacheDirectory, options.target);
  const treePath = worktreeDirectory(
    options.cacheDirectory,
    options.target,
    options.id ?? randomUUID(),
  );

  // A mirror is kept across reviews. Re-cloning per review would re-transfer the whole history for
  // a diff, which is the cost FR-040's platform budget is spent on elsewhere.
  if (!existsSync(join(mirror, "HEAD"))) {
    mkdirSync(dirname(mirror), { recursive: true });
    await run(["clone", "--quiet", "--mirror", options.remoteUrl, mirror]);
  }

  // `+` forces the update: a pull request head is rewritten on every force-push, and a refusal to
  // fast-forward here would leave the review reading a revision the author has replaced.
  const ref = pullRequestHeadRef(options.pullRequest);
  await run(["fetch", "--quiet", "--force", options.remoteUrl, `+${ref}:${ref}`], mirror);

  mkdirSync(dirname(treePath), { recursive: true });
  // `--detach`: nothing a review does can move a branch, because the worktree is on no branch.
  await run(["worktree", "add", "--detach", "--quiet", treePath, options.headSha], mirror);

  try {
    return await work({ path: treePath, headSha: options.headSha });
  } finally {
    // `--force` because a review may have left the tree dirty, and a worktree left behind would
    // accumulate one directory per review until the disk filled.
    try {
      await run(["worktree", "remove", "--force", treePath], mirror);
    } catch {
      // The removal is best-effort: a tree git will not let go of is still removed from disk, and
      // `prune` below reconciles git's own bookkeeping. Throwing here would replace the review's
      // outcome — or its real failure — with a cleanup error.
      rmSync(treePath, { recursive: true, force: true });
    }

    try {
      await run(["worktree", "prune"], mirror);
    } catch {
      // Bookkeeping only; the tree is already gone.
    }
  }
}
