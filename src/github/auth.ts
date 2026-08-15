/**
 * GitHub App JWT to installation-token exchange, and the permission comparison FR-051 makes
 * before any model tokens are spent (FR-002, FR-003).
 *
 * The token response carries the permissions it was granted, so the service compares that against
 * the set contracts/github-surface.md declares rather than discovering an absence mid-review as a
 * 403. The exchange itself is delegated to `@octokit/app` (research.md R-004) behind a narrow
 * interface, so the comparison is unit-testable without a network or a private key.
 */

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
