import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  TargetError,
  createTarget,
  parseTargetSlug,
  resolveInTarget,
  targetSlug,
} from "../../../src/config/target.js";

const CHECKOUT = "/tmp/checkouts/run-1";

const target = createTarget({ owner: "owner", name: "name", checkoutPath: CHECKOUT });

describe("parseTargetSlug (FR-026)", () => {
  it("accepts owner/name", () => {
    expect(parseTargetSlug("OneHedgehog/claude-code-agent-team")).toEqual({
      owner: "OneHedgehog",
      name: "claude-code-agent-team",
    });
  });

  it.each(["", "owner", "owner/", "/name", "a/b/c", "  /  ", "owner/na me"])(
    "rejects %o rather than guessing",
    (slug) => {
      expect(() => parseTargetSlug(slug)).toThrow(TargetError);
    },
  );
});

describe("createTarget (FR-027)", () => {
  it("requires an absolute checkout path", () => {
    expect(() =>
      createTarget({ owner: "owner", name: "name", checkoutPath: "relative/path" }),
    ).toThrow(TargetError);
  });

  it.each([
    ["", "name"],
    ["owner", ""],
    ["  ", "name"],
  ])("rejects an empty owner or name (%o, %o)", (owner, name) => {
    expect(() => createTarget({ owner, name, checkoutPath: CHECKOUT })).toThrow(TargetError);
  });

  it("renders its slug for records and ledger addressing", () => {
    expect(targetSlug(target)).toBe("owner/name");
  });
});

describe("resolveInTarget (FR-026, FR-027)", () => {
  it("resolves every path against the checkout the parameter named", () => {
    expect(resolveInTarget(target, ".agents/settings.json")).toBe(
      `${CHECKOUT}/.agents/settings.json`,
    );
    expect(resolveInTarget(target, ".specify", "memory", "constitution.md")).toBe(
      `${CHECKOUT}/.specify/memory/constitution.md`,
    );
  });

  it.each([
    ["parent traversal", ".."],
    ["traversal through a child", "docs/../../escaped"],
    ["absolute path elsewhere", "/etc/passwd"],
    ["deep traversal", "../../../../etc/passwd"],
  ])("rejects a resolved path escaping the checkout — %s", (_label, segment) => {
    expect(() => resolveInTarget(target, segment)).toThrow(TargetError);
  });

  it("treats an escape as a hard error, not a warning that returns a path", () => {
    let returned: string | undefined;
    try {
      returned = resolveInTarget(target, "../outside");
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });

  it("permits the checkout root itself", () => {
    expect(resolveInTarget(target, ".")).toBe(CHECKOUT);
  });
});

describe("no working-directory fallback (FR-027)", () => {
  it("has no built-in identity: a target cannot be constructed without an explicit checkout", () => {
    // @ts-expect-error — the absence of a default is the property under test.
    expect(() => createTarget({ owner: "owner", name: "name" })).toThrow(TargetError);
  });

  it("never reads process.cwd(): the module contains no such call", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../src/config/target.ts", import.meta.url)),
      "utf8",
    );

    // Comments are stripped first: the module's own documentation says it has no `process.cwd()`
    // fallback, and a prose mention must not read as a call.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/process\s*\.\s*cwd/);
  });
});
