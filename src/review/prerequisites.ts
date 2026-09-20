import {
  missingPermissions,
  REQUIRED_INSTALLATION_PERMISSIONS,
  type PermissionLevel,
} from "../github/auth.js";
import { isGateRequired, type ProtectionOutcome } from "../github/branch-protection.js";
import { MISSING_CREDENTIAL_REASON, type ModelCredential } from "../model/anthropic.js";
import type { RoleOutcome } from "./gate.js";

/**
 * Startup prerequisite verification (FR-003, FR-025, FR-051).
 *
 * Both checks run before any model tokens are spent, and neither is ever *configured* by the
 * service — it verifies and reports. The reason FR-051 exists at all is that a merge gate branch
 * protection does not require is the quietest failure in the system: the service reviews, posts
 * findings, reports a failing gate, and the pull request merges anyway because nothing required
 * the check. Everything looks healthy. One read per run turns that into a loud failure.
 *
 * Permissions are reported before branch protection, because a `403` on the protection endpoint is
 * a *consequence* of a missing `administration: read` and naming the effect before the cause sends
 * an operator to the wrong place.
 */

export interface PrerequisiteInput {
  /** Permissions the installation token actually carries (FR-003). */
  readonly granted: Readonly<Record<string, PermissionLevel>>;
  readonly protection: ProtectionOutcome;
  /** The check-run name branch protection must list. */
  readonly gateName: string;
  readonly baseBranch: string;
  /**
   * The resolved model credential, or `null` when none of the local sources FR-032 permits has
   * one. Checked here rather than at the model call so an absent credential costs nothing and
   * fails with a stated reason, instead of surfacing as a 401 partway through a review.
   */
  readonly modelCredential: ModelCredential | null;
  /**
   * The routing shape the FR-082 check reads. Optional so that every existing caller — and every
   * pre-feature configuration — keeps its current behaviour untouched (SC-005).
   */
  readonly routing?: RoutingIndependenceInput;
  /**
   * Per-provider credentials and the accounts providers draw on (FR-084, R-029).
   *
   * Optional, so a caller that has not moved to routes keeps the single-credential behaviour it
   * has today. When present it is checked *in addition to* `modelCredential`, never instead: a
   * migrated configuration has both, and they agree.
   */
  readonly providerCredentials?: RoutedCredentialInput;
}

/**
 * What the FR-082 independence check needs, and nothing more.
 *
 * Kept as its own shape rather than taking `OperatingSettings` whole, so the rule is testable
 * without constructing a settings file and so it is obvious that the decision rests on exactly
 * three things: who authored, which providers a role is routed to, and what family each is.
 */
export interface RoutingIndependenceInput {
  readonly providers: Readonly<Record<string, { readonly family: string }>>;
  readonly routes: Readonly<Record<string, readonly string[]>>;
  /** Absent means no subject — see `independenceProblem`. */
  readonly authoringProvider?: { readonly name: string; readonly family: string };
  /** Presence is the override; a reason is the point, so there is no boolean (FR-082). */
  readonly authoringProviderOverrideReason?: string;
}

/**
 * FR-082: no required reviewer role may run on the authoring identity's model family.
 *
 * **Families, not vendor labels** (R-021). An aggregator serves several model families through
 * one vendor name, so a check comparing vendor strings can be satisfied in name while the
 * reviewer runs on precisely the model that wrote the diff. Principle VI's whole point is that
 * independence is structural rather than conventional, and a label is not structure.
 *
 * Dormant on this repository today: every provider reachable here is the authoring family, so no
 * `authoringProvider` is declared and the rule has no subject. It is built and tested so that it
 * binds the moment a second family exists, rather than being written under the pressure of
 * wanting one.
 *
 * **No authoring provider declared means the rule does not run**, and that is not a loophole.
 * FR-082 requires the author be named *explicitly* because an inferred one cannot be validated
 * before the spend. With nothing declared there is no subject to compare against — and it is
 * also what lets a pre-feature file keep working (SC-005), since its single provider is both
 * author and reviewer and could never satisfy a rule applied blindly.
 */
export function independenceProblem(input: RoutingIndependenceInput): string | null {
  const { authoringProvider, authoringProviderOverrideReason: override } = input;
  if (authoringProvider === undefined) return null;

  const authoringFamily = authoringProvider.family.toLowerCase();
  const offending: string[] = [];

  for (const [role, route] of Object.entries(input.routes)) {
    for (const name of route) {
      const family = input.providers[name]?.family.toLowerCase();
      if (family !== undefined && family === authoringFamily) {
        offending.push(`${role} → \`${name}\` (family \`${family}\`)`);
      }
    }
  }

  if (offending.length === 0) return null;

  if (override !== undefined && override !== "") {
    // Permitted, and deliberately not silent: the run says what was overridden and why, so the
    // decision is visible in the record rather than only in a settings file nobody re-reads.
    return null;
  }

  return (
    `a required reviewer role is routed to the authoring identity's own model family ` +
    `\`${authoringFamily}\` (via \`${authoringProvider.name}\`): ${offending.join(", ")}. ` +
    `A reviewer drawing on the model that wrote the diff is independent in identity and not in ` +
    `judgement (FR-082, Principle VI). Route the role elsewhere, or record a reason in ` +
    `\`authoringProviderOverrideReason\``
  );
}

export interface ProviderCredentialInput {
  readonly routes: Readonly<Record<string, readonly string[]>>;
  /** Resolved credential per provider name. `null` or absent both mean "not found". */
  readonly credentials: Readonly<Record<string, ModelCredential | null | undefined>>;
}

/** What `checkPrerequisites` needs to run both routed checks: credentials, and the accounts. */
export interface RoutedCredentialInput extends ProviderCredentialInput {
  /** Omitted when the caller does not care about the R-029 shared-account report. */
  readonly providers?: Readonly<Record<string, { readonly account: string }>>;
}

/**
 * FR-084: every provider a route names must have its credential verified before any spend.
 *
 * **A last-resort entry is held to exactly the same standard as a first one.** A fallback nobody
 * verified is not a fallback, and the moment it is reached is the moment nothing else is left to
 * try — so discovering it was never configured at that point is discovering it too late.
 *
 * Only providers some route actually reaches are checked. A declared provider nobody routes to
 * cannot serve a request, so its credential is not yet anybody's problem.
 *
 * An `oauth-profile` credential legitimately carries no key — the harness reads the profile
 * itself — so absence of a key is not absence of a credential. Only a source that promises a key
 * and then supplies an empty one is a failure, which is the same distinction CLAUDE.md draws and
 * `AnthropicModelClient` enforces at construction.
 */
export function missingProviderCredentials(input: ProviderCredentialInput): readonly string[] {
  const routed = new Set(Object.values(input.routes).flat());
  const missing: string[] = [];

  for (const provider of routed) {
    const credential = input.credentials[provider];

    if (credential === null || credential === undefined) {
      missing.push(provider);
      continue;
    }
    if (credential.source !== "oauth-profile" && (credential.apiKey ?? "") === "") {
      missing.push(provider);
    }
  }

  return missing;
}

export interface SharedAccountInput {
  readonly routes: Readonly<Record<string, readonly string[]>>;
  readonly providers: Readonly<Record<string, { readonly account: string }>>;
}

export interface SharedAccountRoute {
  readonly role: string;
  readonly account: string;
  readonly providers: readonly string[];
}

/**
 * Routes whose entries draw on one funding account (R-029).
 *
 * Permitted, and **not** a failure — two model families on one credential are genuinely more
 * independent than one. But they are not more *available*: one session limit ends both, the route
 * exhausts, and the gate closes exactly as it would have with a single provider. Such a pair does
 * not satisfy SC-001.
 *
 * Reported rather than refused, because the operator may want it and the only real danger is
 * believing it bought something it did not.
 */
export function sharedAccountRoutes(input: SharedAccountInput): readonly SharedAccountRoute[] {
  const shared: SharedAccountRoute[] = [];

  for (const [role, route] of Object.entries(input.routes)) {
    if (route.length < 2) continue;

    const byAccount = new Map<string, string[]>();
    for (const name of route) {
      const account = input.providers[name]?.account;
      if (account === undefined) continue;
      byAccount.set(account, [...(byAccount.get(account) ?? []), name]);
    }

    for (const [account, providers] of byAccount) {
      if (providers.length > 1) shared.push({ role, account, providers });
    }
  }

  return shared;
}

export interface PrerequisiteResult {
  readonly satisfied: boolean;
  readonly permissionsHeld: boolean;
  readonly modelCredentialPresent: boolean;
  readonly gateRequiredByBranchProtection: boolean;
  /** FR-082. True when no required role runs on the authoring identity's family. */
  readonly reviewerIndependenceHeld: boolean;
  /** Routed providers whose credential preflight could not find (FR-084). */
  readonly providersMissingCredentials: readonly string[];
  /**
   * Routes whose entries share one funding account (R-029).
   *
   * Never a reason to refuse — reported so that a route which is independent but not resilient
   * is recorded as such rather than mistaken for one that satisfies SC-001.
   */
  readonly sharedAccounts: readonly SharedAccountRoute[];
  /** Named so a human can act on it (FR-024). */
  readonly missing: readonly string[];
  readonly reason: string | null;
  /** Empty on every path: no role runs before prerequisites pass. */
  readonly verdicts: readonly RoleOutcome[];
  /** Always zero — both checks sit ahead of the model call, which is the point of FR-051. */
  readonly tokensSpent: 0;
  readonly escalate: boolean;
}

function protectionReason(
  outcome: ProtectionOutcome,
  gateName: string,
  baseBranch: string,
): string {
  switch (outcome.kind) {
    case "protected":
      return (
        `branch protection on \`${baseBranch}\` does not require the \`${gateName}\` check, so a ` +
        `failing review would not stop a merge; add it to the branch's required status checks ` +
        `(FR-025)`
      );

    case "unprotected":
      return (
        `\`${baseBranch}\` is not protected, so nothing requires the \`${gateName}\` check and a ` +
        `failing review would not stop a merge; protect the branch and add the check (FR-025)`
      );

    case "plan-unsupported":
      // Never "missing permission": the grant may well be held. This is the distinction
      // contracts/github-surface.md records as verified against a real repository.
      return (
        `branch protection is unavailable on this repository's plan, so the \`${gateName}\` check ` +
        `cannot be made required: "${outcome.message}". This is not a permission fault — make the ` +
        `repository public, or upgrade the plan`
      );

    case "permission-missing":
      return (
        `branch protection on \`${baseBranch}\` could not be read, so it is unknown whether the ` +
        `\`${gateName}\` check is required: "${outcome.message}"`
      );
  }
}

export function checkPrerequisites(input: PrerequisiteInput): PrerequisiteResult {
  const { granted, protection, gateName, baseBranch, modelCredential, routing } = input;
  const providerCredentials = input.providerCredentials;

  const missing = missingPermissions(granted, REQUIRED_INSTALLATION_PERMISSIONS);
  const permissionsHeld = missing.length === 0;

  const modelCredentialPresent = modelCredential !== null;
  const gateRequired = isGateRequired(protection, gateName);

  const independence = routing === undefined ? null : independenceProblem(routing);
  const independenceHeld = independence === null;

  const providersMissing =
    providerCredentials === undefined ? [] : missingProviderCredentials(providerCredentials);
  const sharedAccounts =
    providerCredentials?.providers === undefined
      ? []
      : sharedAccountRoutes({
          routes: providerCredentials.routes,
          providers: providerCredentials.providers,
        });

  if (
    permissionsHeld &&
    modelCredentialPresent &&
    gateRequired &&
    independenceHeld &&
    providersMissing.length === 0
  ) {
    return {
      satisfied: true,
      permissionsHeld: true,
      modelCredentialPresent: true,
      gateRequiredByBranchProtection: true,
      reviewerIndependenceHeld: true,
      providersMissingCredentials: [],
      sharedAccounts,
      missing: [],
      reason: null,
      verdicts: [],
      tokensSpent: 0,
      escalate: false,
    };
  }

  const reasons: string[] = [];

  // Permissions first: a protection-endpoint 403 is downstream of a missing `administration: read`.
  if (!permissionsHeld) {
    reasons.push(
      `the installation is missing ${missing.length === 1 ? "a permission" : "permissions"} its ` +
        `work requires: ${missing.join(", ")} (FR-003)`,
    );
  }

  if (!modelCredentialPresent) {
    reasons.push(MISSING_CREDENTIAL_REASON);
  }

  if (!gateRequired) {
    reasons.push(protectionReason(protection, gateName, baseBranch));
  }

  if (independence !== null) {
    reasons.push(independence);
  }

  if (providersMissing.length > 0) {
    reasons.push(
      `${providersMissing.length === 1 ? "a routed provider has" : "routed providers have"} no ` +
        `credential preflight could find: ${providersMissing.join(", ")}. A fallback that has ` +
        `never been verified is not a fallback (FR-084)`,
    );
  }

  return {
    satisfied: false,
    permissionsHeld,
    modelCredentialPresent,
    gateRequiredByBranchProtection: gateRequired,
    reviewerIndependenceHeld: independenceHeld,
    providersMissingCredentials: providersMissing,
    sharedAccounts,
    missing,
    reason: reasons.join("; "),
    verdicts: [],
    tokensSpent: 0,
    escalate: true,
  };
}
