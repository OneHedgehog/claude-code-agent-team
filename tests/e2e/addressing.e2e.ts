import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bothApprove,
  createFixtureClient,
  fixtureEnvironment,
  requireFixtureEnvironment,
  runReview,
  type FixtureClient,
} from "./harness/index.js";

const run = promisify(execFile);

/**
 * Quickstart scenario 23 (tasks.md T108): everything is addressed through the target (FR-026,
 * FR-027, SC-012).
 *
 * Running from an unrelated working directory is the *normal* case for this service, not an edge
 * case — the daemon runs under `launchd` from wherever `launchd` happens to start it, and the
 * by-hand command is run from wherever the operator is standing. So a run that resolved anything
 * from `process.cwd()` would work perfectly on the developer's machine and review the wrong
 * repository everywhere else.
 *
 * The assertion that makes this real is the **constitution**. Settings and diffs could each be
 * argued to have come from somewhere plausible, but this repository's constitution and the
 * fixture's are different documents, and the reviewer is handed exactly one of them. If addressing
 * leaked, the reviewer would be reviewing the fixture's diff against this repository's rules — a
 * failure that produces confident, entirely wrong findings rather than an error.
 *
 * FR-027's other half is the refusal: there is no default target. It is exercised as a real
 * process, from a directory that is not a repository at all, because "stops with an error" is a
 * claim about an exit code and a message rather than about a thrown value.
 */

/** This repository's own constitution — the document the run must *not* have read. */
const OWN_CONSTITUTION = readFileSync(
  resolve(import.meta.dirname, "..", "..", ".specify", "memory", "constitution.md"),
  "utf8",
);

const CLI_ENTRY = resolve(import.meta.dirname, "..", "..", "src", "cli.ts");

describe("addressing through the target", () => {
  let client: FixtureClient;

  beforeAll(async () => {
    client = createFixtureClient(await requireFixtureEnvironment(fixtureEnvironment()));
  });

  afterAll(async () => {
    await client?.teardown();
  });

  it("resolves the constitution, settings, and diff through --target (scenario 23)", async () => {
    const [source, tests, document, fixtureConstitution] = await Promise.all([
      client.readBaseFile("src/greeting.js"),
      client.readBaseFile("tests/greeting.test.js"),
      client.readBaseFile("docs/greeting.md"),
      client.readBaseFile(".specify/memory/constitution.md"),
    ]);

    // The premise the whole scenario rests on: the two documents are not the same, so reading the
    // wrong one is detectable at all.
    expect(fixtureConstitution).not.toBe(OWN_CONSTITUTION);

    const pullRequest = await client.openPullRequest({
      label: "scenario-23-addressing",
      title: "A change reviewed from an unrelated working directory",
      body: "Staged for scenario 23.",
      files: [
        { path: "src/greeting.js", content: `${source}\nexport const ADDRESSED = true;\n` },
        {
          path: "tests/greeting.test.js",
          content: `${tests}\ntest("the flag is exported", () => {\n  assert.equal(ADDRESSED, true);\n});\n`,
        },
        { path: "docs/greeting.md", content: `${document}\nThe module exports a flag.\n` },
      ],
    });

    const reviewed = await runReview({ client, pullRequest, script: bothApprove() });

    // The checkout is a worktree the run provisioned, not the directory the suite is running from.
    expect(reviewed.checkoutPath).not.toBe(process.cwd());
    expect(reviewed.checkoutPath.startsWith(process.cwd())).toBe(false);
    expect(reviewed.adapters.target.checkoutPath).toBe(reviewed.checkoutPath);
    expect(reviewed.adapters.target.owner).toBe(client.environment.repository.owner);
    expect(reviewed.adapters.target.name).toBe(client.environment.repository.name);

    const requests = reviewed.model.received;
    expect(requests).toHaveLength(2);

    for (const request of requests) {
      // The fixture's rules, not this repository's. This is the assertion FR-026 is about.
      expect(request.constitution).toBe(fixtureConstitution);
      expect(request.constitution).not.toBe(OWN_CONSTITUTION);

      // And the inspected content is the fixture's too.
      expect(request.diff).toContain("src/greeting.js");
    }

    // Settings were read from the target's checkout, and their effective values are reported with
    // the run rather than left implicit (FR-054).
    expect(reviewed.adapters.settings.settings.requiredReviewerRoles).toEqual([
      "security",
      "implementation",
    ]);
    expect(reviewed.adapters.settings.effectiveOptionalSettings["modelEffort"]).toBe("high");

    expect(reviewed.outcome.gate.conclusion).toBe("success");
  });

  it("stops with an error when --target is omitted (scenario 23)", async () => {
    // A directory that is not a repository, so a run that fell back to the working directory would
    // have nothing to fall back *to* — and would still be wrong if it did.
    const elsewhere = mkdtempSync(join(tmpdir(), "review-service-e2e-elsewhere-"));

    const failure = await run(
      "node",
      ["--experimental-strip-types", CLI_ENTRY, "--pull-request", "1"],
      {
        cwd: elsewhere,
      },
    ).then(
      () => null,
      (error: unknown) => error as { code?: number; stderr?: string; stdout?: string },
    );

    expect(failure).not.toBeNull();
    expect(failure?.code).toBe(1);

    // It said why, rather than exiting quietly or printing a stack trace with no reason (FR-024).
    expect((failure?.stderr ?? "").trim()).not.toBe("");

    // And it reviewed nothing on the way out: stdout is the record stream, and there are no
    // records because there was no run.
    expect((failure?.stdout ?? "").trim()).toBe("");
  });
});
