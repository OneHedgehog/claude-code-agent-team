import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// From the build output rather than from `src/`: Node's type stripping runs this file directly but
// does not rewrite a `.js` specifier onto a `.ts` source. `npm run check` builds before it reaches
// the diagram check, so `dist/` is always present by then.
import { reviewMachineConfig, REVIEW_STATES, type ReviewState } from "../dist/review/machine.js";

/**
 * Generates the statechart diagram from the machine declaration (Principle VII).
 *
 * The constitution requires that "the machine's diagram MUST be generated from that declaration so
 * the picture cannot drift from the behavior". Generating it is only half of that: `--check` is
 * what makes the requirement enforceable, and it runs inside `npm run check`, so a change to the
 * machine that leaves the committed diagram stale fails the same gate a type error would.
 */

const DOC_PATH = fileURLToPath(new URL("../docs/independent-review-service.md", import.meta.url));

const BEGIN = "<!-- BEGIN GENERATED STATECHART -->";
const END = "<!-- END GENERATED STATECHART -->";

/** Terminal states, drawn as such so a reader can see where a run can come to rest. */
const FINAL_STATES: ReadonlySet<ReviewState> = new Set(
  REVIEW_STATES.filter((state) => reviewMachineConfig.states[state].type === "final"),
);

function renderMermaid(): string {
  const lines: string[] = ["stateDiagram-v2"];

  lines.push(`  [*] --> ${reviewMachineConfig.initial}`);

  for (const state of REVIEW_STATES) {
    const declaration = reviewMachineConfig.states[state];

    for (const [event, branches] of Object.entries(declaration.on)) {
      for (const branch of branches) {
        const label = branch.guard === undefined ? event : `${event} [${branch.guard}]`;
        lines.push(`  ${state} --> ${branch.target}: ${label}`);
      }
    }
  }

  // Transitions available from every state, drawn once from a shared node rather than as an edge
  // per state — fourteen identical arrows would bury the ordinary flow.
  for (const [event, branches] of Object.entries(reviewMachineConfig.on)) {
    for (const branch of branches) {
      lines.push(`  anyState --> ${branch.target}: ${event}`);
    }
  }

  for (const state of FINAL_STATES) {
    lines.push(`  ${state} --> [*]`);
  }

  lines.push("  note right of anyState");
  lines.push("    Available from every state (FR-023).");
  lines.push("  end note");

  return lines.join("\n");
}

function render(): string {
  return [BEGIN, "", "```mermaid", renderMermaid(), "```", "", END].join("\n");
}

function splice(document: string, block: string): string {
  const start = document.indexOf(BEGIN);
  const end = document.indexOf(END);

  if (start === -1 || end === -1) {
    throw new Error(
      `docs/independent-review-service.md is missing the ${BEGIN} / ${END} markers the ` +
        `generated statechart is spliced between`,
    );
  }

  return document.slice(0, start) + block + document.slice(end + END.length);
}

const checkOnly = process.argv.includes("--check");

const document = readFileSync(DOC_PATH, "utf8");
const updated = splice(document, render());

if (checkOnly) {
  if (updated !== document) {
    process.stderr.write(
      "The committed statechart diagram no longer matches src/review/machine.ts.\n" +
        "Run `npm run diagram` to regenerate it (Principle VII).\n",
    );
    process.exit(1);
  }

  process.exit(0);
}

if (updated !== document) {
  writeFileSync(DOC_PATH, updated);
}
