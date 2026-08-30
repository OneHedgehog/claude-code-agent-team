import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthError,
  appPrivateKeyPath,
  InstallationTokenProvider,
  readAppPrivateKey,
  type InstallationTokenExchange,
} from "../../../src/github/auth.js";

/**
 * Minting the reviewing identity's token (FR-002, FR-022).
 *
 * Only a GitHub App can create a check run, so this token — not the authoring PAT — is what makes
 * the author/reviewer separation structural rather than conventional. Two properties are asserted
 * beyond "it works":
 *
 * The token is refreshed **before** it expires, never in response to a `401`. Refreshing on `401`
 * looks equivalent and is not: it turns every expiry into a failed platform call, and a service
 * that treats a `401` as routine cannot distinguish an expired token from a revoked installation —
 * which is exactly the signal FR-022 depends on.
 *
 * And a private key readable by anyone else on the machine is refused, the way ssh refuses one.
 * The key is the only durable secret in the system; the token it mints lasts an hour.
 */

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEA",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "github-app-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function writeKey(mode: number, contents = PEM): string {
  const path = join(directory, "review-app.pem");
  writeFileSync(path, contents);
  chmodSync(path, mode);

  return path;
}

describe("where the App's private key lives", () => {
  it("is ~/.config/github-app/review-app.pem, matching the by-hand script", () => {
    expect(appPrivateKeyPath({ HOME: "/home/dev" })).toBe(
      "/home/dev/.config/github-app/review-app.pem",
    );
  });

  it("is relocatable through GITHUB_APP_CONFIG_DIR, as the script allows", () => {
    expect(appPrivateKeyPath({ GITHUB_APP_CONFIG_DIR: "/elsewhere" })).toBe(
      "/elsewhere/review-app.pem",
    );
  });
});

describe("refusing a private key other users can read (FR-022)", () => {
  it("reads a key at 0600", () => {
    expect(readAppPrivateKey(writeKey(0o600))).toContain("PRIVATE KEY");
  });

  it.each([
    ["group-readable", 0o640],
    ["world-readable", 0o644],
    ["world-writable", 0o666],
    ["executable", 0o700],
  ])("refuses a %s key rather than using it", (_label, mode) => {
    expect(() => readAppPrivateKey(writeKey(mode))).toThrow(AuthError);
  });

  it("names the file and the fix, so the refusal is actionable", () => {
    const path = writeKey(0o644);

    expect(() => readAppPrivateKey(path)).toThrow(/chmod 600/);
    expect(() => readAppPrivateKey(path)).toThrow(new RegExp(path.replace(/[/\\]/g, "\\$&")));
  });

  it("refuses a missing key with the command that stores one", () => {
    expect(() => readAppPrivateKey(join(directory, "absent.pem"))).toThrow(/--set-key/);
  });

  it("refuses a file that is not a PEM private key", () => {
    expect(() => readAppPrivateKey(writeKey(0o600, "ghp_not_a_private_key"))).toThrow(AuthError);
  });

  it("never puts the key's own bytes in the error it raises (FR-032)", () => {
    const secret = "-----BEGIN RSA PRIVATE KEY-----\nSUPERSECRETMATERIAL\n";
    let message = "";

    try {
      readAppPrivateKey(writeKey(0o644, secret));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain("SUPERSECRETMATERIAL");
  });
});

describe("minting and refreshing the installation token (FR-002)", () => {
  const HOUR = 3_600_000;
  const START = Date.parse("2026-08-20T12:00:00.000Z");

  function exchangeReturning(): {
    exchange: InstallationTokenExchange;
    calls: () => number;
  } {
    let issued = 0;

    return {
      exchange: {
        installationForRepo: () => Promise.resolve({ installationId: 1, appSlug: "reviewer-app" }),
        createInstallationAccessToken: vi.fn(() => {
          issued += 1;
          return Promise.resolve({
            token: `ghs_token_${issued}`,
            expires_at: new Date(START + issued * HOUR).toISOString(),
            permissions: { checks: "write", pull_requests: "write" },
          });
        }),
      },
      calls: () => issued,
    };
  }

  function providerAt(clock: { now: number }, marginSeconds?: number) {
    const { exchange, calls } = exchangeReturning();

    const provider = new InstallationTokenProvider({
      exchange,
      installationId: 42,
      now: () => new Date(clock.now),
      ...(marginSeconds === undefined ? {} : { refreshMarginSeconds: marginSeconds }),
    });

    return { provider, calls };
  }

  it("mints a token carrying its permissions and expiry", async () => {
    const clock = { now: START };
    const { provider } = providerAt(clock);

    const auth = await provider.authenticate();

    expect(auth.token).toBe("ghs_token_1");
    expect(auth.permissions).toEqual({ checks: "write", pull_requests: "write" });
  });

  it("reuses the token while it is comfortably valid rather than minting per call", async () => {
    const clock = { now: START };
    const { provider, calls } = providerAt(clock);

    await provider.authenticate();
    await provider.authenticate();
    clock.now = START + 10 * 60_000;
    await provider.authenticate();

    expect(calls()).toBe(1);
  });

  it("refreshes before the token expires, not at the moment it does", async () => {
    const clock = { now: START };
    const { provider, calls } = providerAt(clock, 300);

    await provider.authenticate();

    // One second inside the margin: still valid to GitHub, and already refreshed here.
    clock.now = START + HOUR - 299_000;
    const refreshed = await provider.authenticate();

    expect(calls()).toBe(2);
    expect(refreshed.token).toBe("ghs_token_2");
    expect(clock.now).toBeLessThan(START + HOUR);
  });

  it("keeps the token while the margin has not been reached", async () => {
    const clock = { now: START };
    const { provider, calls } = providerAt(clock, 300);

    await provider.authenticate();
    clock.now = START + HOUR - 301_000;
    await provider.authenticate();

    expect(calls()).toBe(1);
  });

  it("mints again once the token has actually expired", async () => {
    const clock = { now: START };
    const { provider, calls } = providerAt(clock);

    await provider.authenticate();
    clock.now = START + HOUR + 1;
    await provider.authenticate();

    expect(calls()).toBe(2);
  });
});

describe("the token is never refreshed in response to a 401 (FR-022)", () => {
  it("exposes no entry point a failed call could use to invalidate the token", () => {
    const surface = Object.getOwnPropertyNames(InstallationTokenProvider.prototype);
    const onFailure = surface.filter((name) =>
      /invalidate|onUnauthorized|on401|retry|refreshOnError|clear/i.test(name),
    );

    expect(onFailure).toEqual([]);
  });

  it("returns the same cached token to a caller that has just seen a 401", async () => {
    const createInstallationAccessToken = vi.fn(() =>
      Promise.resolve({
        token: "ghs_cached",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { checks: "write" },
      }),
    );

    const provider = new InstallationTokenProvider({
      exchange: {
        createInstallationAccessToken,
        installationForRepo: () => Promise.resolve({ installationId: 1, appSlug: "reviewer-app" }),
      },
      installationId: 42,
    });

    const first = await provider.authenticate();

    // The caller's request failed with a 401. Nothing about that reaches the provider, which is
    // the point: expiry is a clock question, and a 401 that is not expiry is a revoked
    // installation that re-minting would only hide.
    const second = await provider.authenticate();

    expect(second.token).toBe(first.token);
    expect(createInstallationAccessToken).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed mint, so the next call tries again", async () => {
    const createInstallationAccessToken = vi
      .fn()
      .mockRejectedValueOnce(new Error("network unreachable"))
      .mockResolvedValueOnce({
        token: "ghs_second_attempt",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { checks: "write" },
      });

    const provider = new InstallationTokenProvider({
      exchange: {
        createInstallationAccessToken,
        installationForRepo: () => Promise.resolve({ installationId: 1, appSlug: "reviewer-app" }),
      },
      installationId: 42,
    });

    await expect(provider.authenticate()).rejects.toThrow("network unreachable");
    await expect(provider.authenticate()).resolves.toMatchObject({ token: "ghs_second_attempt" });
  });
});
