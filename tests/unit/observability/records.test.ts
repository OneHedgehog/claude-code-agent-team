import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  createLogger,
  REVIEW_EVENTS,
  type RecordFields,
} from "../../../src/observability/logger.js";

/**
 * FR-033 and FR-034: every emitted record validates against the published schema and carries the
 * run identifier, and nothing reaches standard output as bare prose. Together with the pull
 * request itself, the records are what make a review reconstructible without re-running it.
 *
 * The schema is loaded from `schemas/` — the same copy the service ships — so the contract and the
 * behavior cannot drift apart.
 */

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../schemas/review-record.schema.json", import.meta.url)),
    "utf8",
  ),
) as object;

const ajv = new Ajv2020({ allErrors: true, strict: false });

// The schema's only `format` is `date-time`. One expression is cheaper than the `ajv-formats`
// dependency, which the plan's justified dependency list does not include (Principle IV: prefer the
// standard library and existing dependencies).
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);

const validate = ajv.compile(schema);

function capture(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const logger = createLogger({
    runId: "run-42",
    write: (line) => lines.push(line),
    now: () => new Date("2026-08-16T10:00:00.000Z"),
  });

  return { lines, logger };
}

/** One representative field set per event family, so the schema is exercised, not just the shape. */
const FIELDS_BY_EVENT: Partial<Record<(typeof REVIEW_EVENTS)[number], RecordFields>> = {
  "run.started": { target: "acme/widgets", pullRequest: 7, revision: "abc123", round: 1 },
  "state.entered": { state: "checkingBudgets" },
  "prerequisites.missing": {
    prerequisites: {
      permissionsHeld: false,
      gateRequiredByBranchProtection: false,
      baseBranch: "main",
      missing: ["checks: write"],
    },
  },
  "paths.excluded": {
    excludedPaths: {
      count: 2,
      paths: ["a.lock", "b.png"],
      source: ["declared-pattern", "vcs-binary"],
    },
  },
  "settings.defaults_applied": { effectiveOptionalSettings: { modelEffort: "high" } },
  "finding.posted": {
    finding: { id: "f1", severity: "critical", blocking: true, path: "src/a.ts", line: 4 },
  },
  "role.verdict": { role: "security", verdict: "request-changes" },
  "gate.reported": { gate: { conclusion: "failure", reason: "security requested changes" } },
  "budget.reported": { usage: { tokensConsumed: 120, budgetRemaining: 880 } },
  "escalation.notified": {
    escalation: { reason: "budget exhausted", channelDelivered: true, statedOnPullRequest: true },
  },
  "error.unhandled": { error: { kind: "ModelError", message: "no verdict produced" } },
};

describe("every record validates against the published schema (FR-033)", () => {
  for (const event of REVIEW_EVENTS) {
    it(`${event}`, () => {
      const { lines, logger } = capture();

      logger.info(event, FIELDS_BY_EVENT[event]);

      const record = JSON.parse(lines[0] ?? "{}") as unknown;

      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    });
  }
});

describe("every record carries the run identifier (FR-033)", () => {
  it("on every level", () => {
    const { lines, logger } = capture();

    logger.debug("state.entered", { state: "reviewing" });
    logger.info("state.entered", { state: "reviewing" });
    logger.warn("state.entered", { state: "reviewing" });
    logger.error("state.entered", { state: "reviewing" });

    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect((JSON.parse(line) as { runId: string }).runId).toBe("run-42");
    }
  });

  it("even when the caller passes no fields at all", () => {
    const { lines, logger } = capture();

    logger.info("run.started");

    expect((JSON.parse(lines[0] ?? "{}") as { runId: string }).runId).toBe("run-42");
  });

  it("and a caller cannot overwrite it with a field of its own", () => {
    const { lines, logger } = capture();

    // The runId is applied after the caller's fields precisely so a stray field cannot detach a
    // record from its run.
    logger.info("run.started", { runId: "not-the-run" } as unknown as RecordFields);

    expect((JSON.parse(lines[0] ?? "{}") as { runId: string }).runId).toBe("run-42");
  });
});

describe("no bare prose reaches standard output (FR-033)", () => {
  it("every emission is one JSON object on one line", () => {
    const { lines, logger } = capture();

    logger.info("run.started", { target: "acme/widgets" });
    logger.info("run.concluded", { gate: { conclusion: "success" } });

    for (const line of lines) {
      expect(line).not.toContain("\n");
      expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect(typeof (JSON.parse(line) as unknown)).toBe("object");
    }
  });

  it("a multi-line message stays on one line once serialized", () => {
    const { lines, logger } = capture();

    logger.error("error.unhandled", { error: { message: "line one\nline two" } });

    expect(lines[0]).not.toContain("\n");
    expect(
      (JSON.parse(lines[0] ?? "{}") as { error: { message: string } }).error.message,
    ).toContain("\n");
  });
});
