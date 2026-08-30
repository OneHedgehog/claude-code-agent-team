import { readFileSync } from "node:fs";

// Ajv ships CommonJS, so the 2020-12 constructor arrives as a named export under Node's ESM
// interop rather than as the default. The schemas declare draft 2020-12, so this is the right
// entry point rather than Ajv's draft-07 default.
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import { resolveInTarget, type TargetRepository } from "./target.js";

/**
 * Operating settings, read from the `reviewService` section of `<target>/.agents/settings.json`
 * and validated against the published schema (FR-028, FR-050, FR-054, research.md R-011).
 *
 * Validation is asymmetric on purpose: the root object tolerates sibling agents' sections, while
 * the `reviewService` subtree rejects an unrecognized key — a silently ignored typo in a budget is
 * indistinguishable from a setting that was never applied. The schema's `default` keyword is
 * documentation for required settings and a genuine fallback only for the two optional ones, so a
 * missing budget can never be filled in from the schema.
 *
 * The shared `host` section is validated exactly as strictly as this service's own, and that is
 * not a contradiction of FR-050 but the correction of a too-broad reading of it (research.md
 * R-019). FR-050 says a *sibling agent's* section is ignored rather than rejected. `host` belongs
 * to no agent: Principle VIII's cap counts every agent job on the machine, so a cap held inside
 * one agent's namespace would be the private counter R-019 rejects, spelled differently.
 */

export type RoleName = "security" | "implementation";
export type Severity = "critical" | "high" | "medium" | "low";
export type ModelEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface EscalationChannel {
  readonly type: "github-issue";
  readonly assignee: string;
  readonly label: string;
}

/** The shared, agent-agnostic section. Read by this service, owned by none (R-019). */
export interface HostSettings {
  readonly maxConcurrentAgents: number;
}

export interface OperatingSettings {
  readonly requiredReviewerRoles: readonly RoleName[];
  readonly blockingSeverityThreshold: Severity;
  readonly maxReviewRounds: number;
  readonly maxReviewableDiffSize: number;
  readonly maxPullRequestSize: number;
  readonly excludedPathPatterns: readonly string[];
  readonly tokenBudget: number;
  readonly reviewerTokenReserve: number;
  readonly platformApiBudget: number;
  readonly platformApiReserve: number;
  readonly maxRateLimitWaitSeconds: number;
  readonly maxQueueWaitSeconds: number;
  readonly escalationChannel: EscalationChannel;
  readonly pollIntervalSeconds: number;
  /** A ceiling on the reviewer's share of the host cap, never a raise above it (R-019). */
  readonly maxConcurrentReviews: number;
  readonly modelEffort: ModelEffort;
}

export interface LoadedSettings {
  readonly settings: OperatingSettings;
  readonly host: HostSettings;
  /** Optional settings and the values actually applied, reported with the run (FR-054). */
  readonly effectiveOptionalSettings: Readonly<Record<string, unknown>>;
}

export class SettingsError extends Error {
  override readonly name = "SettingsError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`operating settings are invalid: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

interface SchemaShape {
  readonly $defs: {
    readonly reviewServiceSettings: {
      readonly required: readonly string[];
      readonly properties: Record<string, { readonly default?: unknown }> & {
        readonly escalationChannel: {
          readonly properties: { readonly label: { readonly default?: unknown } };
        };
      };
    };
  };
}

/**
 * The published copy under `schemas/` is the schema the service actually validates against, so the
 * contract and the behavior cannot drift. Both `src/config/` and `dist/config/` sit two levels
 * below the package root, so one relative URL serves the source tree and the build.
 */
const SCHEMA_URL = new URL("../../schemas/settings.schema.json", import.meta.url);

const schema = JSON.parse(readFileSync(SCHEMA_URL, "utf8")) as SchemaShape &
  Record<string, unknown>;

/** The settings whose absence stops the run (FR-028) — read from the schema, never re-listed. */
export const REQUIRED_SETTING_KEYS: readonly string[] = schema.$defs.reviewServiceSettings.required;

/** The two settings whose absence is filled from the documented default instead (FR-054). */
export const OPTIONAL_SETTING_PATHS = ["modelEffort", "escalationChannel.label"] as const;

const DEFAULTS = {
  modelEffort: schema.$defs.reviewServiceSettings.properties["modelEffort"]?.default,
  escalationLabel:
    schema.$defs.reviewServiceSettings.properties.escalationChannel.properties.label.default,
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: false });
const validate: ValidateFunction = ajv.compile(schema);

/** Turns Ajv's machine output into problems that name the key an operator has to fix. */
function describe(error: ErrorObject): string {
  const where = error.instancePath === "" ? "settings" : `settings${error.instancePath}`;

  if (error.keyword === "required") {
    const key = (error.params as { missingProperty?: string }).missingProperty ?? "";
    return `${where}: missing required setting \`${key}\``;
  }
  if (error.keyword === "additionalProperties") {
    const key = (error.params as { additionalProperty?: string }).additionalProperty ?? "";
    return `${where}: unrecognized setting \`${key}\` — a typo here is indistinguishable from a setting that was never applied`;
  }

  return `${where}: ${error.message ?? "is invalid"}`;
}

/**
 * The cross-field invariants JSON Schema cannot express (data-model.md, OperatingSettings).
 * Every violation is collected rather than short-circuited, so one run reports every problem.
 */
function invariantProblems(
  section: Record<string, unknown>,
  host: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  const num = (key: string): number => section[key] as number;

  if (num("reviewerTokenReserve") >= num("tokenBudget")) {
    problems.push(
      `settings.reviewService: reviewerTokenReserve (${num("reviewerTokenReserve")}) must be less than tokenBudget (${num("tokenBudget")})`,
    );
  }
  if (num("platformApiReserve") >= num("platformApiBudget")) {
    problems.push(
      `settings.reviewService: platformApiReserve (${num("platformApiReserve")}) must be less than platformApiBudget (${num("platformApiBudget")})`,
    );
  }
  if (num("maxReviewableDiffSize") <= num("maxPullRequestSize")) {
    problems.push(
      `settings.reviewService: maxReviewableDiffSize (${num("maxReviewableDiffSize")}) must exceed maxPullRequestSize (${num("maxPullRequestSize")}), otherwise FR-043 could never fire`,
    );
  }

  // R-019: `maxConcurrentReviews` is a ceiling on the reviewer's share of the host's cap, so a
  // value above it is not a stricter setting read leniently — it is a setting that cannot mean
  // what it says, since a review must hold a host lease as well as a worker to start.
  //
  // The companion bound, `host.maxConcurrentAgents >= 1`, is not here because it is not a
  // cross-field question: the schema states it as `minimum: 1`, which is where a single-field
  // bound belongs. Restating it in code would be validation no input could ever reach.
  const maxConcurrentAgents = host["maxConcurrentAgents"] as number;
  if (num("maxConcurrentReviews") > maxConcurrentAgents) {
    problems.push(
      `settings.reviewService: maxConcurrentReviews (${num("maxConcurrentReviews")}) must not ` +
        `exceed host.maxConcurrentAgents (${maxConcurrentAgents}); reviewer jobs take an ordinary ` +
        `slot in the host-wide cap and are never exempted from it (FR-041, Principle VIII)`,
    );
  }

  return problems;
}

/**
 * Validates a parsed settings file and returns this service's own section, with optional settings
 * filled from their documented defaults and reported as effective.
 */
export function validateSettings(raw: unknown): LoadedSettings {
  if (!validate(raw)) {
    throw new SettingsError((validate.errors ?? []).map(describe));
  }

  const { reviewService: section, host } = raw as {
    reviewService: Record<string, unknown>;
    host: Record<string, unknown>;
  };

  const problems = invariantProblems(section, host);
  if (problems.length > 0) {
    throw new SettingsError(problems);
  }

  const channel = section["escalationChannel"] as Record<string, unknown>;
  const modelEffort = (section["modelEffort"] ?? DEFAULTS.modelEffort) as ModelEffort;
  const label = (channel["label"] ?? DEFAULTS.escalationLabel) as string;

  const settings: OperatingSettings = {
    requiredReviewerRoles: section["requiredReviewerRoles"] as readonly RoleName[],
    blockingSeverityThreshold: section["blockingSeverityThreshold"] as Severity,
    maxReviewRounds: section["maxReviewRounds"] as number,
    maxReviewableDiffSize: section["maxReviewableDiffSize"] as number,
    maxPullRequestSize: section["maxPullRequestSize"] as number,
    excludedPathPatterns: section["excludedPathPatterns"] as readonly string[],
    tokenBudget: section["tokenBudget"] as number,
    reviewerTokenReserve: section["reviewerTokenReserve"] as number,
    platformApiBudget: section["platformApiBudget"] as number,
    platformApiReserve: section["platformApiReserve"] as number,
    maxRateLimitWaitSeconds: section["maxRateLimitWaitSeconds"] as number,
    maxQueueWaitSeconds: section["maxQueueWaitSeconds"] as number,
    pollIntervalSeconds: section["pollIntervalSeconds"] as number,
    maxConcurrentReviews: section["maxConcurrentReviews"] as number,
    escalationChannel: {
      type: channel["type"] as "github-issue",
      assignee: channel["assignee"] as string,
      label,
    },
    modelEffort,
  };

  return {
    settings,
    host: { maxConcurrentAgents: host["maxConcurrentAgents"] as number },
    effectiveOptionalSettings: { modelEffort, "escalationChannel.label": label },
  };
}

/** Reads and validates the target's settings, resolved through the target parameter (FR-026). */
export function loadSettings(target: TargetRepository): LoadedSettings {
  const path = resolveInTarget(target, ".agents", "settings.json");

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new SettingsError([`settings: ${path} could not be read`]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SettingsError([
      `settings: ${path} is not valid JSON (${error instanceof Error ? error.message : "parse error"})`,
    ]);
  }

  return validateSettings(parsed);
}
