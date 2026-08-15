import type { FindingDraftInput } from "../findings.js";

/**
 * Missing tests, and a missing or stale `docs/` document (FR-016, Principles II and IX).
 *
 * The structural half is decidable from paths alone: a behavior change that ships no test, or no
 * document, is a blocking finding. The content half — a document that exists but still describes
 * behavior the code no longer has — is a judgement, so it arrives as `staleDocuments` from the
 * model boundary and is turned into a finding here. Keeping both in one rule is what stops the two
 * halves from disagreeing about what counts as documentation.
 */

const TEST_PATTERNS = [
  /^tests\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /\.e2e\.[cm]?[jt]sx?$/,
];

export function isTestPath(path: string): boolean {
  return TEST_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Only `docs/` counts. A spec under `specs/` records what was intended at the time and is never
 * rewritten; a document records what is true now. Principle IX forbids substituting one for the
 * other, so a spec update never satisfies this rule.
 */
export function isDocPath(path: string): boolean {
  return path.startsWith("docs/");
}

/** A change to anything that is not a test, a document, or a spec is a behavior change. */
export function isBehaviorPath(path: string): boolean {
  return !isTestPath(path) && !isDocPath(path) && !path.startsWith("specs/");
}

export interface DocumentationInput {
  readonly changedPaths: readonly string[];
  readonly excludedPaths: readonly string[];
  /** Documents the reviewer judged to still describe superseded behavior (FR-016). */
  readonly staleDocuments: readonly string[];
}

export function checkDocumentation(input: DocumentationInput): FindingDraftInput[] {
  const considered = input.changedPaths.filter((path) => !input.excludedPaths.includes(path));

  const findings: FindingDraftInput[] = [];

  const behaviorChanged = considered.some(isBehaviorPath);

  if (behaviorChanged) {
    if (!considered.some(isTestPath)) {
      findings.push({
        role: "implementation",
        rule: "missing-tests",
        severity: "high",
        location: { pullRequestLevel: true },
        description:
          "This change alters behavior but ships no test. New public behavior without a test is a blocking defect, and agent-authored code is not exempt (Principle II).",
      });
    }

    if (!considered.some(isDocPath)) {
      findings.push({
        role: "implementation",
        rule: "missing-or-stale-document",
        severity: "high",
        location: { pullRequestLevel: true },
        description:
          "This change alters behavior but updates no document under `docs/`. A feature's document ships in the same pull request as the code, and a behavior change is reflected in it (Principle IX). A spec under `specs/` is not a substitute.",
      });
    }
  }

  for (const document of input.staleDocuments) {
    findings.push({
      role: "implementation",
      rule: "stale-document",
      severity: "high",
      location: { pullRequestLevel: true },
      description: `\`${document}\` describes behavior the code no longer has. Documentation that has fallen behind the code is a blocking finding, not a cleanup task (Principle IX).`,
    });
  }

  return findings;
}
