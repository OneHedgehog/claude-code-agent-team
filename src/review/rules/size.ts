import type { FindingDraftInput } from "../findings.js";
import { changedLineCount, type DiffIndex } from "../locations.js";

/**
 * The Principle X discipline cap, and the justification that clears it (FR-043).
 *
 * The count comes from `locations.ts` rather than from a second counter here, because two
 * independent counters drifting apart is exactly what FR-053 exists to prevent — the reviewable
 * cap (FR-037) measures the same lines the same way.
 *
 * The escape is a *stated* justification, in a section a reader can find, because "state, in its
 * description, why the change is irreducible" is only meaningful if the statement is locatable.
 * A passing mention of the phrase is not a justification.
 */

const JUSTIFICATION_SECTION = /^[ \t]*#{1,6}[ \t]*size justification[ \t]*$/im;

/**
 * Whether the pull request description carries a `## Size justification` section with something
 * under it. An empty section is not a justification.
 */
export function hasSizeJustification(body: string): boolean {
  const match = JUSTIFICATION_SECTION.exec(body);
  if (match === null) return false;

  const after = body.slice(match.index + match[0].length);

  // Anything up to the next heading is the justification; it has to be non-empty.
  const untilNextHeading = after.split(/^[ \t]*#{1,6}[ \t]/m)[0] ?? "";

  return untilNextHeading.trim() !== "";
}

export interface SizeResult {
  readonly changedLines: number;
  readonly justified: boolean;
  readonly findings: FindingDraftInput[];
}

export function checkPullRequestSize(input: {
  index: DiffIndex;
  excludedPaths: readonly string[];
  maxPullRequestSize: number;
  pullRequestBody: string;
}): SizeResult {
  const changedLines = changedLineCount(input.index, input.excludedPaths);
  const justified = hasSizeJustification(input.pullRequestBody);

  if (changedLines <= input.maxPullRequestSize || justified) {
    return { changedLines, justified, findings: [] };
  }

  return {
    changedLines,
    justified,
    findings: [
      {
        role: "implementation",
        rule: "pull-request-size",
        severity: "high",
        // Blocking regardless of the configured severity threshold: Principle X is non-negotiable,
        // and the escape it defines is a justification, not a lower threshold.
        blocking: true,
        location: { pullRequestLevel: true },
        description: `This pull request changes ${changedLines} lines, over the configured maximum of ${input.maxPullRequestSize} (measured with excluded paths removed). Split it into independently shippable features, or state in the description, under a \`## Size justification\` heading, why the change is irreducible (Principle X, FR-043).`,
      },
    ],
  };
}
