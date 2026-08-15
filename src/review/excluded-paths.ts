/**
 * The excluded-path set (FR-053, research.md R-016).
 *
 * Two sources and no third: whatever version control reports as binary, plus the paths matching
 * the declared `excludedPathPatterns` setting. There is deliberately **no generated-file
 * heuristic** — one cannot be audited and can silently over-match, and an over-matching detector
 * would drop real source from the changed-line count, quietly shrinking a pull request under the
 * Principle X cap. Build output is kept out of the repository by `.gitignore` and never reaches a
 * diff, so what remains is committed on purpose.
 */

export type ExclusionSource = "vcs-binary" | "declared-pattern";

export interface ExcludedPathEntry {
  readonly path: string;
  readonly source: ExclusionSource;
}

export interface ExcludedPaths {
  readonly paths: string[];
  readonly entries: ExcludedPathEntry[];
  readonly count: number;
}

/** Converts one glob to an anchored regular expression over `/`-separated paths. */
function toRegExp(pattern: string): RegExp {
  let source = "";

  for (let i = 0; i < pattern.length; i += 1) {
    const rest = pattern.slice(i);

    if (rest.startsWith("**/")) {
      // Zero or more leading segments, so `**/*.lock` matches `a.lock` as well as `d/a.lock`.
      source += "(?:.*/)?";
      i += 2;
      continue;
    }
    if (rest.startsWith("/**")) {
      source += "(?:/.*)?";
      i += 2;
      continue;
    }
    if (rest.startsWith("**")) {
      source += ".*";
      i += 1;
      continue;
    }

    const char = pattern[i] as string;
    if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      // Everything else is literal — a pattern is a path, not a regular expression.
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`^${source}$`);
}

const cache = new Map<string, RegExp>();

export function matchesPattern(path: string, pattern: string): boolean {
  let compiled = cache.get(pattern);
  if (compiled === undefined) {
    compiled = toRegExp(pattern);
    cache.set(pattern, compiled);
  }

  return compiled.test(path);
}

/** Reads the paths git reported as binary from `git diff --numstat` output. */
export function binaryPathsFromNumstat(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.split("\t"))
    .filter((columns) => columns[0] === "-" && columns[1] === "-")
    .map((columns) => columns[2] ?? "")
    .filter((path) => path !== "");
}

export function resolveExcludedPaths(input: {
  changedPaths: readonly string[];
  binaryPaths: readonly string[];
  patterns: readonly string[];
}): ExcludedPaths {
  const entries: ExcludedPathEntry[] = [];

  for (const path of input.changedPaths) {
    // Version control's own report comes first, so a binary file matching a declared pattern is
    // attributed to the harder fact rather than to the softer one.
    if (input.binaryPaths.includes(path)) {
      entries.push({ path, source: "vcs-binary" });
      continue;
    }
    if (input.patterns.some((pattern) => matchesPattern(path, pattern))) {
      entries.push({ path, source: "declared-pattern" });
    }
  }

  return { paths: entries.map((entry) => entry.path), entries, count: entries.length };
}
