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

/**
 * How the reviewer reaches the model. `api` holds a credential and calls the Messages API, metered
 * against an organisation's credits; `agent-sdk` runs Claude Code as a library, which authenticates
 * itself against the operator's subscription.
 */
export type ModelTransport = "api" | "agent-sdk";

/** How a provider's family is reached. `cli` spawns a vendor binary and parses its JSON output. */
export type ProviderTransport = ModelTransport | "cli";

export type FundingSource = "metered" | "subscription";
export type CredentialSource = "oauth-profile" | "env" | "keychain" | "file";

export interface CredentialRequirement {
  readonly source: CredentialSource;
  readonly name?: string;
}

/**
 * FR-083, stated per provider rather than assumed. Every flag is `true` in the schema — the point
 * is not that an operator may choose, but that adding a provider is impossible without writing
 * down how it satisfies each obligation. Reviewed content is untrusted data whichever vendor
 * reads it (Principle V).
 */
export interface ContainmentDeclaration {
  readonly noTools: true;
  readonly noInheritedSettings: true;
  readonly noWorkingTreeAccess: true;
  readonly allowlistedEnvironment: true;
  readonly emptyWorkingDirectory: true;
  readonly otherCredentialsNeutralised: true;
  readonly vendorSandbox?: boolean;
  /** Non-egress host surfaces the child opens, declared rather than discovered (R-028). */
  readonly hostSurfaces?: readonly string[];
}

/** A funding source that gets billed or throttled — the thing a budget can bound (FR-081). */
export interface Account {
  readonly name: string;
  readonly budget: number;
  readonly reserve: number;
}

/** A named way of reaching exactly one model family. */
export interface Provider {
  readonly name: string;
  /** Model identifier per effort level. Effort is expressed here, never by a separate flag. */
  readonly models: Readonly<Partial<Record<ModelEffort, string>>>;
  readonly family: string;
  readonly transport: ProviderTransport;
  readonly funding: FundingSource;
  readonly account: string;
  readonly credential: CredentialRequirement;
  readonly containment: ContainmentDeclaration;
  /**
   * True when this provider was synthesised by the FR-081 migration rather than declared.
   *
   * It carries no pinned model and no containment an operator wrote, because a pre-feature file
   * declared neither, and demanding them would break SC-005 — the whole promise that such a file
   * keeps working untouched. The declaration rules therefore run over the *declared* section and
   * never see this object.
   */
  readonly synthesised: boolean;
}

/** An ordered, non-empty provider list per reviewer role. */
export type Routes = Readonly<Record<RoleName, readonly string[]>>;

/**
 * The provider the authoring identity uses (FR-082).
 *
 * It carries its own family rather than naming an entry in `providers`, because the author is not
 * a reviewer provider: it has no route, no credential this service resolves, and no containment
 * this service enforces. The independence check needs exactly one thing from it — the family — so
 * that is what it declares.
 */
export interface AuthoringProvider {
  readonly name: string;
  readonly family: string;
}

/**
 * The per-attempt wall-clock bound in milliseconds (FR-086, superseding FR-066's value).
 *
 * Declared in the config layer rather than beside the transport that enforces it, because two
 * places need it and one of them is the preflight arithmetic: a route long enough that its
 * attempts could outlast `maxQueueWaitSeconds` must be refused before a review starts. Keeping
 * the number in one place is what makes that check and the enforcement agree by construction
 * rather than by a comment claiming they do.
 */
export const ATTEMPT_BOUND_MS = 5 * 60 * 1000;

/**
 * Model-family tokens recognisable from a model identifier.
 *
 * Deliberately a short allowlist rather than a parser. The check it powers is one-directional:
 * a declaration whose pinned model *names* a family different from the declared one is refused,
 * and an identifier matching nothing here is accepted, because this service has no catalogue and
 * guessing would refuse valid configurations. It is a guard against the specific R-021 trap —
 * an aggregator serving the authoring family under another vendor's label — not a general
 * validator.
 */
const FAMILY_TOKENS: readonly string[] = ["claude", "gemini", "gpt-oss", "gpt"];

function familyOfModel(model: string): string | undefined {
  const lower = model.toLowerCase();
  return FAMILY_TOKENS.find((token) => lower.startsWith(token));
}

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
  readonly modelTransport: ModelTransport;

  /**
   * Funding accounts, keyed by name (FR-081).
   *
   * Declared or synthesised, this is always populated: a legacy file's single budget becomes one
   * account so that everything downstream sees one shape. The *ledger* still enforces the flat
   * `tokenBudget`/`reviewerTokenReserve` in this release and moves onto these limits in the next
   * pull request — until then these are validated and reported, not yet the budget authority.
   */
  readonly accounts: Readonly<Record<string, Account>>;
  /** Providers, keyed by name. Always populated — synthesised from `modelTransport` if absent. */
  readonly providers: Readonly<Record<string, Provider>>;
  /** Each required role's ordered provider list. Always populated, single-entry after migration. */
  readonly routes: Routes;
  /**
   * The provider the authoring identity uses (FR-082), when the operator has named one.
   *
   * `undefined` is not a loophole, it is the absence of a subject: FR-082 requires the authoring
   * provider be named *explicitly* precisely because an inferred one cannot be checked at
   * preflight. With nothing declared the independence rule has nothing to compare against and
   * does not run — which is also what keeps a pre-feature file working (SC-005), since such a
   * file's one provider would otherwise be both author and reviewer and could never pass.
   */
  readonly authoringProvider?: AuthoringProvider;
  /** Presence is the FR-082 override; there is no boolean, because a reason is the point. */
  readonly authoringProviderOverrideReason?: string;
  /** True when routes and providers were migrated from `modelTransport` rather than declared. */
  readonly migratedFromModelTransport: boolean;
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
export const OPTIONAL_SETTING_PATHS = [
  "modelEffort",
  "modelTransport",
  "escalationChannel.label",
] as const;

const DEFAULTS = {
  modelEffort: schema.$defs.reviewServiceSettings.properties["modelEffort"]?.default,
  modelTransport: schema.$defs.reviewServiceSettings.properties["modelTransport"]?.default,
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
 * The routing declaration rules (FR-076, FR-081, FR-084, FR-086, R-021, R-026).
 *
 * Every one is a preflight failure, before any model call. They run over the **declared** section
 * only: the provider the migration synthesises is never inspected here, because a pre-feature
 * file declared no model and no containment and SC-005 promises it keeps working untouched.
 *
 * Collected rather than short-circuited, like the budget invariants above, so one run tells an
 * operator everything that is wrong instead of one thing at a time.
 */
function routingProblems(
  section: Record<string, unknown>,
  requiredRoles: readonly RoleName[],
  effort: ModelEffort,
): string[] {
  const providers = section["providers"] as Record<string, Record<string, unknown>> | undefined;
  if (providers === undefined) return [];

  const problems: string[] = [];
  const at = "settings.reviewService";

  // The alias is read by the migration alone. Declaring both leaves two answers to "how is the
  // model reached", and nothing here could pick between them without inventing a precedence rule
  // nobody asked for.
  if (section["modelTransport"] !== undefined) {
    problems.push(
      `${at}: \`modelTransport\` is deprecated and MUST NOT be declared alongside \`providers\` — ` +
        `two descriptions of how a model is reached is one more than can be true`,
    );
  }

  const accounts = (section["accounts"] ?? {}) as Record<
    string,
    { budget: number; reserve: number }
  >;
  for (const [name, account] of Object.entries(accounts)) {
    if (account.reserve >= account.budget) {
      problems.push(
        `${at}.accounts.${name}: reserve (${account.reserve}) must be less than budget (${account.budget})`,
      );
    }
  }

  for (const [name, provider] of Object.entries(providers)) {
    const account = provider["account"] as string;
    if (!(account in accounts)) {
      problems.push(`${at}.providers.${name}: draws on undeclared account \`${account}\``);
    }

    const models = (provider["models"] ?? {}) as Partial<Record<ModelEffort, string>>;
    const pinned = Object.entries(models).filter(([, id]) => typeof id === "string" && id !== "");

    if (pinned.length === 0) {
      problems.push(
        `${at}.providers.${name}: pins no model. A vendor default can change between releases, ` +
          `and a family nobody pinned is a family the FR-082 independence check never saw (R-021)`,
      );
    }

    const declaredFamily = (provider["family"] as string).toLowerCase();
    for (const [level, id] of pinned) {
      const named = familyOfModel(id);
      if (named !== undefined && named !== declaredFamily) {
        problems.push(
          `${at}.providers.${name}.models.${level}: pins \`${id}\`, which names family ` +
            `\`${named}\`, but the provider declares \`${declaredFamily}\` — the FR-082 check ` +
            `compares families, so a label the invocation contradicts defeats it`,
        );
      }
    }
  }

  const declaredRoutes = (section["routes"] ?? {}) as Partial<Record<RoleName, string[]>>;
  const boundSeconds = ATTEMPT_BOUND_MS / 1000;
  const maxQueueWaitSeconds = section["maxQueueWaitSeconds"] as number;

  for (const role of requiredRoles) {
    const route = declaredRoutes[role];

    if (route === undefined || route.length === 0) {
      problems.push(
        `${at}.routes.${role}: a required reviewer role has no route. There is no implicit ` +
          `fallback to some default provider (FR-076)`,
      );
      continue;
    }

    for (const name of route) {
      if (!(name in providers)) {
        problems.push(`${at}.routes.${role}: names undeclared provider \`${name}\` (FR-084)`);
        continue;
      }

      // Checked per routed provider rather than per declared one: a provider nobody routes to
      // cannot serve a request, so its effort coverage is not yet anybody's problem.
      const models = (providers[name]?.["models"] ?? {}) as Partial<Record<ModelEffort, string>>;
      if (models[effort] === undefined) {
        problems.push(
          `${at}.routes.${role}: provider \`${name}\` pins no model for the configured ` +
            `modelEffort \`${effort}\` (it has ${Object.keys(models).join(", ") || "none"}). ` +
            `Effort is expressed by the pinned identifier (R-020), so this must stop preflight ` +
            `rather than downgrade silently — FR-060 makes reporting an effort you do not apply ` +
            `worse than not reporting one`,
        );
      }
    }

    const seen = new Set<string>();
    for (const name of route) {
      if (seen.has(name)) {
        problems.push(
          `${at}.routes.${role}: lists provider \`${name}\` twice. The second entry buys nothing — ` +
            `a capacity failure will not have cleared between them`,
        );
      }
      seen.add(name);
    }

    // R-026: per-attempt bounds are only safe because of this arithmetic, so it is checked
    // rather than assumed. At the shipped default of 1800s the longest route is six.
    if (route.length * boundSeconds > maxQueueWaitSeconds) {
      problems.push(
        `${at}.routes.${role}: ${route.length} attempts at ${boundSeconds}s each could take ` +
          `${route.length * boundSeconds}s, past maxQueueWaitSeconds (${maxQueueWaitSeconds}). ` +
          `One review would hold the only slot longer than everything queued behind it agreed ` +
          `to wait (FR-086)`,
      );
    }
  }

  return problems;
}

/** The account and provider names the migration synthesises. Stable, so records stay comparable. */
export const MIGRATED_ACCOUNT_NAME = "default";

/**
 * Reads the declared routing shape, or synthesises it from `modelTransport` (FR-076, FR-081,
 * SC-005).
 *
 * A file predating this feature describes one transport and one budget. That *is* a
 * single-provider, single-account configuration with a single-entry route per role — it simply
 * spells it differently — so it is read as one rather than rejected or defaulted. No operator
 * action, and the run reports the same effective behaviour it reported before.
 *
 * The synthesised provider deliberately carries no pinned model: a legacy file pinned none, the
 * transport chose, and inventing one here would change behaviour under the banner of preserving
 * it. `synthesised` marks it so nothing later mistakes the gap for an operator's omission.
 */
function resolveRouting(
  section: Record<string, unknown>,
  requiredRoles: readonly RoleName[],
  transport: ModelTransport,
  tokenBudget: number,
  reviewerTokenReserve: number,
): {
  accounts: Record<string, Account>;
  providers: Record<string, Provider>;
  routes: Routes;
  migrated: boolean;
} {
  const declaredProviders = section["providers"] as Record<string, unknown> | undefined;

  if (declaredProviders === undefined) {
    const account: Account = {
      name: MIGRATED_ACCOUNT_NAME,
      budget: tokenBudget,
      reserve: reviewerTokenReserve,
    };
    const provider: Provider = {
      name: transport,
      models: {},
      family: transport,
      transport,
      funding: transport === "agent-sdk" ? "subscription" : "metered",
      account: MIGRATED_ACCOUNT_NAME,
      credential: { source: transport === "agent-sdk" ? "oauth-profile" : "env" },
      containment: {
        noTools: true,
        noInheritedSettings: true,
        noWorkingTreeAccess: true,
        allowlistedEnvironment: true,
        emptyWorkingDirectory: true,
        otherCredentialsNeutralised: true,
      },
      synthesised: true,
    };
    const routes = Object.fromEntries(
      requiredRoles.map((role) => [role, [transport]]),
    ) as unknown as Routes;

    return {
      accounts: { [MIGRATED_ACCOUNT_NAME]: account },
      providers: { [transport]: provider },
      routes,
      migrated: true,
    };
  }

  const rawAccounts = (section["accounts"] ?? {}) as Record<
    string,
    { budget: number; reserve: number }
  >;
  const accounts = Object.fromEntries(
    Object.entries(rawAccounts).map(([name, a]) => [
      name,
      { name, budget: a.budget, reserve: a.reserve },
    ]),
  );

  const providers = Object.fromEntries(
    Object.entries(declaredProviders).map(([name, raw]) => {
      const p = raw as Omit<Provider, "name" | "synthesised">;
      return [
        name,
        {
          name,
          models: p.models,
          family: p.family,
          transport: p.transport,
          funding: p.funding,
          account: p.account,
          credential: p.credential,
          containment: p.containment,
          synthesised: false,
        } satisfies Provider,
      ];
    }),
  );

  const declaredRoutes = (section["routes"] ?? {}) as Partial<Record<RoleName, string[]>>;
  const routes = Object.fromEntries(
    requiredRoles.map((role) => [role, declaredRoutes[role] ?? []]),
  ) as unknown as Routes;

  return { accounts, providers, routes, migrated: false };
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

  const problems = [
    ...invariantProblems(section, host),
    ...routingProblems(
      section,
      section["requiredReviewerRoles"] as readonly RoleName[],
      (section["modelEffort"] ?? DEFAULTS.modelEffort) as ModelEffort,
    ),
  ];
  if (problems.length > 0) {
    throw new SettingsError(problems);
  }

  const channel = section["escalationChannel"] as Record<string, unknown>;
  const modelEffort = (section["modelEffort"] ?? DEFAULTS.modelEffort) as ModelEffort;
  const modelTransport = (section["modelTransport"] ?? DEFAULTS.modelTransport) as ModelTransport;
  const label = (channel["label"] ?? DEFAULTS.escalationLabel) as string;

  const requiredRoles = section["requiredReviewerRoles"] as readonly RoleName[];
  const routing = resolveRouting(
    section,
    requiredRoles,
    modelTransport,
    section["tokenBudget"] as number,
    section["reviewerTokenReserve"] as number,
  );

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
    modelTransport,
    accounts: routing.accounts,
    providers: routing.providers,
    routes: routing.routes,
    ...(section["authoringProvider"] === undefined
      ? {}
      : { authoringProvider: section["authoringProvider"] as AuthoringProvider }),
    ...(section["authoringProviderOverrideReason"] === undefined
      ? {}
      : {
          authoringProviderOverrideReason: section["authoringProviderOverrideReason"] as string,
        }),
    migratedFromModelTransport: routing.migrated,
  };

  return {
    settings,
    host: { maxConcurrentAgents: host["maxConcurrentAgents"] as number },
    // Only FR-054's optional settings and the values actually applied. Routes are resolved rather
    // than defaulted, so they are reported by the run record's `settings.resolved` event instead
    // of here — FR-076's reporting obligation, discharged where resolution is visible rather than
    // by widening what "optional setting" means.
    effectiveOptionalSettings: {
      modelEffort,
      modelTransport,
      "escalationChannel.label": label,
    },
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
