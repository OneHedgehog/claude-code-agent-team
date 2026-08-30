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

/**
 * Reads the paths git reported as binary out of a unified diff.
 *
 * The companion to `binaryPathsFromNumstat` below, for the caller that has a diff and no working
 * tree. It is still *git's own report* rather than a heuristic of ours — git decides a file is
 * binary and then says so, in one of the two ways it says it: a `Binary files … differ` line when
 * the patch is omitted, and a `GIT binary patch` header when it is included. Reading the report is
 * what keeps FR-053's second source a fact rather than an inference.
 *
 * The path is taken from the `Binary files` line when there is one, because a rename shows
 * different paths on the two sides and the post-image is the one the changed-line count and the
 * anchoring index are keyed on. A deleted binary has `/dev/null` as its post-image, so the
 * pre-image path is used there instead — otherwise a deletion would be excluded under a name no
 * file has.
 */
export function binaryPathsFromDiff(diff: string): string[] {
  const paths: string[] = [];
  let headerPath: string | null = null;

  const add = (path: string | null): void => {
    if (path === null || path === "" || paths.includes(path)) return;
    paths.push(path);
  };

  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/u.exec(line);
    if (header !== null) {
      headerPath = header[2] ?? null;
      continue;
    }

    const differ =
      /^Binary files (?:a\/(.+?)|\/dev\/null) and (?:b\/(.+?)|\/dev\/null) differ$/u.exec(line);
    if (differ !== null) {
      // Post-image first, pre-image for a deletion, and the header only if neither parsed.
      add(differ[2] ?? differ[1] ?? headerPath);
      continue;
    }

    if (line === "GIT binary patch") {
      add(headerPath);
    }
  }

  return paths;
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
