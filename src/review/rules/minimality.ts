import type { FindingDraftInput } from "../findings.js";

/**
 * Scope minimality — content the diff carries that no spec asked for (FR-042, Principle X).
 *
 * Principle X enumerates the categories, and calls unrelated content "a blocking finding under
 * Principle VI regardless of size". These findings therefore state `blocking` explicitly rather
 * than deriving it from the configured severity threshold: a repository that raised its threshold
 * must not be able to turn Principle X off as a side effect.
 *
 * Agents are unusually prone to exactly this failure, since generating an adjacent improvement
 * costs them nothing and costs the reviewer everything.
 */

export const MINIMALITY_CATEGORIES = [
  "unrelated-refactor",
  "opportunistic-rename",
  "formatting-only",
  "unrequired-dependency",
  "dead-code",
] as const;

export type MinimalityCategory = (typeof MINIMALITY_CATEGORIES)[number];

export interface MinimalityObservation {
  readonly category: MinimalityCategory;
  readonly path: string;
  readonly line?: number;
  /** The content itself, so the finding names what has to go. */
  readonly detail: string;
}

const CATEGORY_STATEMENT: Readonly<Record<MinimalityCategory, string>> = {
  "unrelated-refactor":
    "refactors code this feature does not touch. Adjacent cleanup belongs in its own spec and its own pull request",
  "opportunistic-rename":
    "renames something the feature did not need renamed, which makes the feature commit un-revertible on its own",
  "formatting-only":
    "reformats lines the change does not otherwise touch, which costs the reviewer attention the change did not need",
  "unrequired-dependency":
    "changes a dependency this feature does not require. YAGNI is enforced at the diff, not only at the design",
  "dead-code":
    "adds commented-out or dead code. Deleted code lives in version control, not in a comment",
};

export function checkMinimality(input: {
  observations: readonly MinimalityObservation[];
  excludedPaths: readonly string[];
}): FindingDraftInput[] {
  return input.observations
    .filter((observation) => !input.excludedPaths.includes(observation.path))
    .map((observation) => ({
      role: "implementation" as const,
      rule: `minimality:${observation.category}`,
      severity: "high" as const,
      // Blocking regardless of threshold: Principle X is non-negotiable.
      blocking: true,
      location:
        observation.line === undefined
          ? { pullRequestLevel: true as const }
          : { path: observation.path, line: observation.line, side: "RIGHT" as const },
      description: `\`${observation.path}\` ${CATEGORY_STATEMENT[observation.category]}: ${observation.detail}`,
    }));
}

/** Comment bodies that read as code rather than as prose. */
const CODE_COMMENT = /[;{}]\s*$/;
const CODE_KEYWORD =
  /^\s*(?:return|const|let|var|if|else|for|while|do|switch|case|function|class|import|export|await|throw|new)\b/;

/**
 * A deterministic detector for the one category that does not need a judgement: an added line that
 * is a commented-out statement. Prose comments are left alone — the test for "is this code" is
 * whether the body ends like a statement or opens with a statement keyword.
 */
export function detectCommentedOutCode(diff: string): MinimalityObservation[] {
  const observations: MinimalityObservation[] = [];

  let path = "";
  let rightLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      path = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git ") || line.startsWith("index ")) {
      continue;
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      rightLine = Number(hunk[1]);
      continue;
    }

    if (line.startsWith("-")) continue;

    if (line.startsWith("+")) {
      const content = line.slice(1);
      const comment = /^\s*\/\/\s?(.*)$/.exec(content);

      if (comment?.[1] !== undefined) {
        const body = comment[1];
        if (CODE_COMMENT.test(body) || CODE_KEYWORD.test(body)) {
          observations.push({ category: "dead-code", path, line: rightLine, detail: body });
        }
      }
    }

    rightLine += 1;
  }

  return observations;
}
