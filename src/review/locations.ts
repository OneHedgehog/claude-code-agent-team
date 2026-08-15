import type { FindingLocation } from "../model/client.js";
import { isPullRequestLevel } from "../model/client.js";

/**
 * Diff-location resolution and the pull-request-level fallback (FR-010, FR-014).
 *
 * GitHub accepts a line-anchored review comment only for a line the diff actually touches, so a
 * finding about anything else would be rejected outright. FR-014 is explicit that such a finding
 * is recorded at pull request level rather than dropped — a finding the reviewer made and then
 * silently discarded is the worst of both outcomes.
 *
 * The same index carries the changed-line count that `maxPullRequestSize` (FR-043) and
 * `maxReviewableDiffSize` (FR-037) are measured against, so the two can never drift apart.
 */

export interface FileChanges {
  /** Line numbers in the post-image the diff added. */
  readonly right: Set<number>;
  /** Line numbers in the pre-image the diff removed. */
  readonly left: Set<number>;
}

export interface DiffIndex {
  readonly files: Map<string, FileChanges>;
}

const NEW_FILE_HEADER = /^\+\+\+ (?:b\/)?(.+)$/;
const OLD_FILE_HEADER = /^--- (?:a\/)?(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses a unified diff into the lines each file changed.
 *
 * A deleted file's post-image header is `+++ /dev/null`, so the pre-image header is remembered and
 * used as the path in that case — otherwise a deletion would vanish from both the anchoring index
 * and the changed-line count.
 */
export function indexDiff(diff: string): DiffIndex {
  const files = new Map<string, FileChanges>();

  let current: FileChanges | undefined;
  let pendingOldPath: string | undefined;
  let leftLine = 0;
  let rightLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") || line.startsWith("index ")) {
      continue;
    }

    // The pre-image header must be consumed before the removed-line branch below, since both
    // start with `-`.
    const oldFile = OLD_FILE_HEADER.exec(line);
    if (oldFile?.[1] !== undefined && line.startsWith("--- ")) {
      pendingOldPath = oldFile[1];
      continue;
    }

    const newFile = NEW_FILE_HEADER.exec(line);
    if (newFile?.[1] !== undefined && line.startsWith("+++ ")) {
      const path = newFile[1] === "/dev/null" ? (pendingOldPath ?? newFile[1]) : newFile[1];
      current = files.get(path) ?? { right: new Set(), left: new Set() };
      files.set(path, current);
      pendingOldPath = undefined;
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      leftLine = Number(hunk[1]);
      rightLine = Number(hunk[2]);
      continue;
    }

    if (current === undefined) continue;

    if (line.startsWith("+")) {
      current.right.add(rightLine);
      rightLine += 1;
    } else if (line.startsWith("-")) {
      current.left.add(leftLine);
      leftLine += 1;
    } else {
      leftLine += 1;
      rightLine += 1;
    }
  }

  return { files };
}

export function changedPaths(index: DiffIndex): string[] {
  return [...index.files.keys()];
}

export function isAddressable(
  index: DiffIndex,
  path: string,
  line: number,
  side: "LEFT" | "RIGHT",
): boolean {
  const changes = index.files.get(path);
  if (changes === undefined) return false;

  return side === "RIGHT" ? changes.right.has(line) : changes.left.has(line);
}

/**
 * Places a finding. A location the diff cannot carry becomes pull-request level rather than being
 * discarded (FR-014); so does a location on an excluded path (FR-053).
 */
export function resolveLocation(
  index: DiffIndex,
  location: FindingLocation,
  excludedPaths: readonly string[],
): FindingLocation {
  if (isPullRequestLevel(location)) return location;

  const { path, line, side } = location;

  if (excludedPaths.includes(path)) return { pullRequestLevel: true };
  if (!isAddressable(index, path, line, side)) return { pullRequestLevel: true };

  return location;
}

/**
 * Changed lines with the excluded set removed. This is the one counter both size caps read, which
 * is exactly the drift FR-053 exists to prevent.
 */
export function changedLineCount(index: DiffIndex, excludedPaths: readonly string[]): number {
  let total = 0;

  for (const [path, changes] of index.files) {
    if (excludedPaths.includes(path)) continue;
    total += changes.right.size + changes.left.size;
  }

  return total;
}
