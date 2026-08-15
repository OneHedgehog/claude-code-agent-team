import { describe, expect, it } from "vitest";

import { CliError, parseArgs } from "../../src/cli.js";

const COMPLETE = [
  "--target",
  "owner/name",
  "--checkout",
  "/tmp/checkouts/run-1",
  "--pull-request",
  "7",
];

describe("parsing a complete invocation (FR-026)", () => {
  it("resolves the target, the checkout, and the pull request", () => {
    const args = parseArgs(COMPLETE);

    expect(args.target.owner).toBe("owner");
    expect(args.target.name).toBe("name");
    expect(args.target.checkoutPath).toBe("/tmp/checkouts/run-1");
    expect(args.pullRequest).toBe(7);
  });

  it("accepts --flag=value as well as --flag value", () => {
    const args = parseArgs([
      "--target=owner/name",
      "--checkout=/tmp/checkouts/run-1",
      "--pull-request=7",
    ]);

    expect(args.target.owner).toBe("owner");
    expect(args.pullRequest).toBe(7);
  });

  it("does not care about flag order", () => {
    const args = parseArgs([
      "--pull-request",
      "7",
      "--checkout",
      "/tmp/checkouts/run-1",
      "--target",
      "owner/name",
    ]);

    expect(args.target.name).toBe("name");
  });
});

describe("a missing --target stops the run (FR-027)", () => {
  it("errors rather than defaulting to the working directory", () => {
    expect(() => parseArgs(["--checkout", "/tmp/c", "--pull-request", "7"])).toThrow(CliError);
  });

  it("names the missing parameter", () => {
    let message = "";
    try {
      parseArgs(["--checkout", "/tmp/c", "--pull-request", "7"]);
    } catch (error) {
      message = error instanceof CliError ? error.message : "";
    }

    expect(message).toContain("--target");
  });

  it("never reads process.cwd() as a substitute", () => {
    // With no arguments at all, the only correct behavior is to stop.
    expect(() => parseArgs([])).toThrow(CliError);
  });
});

describe("the other required parameters", () => {
  it.each([
    ["--checkout", ["--target", "owner/name", "--pull-request", "7"]],
    ["--pull-request", ["--target", "owner/name", "--checkout", "/tmp/c"]],
  ])("stops when %s is missing", (flag, argv) => {
    let message = "";
    try {
      parseArgs(argv);
    } catch (error) {
      message = error instanceof CliError ? error.message : "";
    }

    expect(message).toContain(flag);
  });

  it.each([
    ["a malformed target", ["--target", "owner", "--checkout", "/tmp/c", "--pull-request", "7"]],
    [
      "a relative checkout",
      ["--target", "owner/name", "--checkout", "relative", "--pull-request", "7"],
    ],
    [
      "a non-numeric pull request",
      ["--target", "owner/name", "--checkout", "/tmp/c", "--pull-request", "seven"],
    ],
    [
      "a pull request below one",
      ["--target", "owner/name", "--checkout", "/tmp/c", "--pull-request", "0"],
    ],
    ["a flag with no value", ["--target", "owner/name", "--checkout", "/tmp/c", "--pull-request"]],
    [
      "an unrecognized flag",
      ["--target", "owner/name", "--checkout", "/tmp/c", "--pull-request", "7", "--force"],
    ],
    [
      "a stray positional argument",
      ["owner/name", "--target", "owner/name", "--checkout", "/tmp/c", "--pull-request", "7"],
    ],
  ])("rejects %s", (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(CliError);
  });

  it("rejects a repeated flag rather than silently taking one of the two values", () => {
    expect(() => parseArgs([...COMPLETE, "--target", "other/repo"])).toThrow(CliError);
  });
});
