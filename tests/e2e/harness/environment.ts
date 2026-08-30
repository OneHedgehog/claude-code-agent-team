import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";

import {
  appIdPath,
  appPrivateKeyPath,
  createInstallationTokenExchange,
  InstallationTokenProvider,
  missingPermissions,
  readAppId,
  readAppPrivateKey,
  REQUIRED_INSTALLATION_PERMISSIONS,
  type PermissionLevel,
} from "../../../src/github/auth.js";
import {
  classifyProtectionResponse,
  isGateRequired,
} from "../../../src/github/branch-protection.js";
import { MERGE_GATE_CHECK_NAME } from "../../../src/github/check-run.js";
import { macosKeychainReader } from "../../../src/model/anthropic.js";

/**
 * Resolving the fixture repository and its credentials, and refusing to run against a fixture that
 * is not actually configured (tasks.md T032, research.md R-015).
 *
 * The end-to-end layer is the only one that touches GitHub, so it is the only one that can be
 * broken by something outside the repository — an App that was uninstalled, a token that expired,
 * a branch whose protection somebody relaxed. Every one of those failures surfaces, without a
 * preflight, as an unrelated assertion failing several hundred lines into a scenario.
 *
 * So the preflight below is not a convenience. It is what keeps Principle II's third layer
 * meaningful: when the suite is red, this file is what says whether the *service* regressed or the
 * *fixture* did, and it names the human step that fixes the latter.
 *
 * It refuses rather than skips. A suite that quietly skips when its fixture is absent reports
 * green on a machine where it has never run, which is the state in which an end-to-end layer stops
 * being a brake and gets deleted.
 */

export class HarnessError extends Error {
  override readonly name = "HarnessError";
}

/** The fixture repository, overridable so a fork can run the suite against its own copy. */
const DEFAULT_FIXTURE_SLUG = "OneHedgehog/fixture-repo-ad";

/**
 * The base branch most scenarios open against: protected, with the gate a *required* check. Nearly
 * every scenario needs the gate to be required, because FR-051 stops the run before spending when
 * it is not.
 */
export const GATED_BASE_BRANCH = "main";

/**
 * The base branch quickstart scenario 26 opens against: deliberately *without* the gate among its
 * required checks. It is a standing branch rather than a mid-suite reconfiguration because a suite
 * that rewrote branch protection would need `administration: write` on the fixture, and a run that
 * crashed between the two writes would leave the fixture in whichever state it happened to reach.
 */
export const UNGATED_BASE_BRANCH = "unprotected-base";

/**
 * What the composition root asks a token source for: the token, the grant it carries, and the App
 * it belongs to. The last is the reviewing identity FR-004 compares against.
 */
export interface InstallationCredential {
  readonly token: string;
  readonly permissions: Record<string, PermissionLevel>;
  readonly appSlug: string;
}

export interface FixtureRepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export interface FixtureEnvironment {
  readonly repository: FixtureRepositoryRef;
  readonly gatedBaseBranch: string;
  readonly ungatedBaseBranch: string;
  /**
   * The *authoring* identity: a user token, distinct from the App. Every fixture pull request is
   * opened with it, because a pull request opened by the reviewing identity trips FR-004's
   * self-review check and no scenario but 18 wants that.
   */
  readonly authorToken: string;
  /** Mints an installation token for the App on the fixture, cached until it nears expiry. */
  readonly installationToken: () => Promise<InstallationCredential>;
  /**
   * Mints an installation token carrying **only** the permissions named — quickstart scenario 26's
   * second half.
   *
   * GitHub itself narrows the token, so the missing permission is genuinely missing rather than
   * reported missing by a stub: the token that reaches `composeService` really cannot read branch
   * protection, and `adapters.permissions()` really answers without it. A harness that faked the
   * permission map instead would assert that `checkPrerequisites` reads a map, which is a unit
   * test's job and is already covered by T077.
   *
   * Uncached on purpose. It is a one-off for a scenario that stops immediately, and caching a
   * deliberately crippled token beside the real one is exactly the mix-up worth not risking.
   */
  readonly restrictedInstallationToken: (
    permissions: Readonly<Record<string, PermissionLevel>>,
  ) => Promise<InstallationCredential>;
  /** Where `withWorktree` keeps the fixture's mirror and per-review worktrees. */
  readonly cacheDirectory: string;
  readonly env: Record<string, string | undefined>;
}

function parseSlug(slug: string): FixtureRepositoryRef {
  const [owner, name, ...rest] = slug.split("/");

  if (owner === undefined || name === undefined || rest.length > 0 || owner === "" || name === "") {
    throw new HarnessError(`FIXTURE_REPO must be \`owner/name\`, received ${JSON.stringify(slug)}`);
  }

  return { owner, name };
}

/**
 * The authoring token, resolved without ever putting it in a message. `FIXTURE_AUTHOR_TOKEN` first
 * so a fork can supply its own; the keychain last, because that is where CLAUDE.md says this
 * machine keeps it.
 */
function resolveAuthorToken(env: Record<string, string | undefined>): string | null {
  const fromEnv = env["FIXTURE_AUTHOR_TOKEN"] ?? env["GITHUB_MCP_PAT"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();

  const fromKeychain = macosKeychainReader("github-mcp-pat")();

  return fromKeychain === null || fromKeychain === "" ? null : fromKeychain;
}

/**
 * Builds the environment handle. Cheap and offline: it reads paths and the keychain but talks to
 * no network, so a test file can construct it at module scope and let `preflight` do the reaching.
 */
export function fixtureEnvironment(
  overrides: {
    readonly env?: Record<string, string | undefined>;
    readonly slug?: string;
  } = {},
): FixtureEnvironment {
  const env = overrides.env ?? process.env;
  const repository = parseSlug(overrides.slug ?? env["FIXTURE_REPO"] ?? DEFAULT_FIXTURE_SLUG);

  const authorToken = resolveAuthorToken(env);
  if (authorToken === null) {
    throw new HarnessError(
      "no authoring token: set FIXTURE_AUTHOR_TOKEN, or store a fine-grained PAT in the macOS " +
        "keychain under `github-mcp-pat`. It must be a user token — the App cannot author the " +
        "pull requests it reviews (FR-004).",
    );
  }

  const idPath = appIdPath(env);
  const keyPath = appPrivateKeyPath(env);

  if (!existsSync(idPath) || !existsSync(keyPath)) {
    throw new HarnessError(
      `no GitHub App credentials at ${idPath} and ${keyPath}. Store them with ` +
        "`./scripts/github-app-token.sh --set-app-id <id>` and `--set-key < your-app.private-key.pem`.",
    );
  }

  const appId = readAppId(idPath);
  const privateKey = readAppPrivateKey(keyPath);

  const exchange = createInstallationTokenExchange({ appId, privateKey });

  // Discovered on first use rather than at construction, so building the handle stays offline.
  let discovered: Promise<{ provider: InstallationTokenProvider; appSlug: string }> | null = null;

  const installation = (): Promise<{ provider: InstallationTokenProvider; appSlug: string }> => {
    discovered ??= exchange
      .installationForRepo({ owner: repository.owner, repo: repository.name })
      .then(
        ({ installationId, appSlug }) => ({
          provider: new InstallationTokenProvider({ exchange, installationId }),
          appSlug,
        }),
        (error: unknown) => {
          // Reset so a transient failure does not poison every later call with a settled rejection.
          discovered = null;

          throw new HarnessError(
            `the App is not installed on ${repository.owner}/${repository.name}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );

    return discovered;
  };

  const installationToken = async (): Promise<InstallationCredential> => {
    const { provider, appSlug } = await installation();
    const auth = await provider.authenticate();

    return { token: auth.token, permissions: auth.permissions, appSlug };
  };

  const restrictedInstallationToken = async (
    permissions: Readonly<Record<string, PermissionLevel>>,
  ): Promise<InstallationCredential> => {
    const { appSlug } = await installation();
    const { installationId } = await exchange.installationForRepo({
      owner: repository.owner,
      repo: repository.name,
    });

    const { data } = await new App({ appId, privateKey }).octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      { installation_id: installationId, permissions },
    );

    // The App is the same App; only its grant is narrower. Carrying the real slug is what keeps
    // this scenario about the missing permission rather than about a second identity.
    return { token: data.token, permissions: data.permissions ?? {}, appSlug };
  };

  return {
    repository,
    gatedBaseBranch: GATED_BASE_BRANCH,
    ungatedBaseBranch: UNGATED_BASE_BRANCH,
    authorToken,
    installationToken,
    restrictedInstallationToken,
    cacheDirectory: join(env["HOME"] ?? homedir(), ".cache", "review-service-e2e"),
    env,
  };
}

/** One unmet prerequisite, carrying the step that satisfies it rather than only the symptom. */
export interface UnmetPrerequisite {
  readonly what: string;
  readonly remedy: string;
}

export interface PreflightReport {
  readonly satisfied: boolean;
  readonly unmet: readonly UnmetPrerequisite[];
}

/**
 * Runs a request whose *unsuccessful* status is the answer rather than a failure.
 *
 * Octokit throws on any non-2xx, which is right for a client and wrong for three questions the
 * harness asks: is this branch protected (404 means no), does this file exist (404 means no), and
 * is the authoring identity refused the gate (403 means yes, correctly). Catching the `HttpError`
 * and returning its status is what turns those back into answers. A thrown error with no status is
 * a real transport failure and is re-thrown untouched.
 */
export async function statusOf(
  request: () => Promise<{ status: number; data: unknown }>,
): Promise<{ status: number; data: unknown }> {
  try {
    return await request();
  } catch (error) {
    const { status, response } = error as {
      status?: number;
      response?: { data?: unknown };
    };

    if (typeof status !== "number") throw error;

    return { status, data: response?.data ?? null };
  }
}

/**
 * Whether a branch requires the gate, classified exactly as the service classifies it — the same
 * function, so the preflight cannot disagree with the prerequisite check it is standing in for.
 */
async function branchGateState(
  octokit: Octokit,
  repository: FixtureRepositoryRef,
  branch: string,
): Promise<{ required: boolean; detail: string }> {
  const response = await statusOf(() =>
    octokit.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", {
      owner: repository.owner,
      repo: repository.name,
      branch,
    }),
  );

  const outcome = classifyProtectionResponse(response.status, response.data);

  const detail =
    outcome.kind === "protected"
      ? outcome.requiredContexts.join(", ") || "protected, but with no required status checks"
      : outcome.kind;

  return { required: isGateRequired(outcome, MERGE_GATE_CHECK_NAME), detail };
}

/**
 * Reaches the fixture and reports every prerequisite it does not satisfy — all of them, not the
 * first, so one round-trip tells a human everything they have to fix.
 */
export async function preflight(environment: FixtureEnvironment): Promise<PreflightReport> {
  const { repository } = environment;
  const slug = `${repository.owner}/${repository.name}`;
  const unmet: UnmetPrerequisite[] = [];

  let permissions: Record<string, PermissionLevel> | null = null;
  let appOctokit: Octokit | null = null;

  try {
    const authenticated = await environment.installationToken();
    permissions = authenticated.permissions;
    appOctokit = new Octokit({ auth: authenticated.token });
  } catch (error) {
    unmet.push({
      what: `the App does not authenticate against ${slug}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      remedy: `install the App on ${slug} — docs/prerequisites.md §6.`,
    });
  }

  if (permissions !== null) {
    const missing = missingPermissions(permissions, REQUIRED_INSTALLATION_PERMISSIONS);
    if (missing.length > 0) {
      unmet.push({
        what: `the installation is missing ${missing.join(", ")}`,
        remedy:
          "grant the permissions in contracts/github-surface.md, then accept the updated " +
          "permission request on the installation.",
      });
    }
  }

  if (appOctokit !== null) {
    for (const path of [".agents/settings.json", ".specify/memory/constitution.md"]) {
      const response = await statusOf(() =>
        appOctokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
          owner: repository.owner,
          repo: repository.name,
          path,
          ref: environment.gatedBaseBranch,
        }),
      );

      if (response.status !== 200) {
        unmet.push({
          what: `${slug} carries no ${path} on ${environment.gatedBaseBranch}`,
          remedy: `seed it — the service reads both through --target and fails without them.`,
        });
      }
    }

    const gated = await branchGateState(appOctokit, repository, environment.gatedBaseBranch);
    if (!gated.required) {
      unmet.push({
        what:
          `${MERGE_GATE_CHECK_NAME} is not a required status check on ` +
          `${slug}@${environment.gatedBaseBranch} (${gated.detail})`,
        remedy:
          `protect ${environment.gatedBaseBranch} and type \`${MERGE_GATE_CHECK_NAME}\` into its ` +
          "required status checks by hand — docs/prerequisites.md §6, steps 6a–6e. The usual " +
          "round-trip of letting GitHub discover the context is circular here: the service only " +
          "emits it when it runs, and it refuses to run until the check is required.",
      });
    }

    const ungated = await branchGateState(appOctokit, repository, environment.ungatedBaseBranch);
    if (ungated.required) {
      unmet.push({
        what:
          `${MERGE_GATE_CHECK_NAME} *is* a required check on ` +
          `${slug}@${environment.ungatedBaseBranch}, which quickstart scenario 26 needs it not to be`,
        remedy: `remove ${MERGE_GATE_CHECK_NAME} from ${environment.ungatedBaseBranch}'s required checks.`,
      });
    }
  }

  try {
    const author = new Octokit({ auth: environment.authorToken });
    const { data } = await author.rest.users.getAuthenticated();

    if (data.type !== "User") {
      unmet.push({
        what: `the authoring token authenticates as a ${data.type}, not a user`,
        remedy: "supply a fine-grained personal access token as FIXTURE_AUTHOR_TOKEN.",
      });
    }
  } catch (error) {
    unmet.push({
      what: `the authoring token does not authenticate: ${
        error instanceof Error ? error.message : String(error)
      }`,
      remedy:
        "store a fine-grained PAT scoped to the fixture repository under the keychain service " +
        "`github-mcp-pat`, or set FIXTURE_AUTHOR_TOKEN.",
    });
  }

  return { satisfied: unmet.length === 0, unmet };
}

/**
 * Preflights and throws unless everything is satisfied. What every e2e file calls in `beforeAll`,
 * so an unconfigured fixture reports itself once, in the words of the step that fixes it, instead
 * of as an unrelated assertion failing deep inside a scenario.
 */
export async function requireFixtureEnvironment(
  environment: FixtureEnvironment,
): Promise<FixtureEnvironment> {
  const report = await preflight(environment);

  if (!report.satisfied) {
    const lines = report.unmet.map((item) => `  - ${item.what}\n    → ${item.remedy}`);

    throw new HarnessError(
      `the end-to-end fixture is not configured; ${report.unmet.length} prerequisite(s) unmet:\n` +
        `${lines.join("\n")}\n\n` +
        "These are human steps by design (spec Assumptions): an identity that could provision " +
        "them could also remove its own gate.",
    );
  }

  return environment;
}
