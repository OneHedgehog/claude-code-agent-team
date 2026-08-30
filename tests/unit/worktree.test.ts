import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTarget, type TargetRepository } from "../../src/config/target.js";
import {
  mirrorDirectory,
  pullRequestHeadRef,
  withWorktree,
  worktreeDirectory,
  type GitCommand,
} from "../../src/worktree.js";

/**
 * Working-tree provisioning (research.md R-017).
 *
 * `actions/checkout` used to do this. Under R-017 the service does it itself: one bare mirror per
 * target, a `git fetch` of the pull request head, a detached worktree per review, removed
 * afterwards.
 *
 * The load-bearing assertion is the one about what is *not* executed. R-013's design ran `npm ci`
 * and `npm run build` against the pull request's own code on the host, which is precisely why
 * `review.yml` needed the `head.repo.full_name == github.repository` guard and why fork pull
 * requests were excluded. This process reads the diff and the tree and executes nothing from
 * either, which is what makes removing that exclusion safe. A test that only checked the happy
 * path would let the exclusion be removed and the execution quietly return.
 */

let cache: string;
let origin: string;
let originHead: string;

const TARGET: TargetRepository = createTarget({
  owner: "OneHedgehog",
  name: "fixture-repo",
  checkoutPath: "/tmp",
});

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

/** A real bare repository carrying a real `refs/pull/7/head`, so the commands are exercised. */
function seedOrigin(): void {
  const work = mkdtempSync(join(tmpdir(), "worktree-seed-"));

  git(["init", "--quiet", "--initial-branch=main", "."], work);
  git(["config", "user.email", "fixture@example.invalid"], work);
  git(["config", "user.name", "Fixture"], work);

  writeFileSync(join(work, "reviewed.txt"), "the revision under review\n");

  // A package manifest whose lifecycle script would leave a marker if anything ever ran it. The
  // marker's absence is the assertion; its presence would mean the tree's contents got a say in
  // what this process executes.
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({
      name: "hostile-fixture",
      scripts: {
        prepare: `node -e "require('fs').writeFileSync('${join(cache, "EXECUTED")}','x')"`,
      },
    }),
  );

  git(["add", "."], work);
  git(["commit", "--quiet", "-m", "the revision under review"], work);
  originHead = git(["rev-parse", "HEAD"], work);

  git(["clone", "--quiet", "--bare", work, origin], work);
  // GitHub exposes a pull request's head at this ref; the fixture mirrors that.
  git(["update-ref", pullRequestHeadRef(7), originHead], origin);

  rmSync(work, { recursive: true, force: true });
}

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "review-cache-"));
  origin = join(mkdtempSync(join(tmpdir(), "review-origin-")), "origin.git");
  mkdirSync(join(origin, ".."), { recursive: true });
  seedOrigin();
});

afterEach(() => {
  rmSync(cache, { recursive: true, force: true });
  rmSync(join(origin, ".."), { recursive: true, force: true });
});

function options(overrides: Partial<Parameters<typeof withWorktree>[0]> = {}) {
  return {
    target: TARGET,
    remoteUrl: origin,
    pullRequest: 7,
    headSha: originHead,
    cacheDirectory: cache,
    ...overrides,
  };
}

describe("where the mirror and the worktrees live (R-017)", () => {
  it("keeps one bare mirror per target under the cache directory", () => {
    expect(mirrorDirectory(cache, TARGET)).toBe(
      join(cache, "mirrors", "OneHedgehog__fixture-repo.git"),
    );
  });

  it("gives each review its own worktree path rather than sharing one", () => {
    expect(worktreeDirectory(cache, TARGET, "run-a")).not.toBe(
      worktreeDirectory(cache, TARGET, "run-b"),
    );
  });

  it("asks for the pull request's head by the ref GitHub publishes it at", () => {
    expect(pullRequestHeadRef(7)).toBe("refs/pull/7/head");
  });
});

describe("provisioning a worktree at the revision under review", () => {
  it("checks out the requested revision's content", async () => {
    const contents = await withWorktree(options(), (tree) =>
      Promise.resolve(readFileSync(join(tree.path, "reviewed.txt"), "utf8")),
    );

    expect(contents).toBe("the revision under review\n");
  });

  it("creates a bare mirror, not a working clone", async () => {
    await withWorktree(options(), () => Promise.resolve(null));

    expect(existsSync(join(mirrorDirectory(cache, TARGET), "HEAD"))).toBe(true);
    expect(existsSync(join(mirrorDirectory(cache, TARGET), "reviewed.txt"))).toBe(false);
  });

  it("detaches rather than checking out a branch, so no review can move a ref", async () => {
    const head = await withWorktree(options(), (tree) =>
      Promise.resolve(git(["rev-parse", "HEAD"], tree.path)),
    );

    expect(head).toBe(originHead);
  });

  it("reuses the mirror across reviews instead of re-cloning", async () => {
    const commands: GitCommand[] = [];
    const record = { onCommand: (command: GitCommand) => commands.push(command) };

    await withWorktree(options({ ...record, id: "first" }), () => Promise.resolve(null));
    const afterFirst = commands.length;
    await withWorktree(options({ ...record, id: "second" }), () => Promise.resolve(null));

    const secondRun = commands.slice(afterFirst);
    expect(secondRun.some((command) => command.args[0] === "clone")).toBe(false);
    expect(secondRun.some((command) => command.args[0] === "fetch")).toBe(true);
  });
});

describe("removing the worktree on both the success and the failure path", () => {
  it("removes it after the work returns", async () => {
    let path = "";
    await withWorktree(options(), (tree) => {
      path = tree.path;
      return Promise.resolve(null);
    });

    expect(existsSync(path)).toBe(false);
  });

  it("removes it after the work throws, and lets the failure through", async () => {
    let path = "";

    await expect(
      withWorktree(options(), (tree) => {
        path = tree.path;
        return Promise.reject(new Error("the review failed"));
      }),
    ).rejects.toThrow("the review failed");

    expect(existsSync(path)).toBe(false);
  });

  it("removes a worktree the review left dirty, rather than leaving it behind forever", async () => {
    let path = "";

    await withWorktree(options(), (tree) => {
      path = tree.path;
      writeFileSync(join(tree.path, "reviewed.txt"), "modified by something\n");
      return Promise.resolve(null);
    });

    expect(existsSync(path)).toBe(false);
  });
});

describe("no command derived from the tree's own contents is ever executed (R-017)", () => {
  it("runs only git, and only its provisioning subcommands", async () => {
    const commands: GitCommand[] = [];

    await withWorktree(
      options({ onCommand: (command: GitCommand) => commands.push(command) }),
      () => Promise.resolve(null),
    );

    expect(commands.length).toBeGreaterThan(0);
    expect([...new Set(commands.map((command) => command.program))]).toEqual(["git"]);

    const allowed = new Set([
      "clone",
      "fetch",
      "worktree",
      "config",
      "rev-parse",
      "init",
      "remote",
    ]);
    for (const command of commands) {
      expect(allowed.has(command.args[0] ?? "")).toBe(true);
    }
  });

  it("passes every argument as an argv element, never as a shell string", async () => {
    const commands: GitCommand[] = [];

    await withWorktree(
      options({ onCommand: (command: GitCommand) => commands.push(command) }),
      () => Promise.resolve(null),
    );

    for (const command of commands) {
      expect(Array.isArray(command.args)).toBe(true);
      // A shell metacharacter in an argv element is inert; in a command string it is not. Asserting
      // the shape here is what keeps a later refactor from reaching for `exec`.
      expect(command).not.toHaveProperty("shell");
    }
  });

  it("never runs a lifecycle script the reviewed tree declares", async () => {
    await withWorktree(options(), (tree) => {
      // The manifest is present in the checkout — it is part of the diff under review — and its
      // `prepare` script is simply never a thing this process invokes.
      expect(existsSync(join(tree.path, "package.json"))).toBe(true);
      return Promise.resolve(null);
    });

    expect(existsSync(join(cache, "EXECUTED"))).toBe(false);
  });

  it("never runs a build or install step against the reviewed code", async () => {
    const commands: GitCommand[] = [];

    await withWorktree(
      options({ onCommand: (command: GitCommand) => commands.push(command) }),
      () => Promise.resolve(null),
    );

    const rendered = commands.map((command) => [command.program, ...command.args].join(" "));
    for (const forbidden of ["npm", "npx", "yarn", "pnpm", "make", "node ", "sh ", "bash "]) {
      expect(rendered.some((line) => line.includes(forbidden))).toBe(false);
    }
  });
});
