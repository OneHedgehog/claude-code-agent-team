import { describe, expect, it } from "vitest";

import {
  binaryPathsFromDiff,
  binaryPathsFromNumstat,
  matchesPattern,
  resolveExcludedPaths,
} from "../../../src/review/excluded-paths.js";

const CHANGED = [
  "src/cli.ts",
  "package-lock.json",
  "pnpm.lock",
  "tests/__snapshots__/a.snap",
  "assets/logo.png",
  "dist/bundle.js",
  "src/vendor.min.js",
];

const PATTERNS = ["package-lock.json", "**/*.lock", "**/__snapshots__/**"];

function resolve(binaryPaths: readonly string[] = ["assets/logo.png"]) {
  return resolveExcludedPaths({ changedPaths: CHANGED, binaryPaths, patterns: PATTERNS });
}

describe("the exclusion set is a union of exactly two sources (FR-053)", () => {
  it("excludes what version control reports as binary", () => {
    expect(resolve().paths).toContain("assets/logo.png");
  });

  it("excludes what the settings declare", () => {
    const { paths } = resolve();

    expect(paths).toContain("package-lock.json");
    expect(paths).toContain("pnpm.lock");
    expect(paths).toContain("tests/__snapshots__/a.snap");
  });

  it("excludes nothing else", () => {
    expect(resolve().paths.sort()).toEqual(
      ["assets/logo.png", "package-lock.json", "pnpm.lock", "tests/__snapshots__/a.snap"].sort(),
    );
  });

  it("attributes each exclusion to its source, so it traces to a declaration rather than a guess", () => {
    const { entries } = resolve();

    expect(entries).toContainEqual({ path: "assets/logo.png", source: "vcs-binary" });
    expect(entries).toContainEqual({ path: "package-lock.json", source: "declared-pattern" });
  });

  it("reports the count the check-run output carries (FR-053)", () => {
    expect(resolve().count).toBe(4);
  });
});

describe("no generated-file heuristic fires (FR-053)", () => {
  it.each(["dist/bundle.js", "src/vendor.min.js"])(
    "does not exclude %s, which resembles build output but is not declared",
    (path) => {
      expect(resolve().paths).not.toContain(path);
    },
  );

  it("excludes build output only when the settings actually declare it", () => {
    const declared = resolveExcludedPaths({
      changedPaths: CHANGED,
      binaryPaths: [],
      patterns: ["dist/**"],
    });

    expect(declared.paths).toEqual(["dist/bundle.js"]);
  });

  it("excludes nothing at all when the declared list is empty and nothing is binary", () => {
    expect(
      resolveExcludedPaths({ changedPaths: CHANGED, binaryPaths: [], patterns: [] }).paths,
    ).toEqual([]);
  });

  it("treats an empty pattern list as an explicit declaration, not as a missing setting", () => {
    expect(
      resolveExcludedPaths({ changedPaths: CHANGED, binaryPaths: [], patterns: [] }).count,
    ).toBe(0);
  });

  it("never excludes a path the diff did not touch", () => {
    const { paths } = resolveExcludedPaths({
      changedPaths: ["src/cli.ts"],
      binaryPaths: [],
      patterns: ["**/*.lock"],
    });

    expect(paths).toEqual([]);
  });

  it("lists a path once even when both sources match it", () => {
    const { paths, entries } = resolveExcludedPaths({
      changedPaths: ["a.lock"],
      binaryPaths: ["a.lock"],
      patterns: ["**/*.lock"],
    });

    expect(paths).toEqual(["a.lock"]);
    expect(entries).toHaveLength(1);
  });
});

describe("pattern matching", () => {
  it.each([
    ["package-lock.json", "package-lock.json", true],
    ["package-lock.json", "src/package-lock.json", false],
    ["**/*.lock", "a.lock", true],
    ["**/*.lock", "deep/nested/a.lock", true],
    ["**/*.lock", "a.locked", false],
    ["**/__snapshots__/**", "tests/__snapshots__/a.snap", true],
    ["**/__snapshots__/**", "__snapshots__/a.snap", true],
    ["**/__snapshots__/**", "tests/snapshots/a.snap", false],
    ["dist/**", "dist/bundle.js", true],
    ["dist/**", "dist/deep/bundle.js", true],
    ["dist/**", "src/dist.ts", false],
    ["*.ts", "cli.ts", true],
    ["*.ts", "src/cli.ts", false],
  ])("pattern %o against %o is %s", (pattern, path, expected) => {
    expect(matchesPattern(path, pattern)).toBe(expected);
  });

  it("treats a pattern as a literal path rather than a regular expression", () => {
    expect(matchesPattern("aXb.json", "a.b.json")).toBe(false);
  });
});

describe("reading git's own binary report", () => {
  it("takes the paths git reported as binary and nothing else", () => {
    const numstat = ["12\t3\tsrc/cli.ts", "-\t-\tassets/logo.png", "0\t4\tdocs/readme.md"].join(
      "\n",
    );

    expect(binaryPathsFromNumstat(numstat)).toEqual(["assets/logo.png"]);
  });

  it("reports nothing for an empty diff", () => {
    expect(binaryPathsFromNumstat("")).toEqual([]);
  });
});

describe("reading git's binary report out of a unified diff", () => {
  it("takes the post-image path from a `Binary files … differ` line", () => {
    const diff = [
      "diff --git a/src/cli.ts b/src/cli.ts",
      "--- a/src/cli.ts",
      "+++ b/src/cli.ts",
      "@@ -1,1 +1,2 @@",
      " const a = 1;",
      "+const b = 2;",
      "diff --git a/assets/logo.png b/assets/logo.png",
      "index 0000000..1111111",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
    ].join("\n");

    expect(binaryPathsFromDiff(diff)).toEqual(["assets/logo.png"]);
  });

  it("takes the added path when the pre-image is /dev/null", () => {
    const diff = [
      "diff --git a/assets/logo.png b/assets/logo.png",
      "new file mode 100644",
      "Binary files /dev/null and b/assets/logo.png differ",
    ].join("\n");

    expect(binaryPathsFromDiff(diff)).toEqual(["assets/logo.png"]);
  });

  it("falls back to the pre-image path when the binary file was deleted", () => {
    const diff = [
      "diff --git a/assets/old.png b/assets/old.png",
      "deleted file mode 100644",
      "Binary files a/assets/old.png and /dev/null differ",
    ].join("\n");

    // Excluding a deletion under `/dev/null` would exclude a path no file has, leaving the real
    // one counted as reviewable content.
    expect(binaryPathsFromDiff(diff)).toEqual(["assets/old.png"]);
  });

  it("reads the header path when the patch itself is included", () => {
    const diff = [
      "diff --git a/assets/logo.png b/assets/logo.png",
      "index 0000000..1111111",
      "GIT binary patch",
      "literal 70",
      "zcmV",
    ].join("\n");

    expect(binaryPathsFromDiff(diff)).toEqual(["assets/logo.png"]);
  });

  it("reports nothing for a diff with no binary file in it", () => {
    const diff = [
      "diff --git a/src/cli.ts b/src/cli.ts",
      "--- a/src/cli.ts",
      "+++ b/src/cli.ts",
      "@@ -1,1 +1,2 @@",
      "+const b = 2;",
    ].join("\n");

    expect(binaryPathsFromDiff(diff)).toEqual([]);
  });
});
