import type { RoleOutcome } from "../gate.js";

/**
 * The empty and whitespace-only diff refusal (FR-052).
 *
 * A pull request with nothing to review gets neither an approval nor a skip. An approval would
 * make a degenerate pull request look like an ordinary one that passed; a skip is the non-failing
 * gate Principle IV prohibits. Refusing makes it visibly abnormal, which is the point.
 */

export interface EmptyDiffResult {
  readonly empty: boolean;
  /** Empty by construction: FR-052 records no verdict for either role. */
  readonly verdicts: readonly RoleOutcome[];
  /** Always zero — this check sits ahead of the model call. */
  readonly tokensSpent: 0;
  readonly reason: string | null;
}

/**
 * Whether a unified diff carries any change beyond whitespace.
 *
 * The `+++` and `---` file headers begin with the same characters as added and removed lines, so
 * counting naively would make every empty diff look like it had two changes. They are excluded
 * before anything else is considered.
 */
export function hasSubstantiveChange(diff: string): boolean {
  const added: string[] = [];
  const removed: string[] = [];

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;

    if (line.startsWith("+")) added.push(line.slice(1).replace(/\s+/g, ""));
    else if (line.startsWith("-")) removed.push(line.slice(1).replace(/\s+/g, ""));
  }

  if (added.length === 0 && removed.length === 0) return false;

  // Whitespace-only: the added and removed lines are the same content once spacing is collapsed.
  const addedRest = [...added].sort();
  const removedRest = [...removed].sort();

  if (addedRest.length !== removedRest.length) return true;

  return addedRest.some((line, index) => line !== removedRest[index]);
}

export function checkEmptyDiff(diff: string): EmptyDiffResult {
  if (hasSubstantiveChange(diff)) {
    return { empty: false, verdicts: [], tokensSpent: 0, reason: null };
  }

  return {
    empty: true,
    verdicts: [],
    tokensSpent: 0,
    reason:
      "there is nothing to review: the diff is empty or contains only whitespace changes, " +
      "so no verdict was recorded and no model tokens were spent (FR-052)",
  };
}
