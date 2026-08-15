import { isAbsolute, resolve, sep } from "node:path";

/**
 * The repository under review, supplied as an explicit parameter (FR-026, FR-027).
 *
 * The constitution's Governance → Scope clause requires the orchestrator to reach the target's
 * constitution and settings through this parameter rather than through its own working directory,
 * so the single-target/multi-target seam stays addressable while only one target is supported.
 * There is deliberately no `process.cwd()` anywhere in this module: a fallback would make the
 * distinction disappear the first time someone forgot the flag.
 */

export class TargetError extends Error {
  override readonly name = "TargetError";
}

export interface TargetRepository {
  readonly owner: string;
  readonly name: string;
  /** Absolute path to the working tree this run inspects. */
  readonly checkoutPath: string;
}

/** GitHub's own owner and repository name grammar. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export function parseTargetSlug(slug: string): { owner: string; name: string } {
  const parts = slug.split("/");
  const [owner, name] = parts;

  if (parts.length !== 2 || owner === undefined || name === undefined) {
    throw new TargetError(`--target must be \`owner/name\`, received ${JSON.stringify(slug)}`);
  }
  if (!SEGMENT.test(owner) || !SEGMENT.test(name)) {
    throw new TargetError(`--target must be \`owner/name\`, received ${JSON.stringify(slug)}`);
  }

  return { owner, name };
}

export function createTarget(input: {
  owner: string;
  name: string;
  checkoutPath: string;
}): TargetRepository {
  const { owner, name, checkoutPath } = input;

  if (typeof owner !== "string" || owner.trim() === "") {
    throw new TargetError("target owner is required and must be non-empty");
  }
  if (typeof name !== "string" || name.trim() === "") {
    throw new TargetError("target name is required and must be non-empty");
  }
  if (typeof checkoutPath !== "string" || checkoutPath.trim() === "") {
    throw new TargetError(
      "target checkoutPath is required: there is no working-directory fallback (FR-027)",
    );
  }
  if (!isAbsolute(checkoutPath)) {
    throw new TargetError(
      `target checkoutPath must be absolute, received ${JSON.stringify(checkoutPath)}`,
    );
  }

  return { owner, name, checkoutPath: resolve(checkoutPath) };
}

export function targetSlug(target: TargetRepository): string {
  return `${target.owner}/${target.name}`;
}

/**
 * Resolves a path inside the target's checkout. A resolved path that escapes the checkout is a
 * hard error rather than a warning — data-model.md, TargetRepository.
 */
export function resolveInTarget(target: TargetRepository, ...segments: string[]): string {
  const root = target.checkoutPath;
  const resolved = resolve(root, ...segments);

  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new TargetError(
      `resolved path escapes the target checkout: ${JSON.stringify(resolved)} is outside ${JSON.stringify(root)}`,
    );
  }

  return resolved;
}
