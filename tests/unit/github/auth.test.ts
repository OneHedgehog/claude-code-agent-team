import { describe, expect, it } from "vitest";

import {
  AuthError,
  REQUIRED_INSTALLATION_PERMISSIONS,
  authenticateInstallation,
  missingPermissions,
  parsePermissions,
  satisfies,
} from "../../../src/github/auth.js";

const GRANTED = {
  checks: "write",
  pull_requests: "write",
  contents: "write",
  issues: "write",
  administration: "read",
  metadata: "read",
} as const;

describe("the permission set the work requires (FR-003, contracts/github-surface.md)", () => {
  it("declares exactly the permissions the platform surface names", () => {
    expect(REQUIRED_INSTALLATION_PERMISSIONS).toEqual({
      checks: "write",
      pull_requests: "write",
      contents: "write",
      issues: "write",
      administration: "read",
    });
  });

  it("never requires administration write — an identity that can change branch protection can remove the gate", () => {
    expect(REQUIRED_INSTALLATION_PERMISSIONS.administration).toBe("read");
  });
});

describe("parsing the granted permissions from the token response (FR-051)", () => {
  it("reads the permissions map", () => {
    expect(parsePermissions({ permissions: GRANTED })).toEqual(GRANTED);
  });

  it("treats an absent permissions map as an error, not as an empty grant", () => {
    expect(() => parsePermissions({})).toThrow(AuthError);
  });

  it("rejects a non-string permission level rather than coercing it", () => {
    expect(() => parsePermissions({ permissions: { checks: 1 } })).toThrow(AuthError);
  });

  it("rejects a permission level outside the platform's own scale", () => {
    expect(() => parsePermissions({ permissions: { checks: "superuser" } })).toThrow(AuthError);
  });
});

describe("permission level ordering", () => {
  it.each([
    ["write satisfies read", "write", "read", true],
    ["write satisfies write", "write", "write", true],
    ["admin satisfies write", "admin", "write", true],
    ["read does not satisfy write", "read", "write", false],
    ["none satisfies nothing", "none", "read", false],
  ])("%s", (_label, held, required, expected) => {
    expect(satisfies(held, required)).toBe(expected);
  });
});

describe("comparing granted against required (FR-003, FR-051)", () => {
  it("finds nothing missing when every permission is held", () => {
    expect(missingPermissions(GRANTED, REQUIRED_INSTALLATION_PERMISSIONS)).toEqual([]);
  });

  it("names an absent permission so the gate reason can name it too (FR-024)", () => {
    const { checks: _checks, ...withoutChecks } = GRANTED;

    expect(missingPermissions(withoutChecks, REQUIRED_INSTALLATION_PERMISSIONS)).toEqual([
      "checks: write",
    ]);
  });

  it("names a permission held at too low a level", () => {
    expect(
      missingPermissions({ ...GRANTED, checks: "read" }, REQUIRED_INSTALLATION_PERMISSIONS),
    ).toEqual(["checks: write"]);
  });

  it("names every missing permission rather than only the first", () => {
    const missing = missingPermissions(
      { contents: "write", metadata: "read" },
      REQUIRED_INSTALLATION_PERMISSIONS,
    );

    expect(missing).toHaveLength(4);
    expect(missing).toEqual(
      expect.arrayContaining([
        "checks: write",
        "pull_requests: write",
        "issues: write",
        "administration: read",
      ]),
    );
  });

  it("accepts a permission held above the level required", () => {
    expect(
      missingPermissions(
        { ...GRANTED, administration: "write" },
        REQUIRED_INSTALLATION_PERMISSIONS,
      ),
    ).toEqual([]);
  });
});

describe("App JWT to installation-token exchange (FR-002, FR-003)", () => {
  /** Stands in for `@octokit/app`, so the exchange is testable without a network or a key. */
  function fakeExchange(response: unknown) {
    return {
      calls: [] as unknown[],
      // eslint-disable-next-line @typescript-eslint/require-await
      async createInstallationAccessToken(input: unknown): Promise<unknown> {
        this.calls.push(input);
        return response;
      },
      installationForRepo: (): Promise<{ installationId: number; appSlug: string }> =>
        Promise.resolve({ installationId: 1, appSlug: "reviewer-app" }),
    };
  }

  it("returns the token together with the permissions it was granted", async () => {
    const exchange = fakeExchange({
      token: "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      expires_at: "2026-08-15T13:00:00Z",
      permissions: GRANTED,
    });

    const auth = await authenticateInstallation({ installationId: 42, exchange });

    expect(auth.token).toBe("ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(auth.permissions).toEqual(GRANTED);
    expect(auth.expiresAt).toBe("2026-08-15T13:00:00Z");
  });

  it("addresses the exchange by installation", async () => {
    const exchange = fakeExchange({
      token: "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      expires_at: "2026-08-15T13:00:00Z",
      permissions: GRANTED,
    });

    await authenticateInstallation({ installationId: 42, exchange });

    expect(exchange.calls).toEqual([{ installationId: 42 }]);
  });

  it("fails when the response carries no token, rather than proceeding unauthenticated", async () => {
    const exchange = fakeExchange({ expires_at: "2026-08-15T13:00:00Z", permissions: GRANTED });

    await expect(authenticateInstallation({ installationId: 42, exchange })).rejects.toThrow(
      AuthError,
    );
  });

  it("fails when the response carries no permissions, rather than assuming the set is held", async () => {
    const exchange = fakeExchange({ token: "ghs_x", expires_at: "2026-08-15T13:00:00Z" });

    await expect(authenticateInstallation({ installationId: 42, exchange })).rejects.toThrow(
      AuthError,
    );
  });
});
