/**
 * GitHub App JWT to installation-token exchange, and the permission comparison FR-051 makes
 * before any model tokens are spent (FR-002, FR-003).
 *
 * The token response carries the permissions it was granted, so the service compares that against
 * the set contracts/github-surface.md declares rather than discovering an absence mid-review as a
 * 403. The exchange itself is delegated to `@octokit/app` (research.md R-004) behind a narrow
 * interface, so the comparison is unit-testable without a network or a private key.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { App } from "@octokit/app";

export class AuthError extends Error {
  override readonly name = "AuthError";
}

/**
 * Exactly the permissions contracts/github-surface.md requires. `administration` is `read` and
 * must never become `write`: an identity that can change branch protection can remove the gate.
 */
export const REQUIRED_INSTALLATION_PERMISSIONS = {
  checks: "write",
  pull_requests: "write",
  contents: "write",
  issues: "write",
  administration: "read",
} as const satisfies Record<string, PermissionLevel>;

export type PermissionLevel = "none" | "read" | "write" | "admin";

const LEVEL_ORDER: Readonly<Record<PermissionLevel, number>> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

function isPermissionLevel(value: unknown): value is PermissionLevel {
  return typeof value === "string" && value in LEVEL_ORDER;
}

/** Whether a held level covers a required one. `write` covers `read`; `read` never covers `write`. */
export function satisfies(held: string, required: string): boolean {
  if (!isPermissionLevel(held) || !isPermissionLevel(required)) return false;

  return LEVEL_ORDER[held] >= LEVEL_ORDER[required];
}

/** Reads the granted permissions from an installation token response. */
export function parsePermissions(response: unknown): Record<string, PermissionLevel> {
  if (response === null || typeof response !== "object" || !("permissions" in response)) {
    throw new AuthError(
      "installation token response carries no `permissions`: an absent map is not an empty grant",
    );
  }

  const raw: unknown = response.permissions;
  if (raw === null || typeof raw !== "object") {
    throw new AuthError("installation token response `permissions` is not an object");
  }

  const permissions: Record<string, PermissionLevel> = {};
  for (const [scope, level] of Object.entries(raw)) {
    if (!isPermissionLevel(level)) {
      throw new AuthError(
        `installation permission ${JSON.stringify(scope)} has an unrecognized level ${JSON.stringify(level)}`,
      );
    }
    permissions[scope] = level;
  }

  return permissions;
}

/**
 * Every required permission the installation does not hold, named so the gate's reason can name it
 * too (FR-024). Returns every absence rather than only the first.
 */
export function missingPermissions(
  granted: Readonly<Record<string, string>>,
  required: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(required)
    .filter(([scope, level]) => !satisfies(granted[scope] ?? "none", level))
    .map(([scope, level]) => `${scope}: ${level}`);
}

export interface InstallationAuth {
  readonly token: string;
  readonly permissions: Record<string, PermissionLevel>;
  readonly expiresAt: string;
}

/** The slice of `@octokit/app` this module needs, narrowed so tests can supply their own. */
export interface InstallationTokenExchange {
  createInstallationAccessToken(input: { installationId: number }): Promise<unknown>;
  /**
   * The installation on a repository, read with the App's own JWT: its id, and the slug of the App
   * it belongs to.
   *
   * Both are discovered rather than stored, exactly as `scripts/github-app-token.sh` discovers the
   * id. A value kept in a file is a third thing to keep in sync with the App and the installation,
   * and it is the one of the three that nothing would notice going stale — the App would simply
   * mint tokens for an installation it no longer has.
   *
   * The slug rides along because it is the **reviewing identity**: GitHub reports an App's author
   * login as `<slug>[bot]`, which is what FR-004 compares a pull request's author against. It is
   * read here rather than derived from anything to hand, because every value that looks like it
   * would do — the repository's name, the App's display name — is a different string that happens
   * to coincide sometimes, and a self-review check that silently never fires is worse than none.
   */
  installationForRepo(input: {
    owner: string;
    repo: string;
  }): Promise<{ installationId: number; appSlug: string }>;
}

export async function authenticateInstallation(options: {
  installationId: number;
  exchange: InstallationTokenExchange;
}): Promise<InstallationAuth> {
  const response = await options.exchange.createInstallationAccessToken({
    installationId: options.installationId,
  });

  const permissions = parsePermissions(response);
  const body = response as { token?: unknown; expires_at?: unknown };

  if (typeof body.token !== "string" || body.token === "") {
    throw new AuthError("installation token response carries no token");
  }
  if (typeof body.expires_at !== "string") {
    throw new AuthError("installation token response carries no expiry");
  }

  return { token: body.token, permissions, expiresAt: body.expires_at };
}

/**
 * The App's own credentials on disk, and the provider that turns them into the reviewing identity's
 * short-lived token (FR-002, FR-022).
 *
 * This mirrors `scripts/github-app-token.sh`, which stays as the by-hand path — a script an
 * operator can run to diagnose an installation without booting the service is worth more than the
 * duplication costs. The two must agree on where the key lives and on refusing a key other users
 * can read, which is why both are asserted here rather than only in the script.
 *
 * The key is a file rather than a keychain entry for a reason worth keeping written down:
 * `security add-generic-password -w` truncates a piped value at 128 characters, and a 2048-bit PEM
 * base64s to roughly 2,300 — it would be stored silently corrupted.
 */

/** Where the App's credentials live. `GITHUB_APP_CONFIG_DIR` relocates them, as the script allows. */
export function appConfigDirectory(env: Record<string, string | undefined>): string {
  const configured = env["GITHUB_APP_CONFIG_DIR"];
  if (typeof configured === "string" && configured !== "") return configured;

  return join(env["HOME"] ?? homedir(), ".config", "github-app");
}

export function appPrivateKeyPath(env: Record<string, string | undefined>): string {
  return join(appConfigDirectory(env), "review-app.pem");
}

export function appIdPath(env: Record<string, string | undefined>): string {
  return join(appConfigDirectory(env), "app-id");
}

/**
 * Reads the App's private key, refusing one any other user on the machine can read — the way ssh
 * refuses one. This is the only durable secret in the system; everything it mints lasts an hour.
 *
 * The key's own bytes never appear in a message raised from here. An error that quotes the file it
 * failed to accept would put a private key into a log, which is the failure FR-032 exists to
 * prevent, at the one moment somebody is certain to be reading the output.
 */
export function readAppPrivateKey(path: string): string {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    throw new AuthError(
      `no App private key at ${path}: store one with ` +
        `\`./scripts/github-app-token.sh --set-key < your-app.private-key.pem\``,
    );
  }

  if (mode !== 0o600) {
    throw new AuthError(
      `${path} has permissions ${mode.toString(8).padStart(3, "0")}; a private key other users ` +
        `can read is refused. Run: chmod 600 '${path}'`,
    );
  }

  const contents = readFileSync(path, "utf8");

  if (!contents.includes("PRIVATE KEY")) {
    // Named rather than quoted: whatever this file holds, it is not ours to echo.
    throw new AuthError(`${path} does not contain a PEM private key`);
  }

  return contents;
}

export function readAppId(path: string): string {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new AuthError(
      `no App ID at ${path}: store one with \`./scripts/github-app-token.sh --set-app-id <id>\``,
    );
  }

  const appId = contents.trim();
  if (!/^\d+$/.test(appId)) {
    throw new AuthError(`${path} does not contain a numeric App ID`);
  }

  return appId;
}

/** The `@octokit/app`-backed exchange. The JWT is minted and signed inside the SDK (R-004). */
export function createInstallationTokenExchange(options: {
  appId: string;
  privateKey: string;
}): InstallationTokenExchange {
  const app = new App({ appId: options.appId, privateKey: options.privateKey });

  return {
    async createInstallationAccessToken(input: { installationId: number }): Promise<unknown> {
      const response = await app.octokit.request(
        "POST /app/installations/{installation_id}/access_tokens",
        { installation_id: input.installationId },
      );

      return response.data;
    },

    async installationForRepo(input: {
      owner: string;
      repo: string;
    }): Promise<{ installationId: number; appSlug: string }> {
      const response = await app.octokit.request("GET /repos/{owner}/{repo}/installation", {
        owner: input.owner,
        repo: input.repo,
      });

      const appSlug = response.data.app_slug;
      if (typeof appSlug !== "string" || appSlug === "") {
        throw new AuthError(
          `the installation on ${input.owner}/${input.repo} reports no \`app_slug\`, so the ` +
            "reviewing identity cannot be determined and FR-004's self-review check would not fire",
        );
      }

      return { installationId: response.data.id, appSlug };
    },
  };
}

/**
 * Refresh **before** expiry, so a `401` never becomes routine.
 *
 * Refreshing on `401` looks equivalent and is not. It turns every expiry into a failed platform
 * call, and — worse — it makes an expired token and a revoked installation indistinguishable, since
 * both arrive as `401` and both would be answered by minting again. FR-022's separation depends on
 * a revoked installation being loud. Expiry is a clock question and is answered from the clock.
 */
const DEFAULT_REFRESH_MARGIN_SECONDS = 300;

export interface InstallationTokenProviderOptions {
  readonly exchange: InstallationTokenExchange;
  readonly installationId: number;
  readonly now?: () => Date;
  readonly refreshMarginSeconds?: number;
}

export class InstallationTokenProvider {
  readonly #exchange: InstallationTokenExchange;
  readonly #installationId: number;
  readonly #now: () => Date;
  readonly #marginMs: number;

  #cached: InstallationAuth | null = null;

  constructor(options: InstallationTokenProviderOptions) {
    this.#exchange = options.exchange;
    this.#installationId = options.installationId;
    this.#now = options.now ?? ((): Date => new Date());
    this.#marginMs = (options.refreshMarginSeconds ?? DEFAULT_REFRESH_MARGIN_SECONDS) * 1000;
  }

  /**
   * The current installation token, minted on first use and refreshed once it comes within the
   * margin of expiring. There is deliberately no way for a caller to invalidate it: a failed
   * request is the caller's to report, not a reason to mint.
   */
  async authenticate(): Promise<InstallationAuth> {
    const cached = this.#cached;

    if (cached !== null && Date.parse(cached.expiresAt) - this.#now().getTime() > this.#marginMs) {
      return cached;
    }

    // Assigned only after the exchange resolves: a failed mint must not poison the cache, or one
    // network blip would strand the service on a token it never obtained.
    const minted = await authenticateInstallation({
      installationId: this.#installationId,
      exchange: this.#exchange,
    });

    this.#cached = minted;

    return minted;
  }

  /** The permissions the current token carries, for the FR-051 check. */
  async permissions(): Promise<Record<string, PermissionLevel>> {
    return (await this.authenticate()).permissions;
  }
}
