import { describe, expect, it } from "vitest";

import {
  REVIEW_GUARDS,
  REVIEW_STATES,
  reviewMachine,
  reviewMachineConfig,
  type GuardName,
  type ReviewState,
} from "../../../src/review/machine.js";

/**
 * Principle VII requires control flow to be declared as data rather than scattered through
 * conditionals, which is only worth anything if the declaration matches the design. These
 * assertions read data-model.md's own state and guard tables, so a state the design names and the
 * machine omits fails here rather than in production.
 */

/** Every state named in data-model.md's ReviewRun state machine, including the guarded exits. */
const STATES_FROM_DATA_MODEL = [
  "resolvingSettings",
  "checkingPrerequisites",
  "checkingIdentity",
  "checkingProgress",
  "checkingSize",
  "checkingBudgets",
  "reviewing",
  "reconciling",
  "reportingGate",
  "done",
  "failingGate",
  "escalating",
  "waitingForReset",
  "halted",
] as const;

/** Every guard named in data-model.md's guarded-exits table. */
const GUARDS_FROM_DATA_MODEL = [
  "settingsInvalid",
  "permissionsMissing",
  "gateNotRequiredByBranchProtection",
  "selfAuthored",
  "noForwardProgress",
  "roundCapExceeded",
  "diffEmpty",
  "diffExceedsReviewableSize",
  "tokenBudgetExhausted",
  "platformReserveReached",
  "rateLimitWaitExceeded",
] as const;

interface DeclaredTransition {
  readonly event: string;
  readonly target: string;
  readonly guard: GuardName | undefined;
}

/** Flattens one state's declared transitions into plain records the assertions can read. */
function transitionsOf(state: ReviewState): DeclaredTransition[] {
  const on = reviewMachineConfig.states[state].on;

  return Object.entries(on).flatMap(([event, branches]) =>
    branches.map((branch) => ({ event, target: branch.target, guard: branch.guard })),
  );
}

/** The transition taken when no guard matches — the state's ordinary forward path. */
function fallthroughTarget(state: ReviewState): string | undefined {
  return transitionsOf(state).find((t) => t.guard === undefined)?.target;
}

function guardedTargets(state: ReviewState): Record<string, string> {
  return Object.fromEntries(
    transitionsOf(state)
      .filter((t) => t.guard !== undefined)
      .map((t) => [t.guard as string, t.target]),
  );
}

describe("declared states (Principle VII)", () => {
  it.each(STATES_FROM_DATA_MODEL)("declares %s", (state) => {
    expect(Object.keys(reviewMachineConfig.states)).toContain(state);
  });

  it("declares no state the design does not name", () => {
    expect(Object.keys(reviewMachineConfig.states).sort()).toEqual(
      [...STATES_FROM_DATA_MODEL].sort(),
    );
  });

  it("exports its state names, so the diagram and the records read one source", () => {
    expect([...REVIEW_STATES].sort()).toEqual([...STATES_FROM_DATA_MODEL].sort());
  });

  it("builds an XState machine from that same declaration", () => {
    expect(Object.keys(reviewMachine.states).sort()).toEqual([...STATES_FROM_DATA_MODEL].sort());
  });

  it("targets only states it declares — no transition points at a state that does not exist", () => {
    for (const state of REVIEW_STATES) {
      for (const transition of transitionsOf(state)) {
        expect(REVIEW_STATES).toContain(transition.target);
      }
    }
  });
});

describe("declared guards (Principle VII)", () => {
  it.each(GUARDS_FROM_DATA_MODEL)("declares %s", (guard) => {
    expect(REVIEW_GUARDS).toContain(guard);
  });

  it("declares no guard the design does not name", () => {
    expect([...REVIEW_GUARDS].sort()).toEqual([...GUARDS_FROM_DATA_MODEL].sort());
  });

  it("uses every guard it declares — no guard is dead", () => {
    const used = new Set(REVIEW_STATES.flatMap((s) => transitionsOf(s).map((t) => t.guard)));

    for (const guard of GUARDS_FROM_DATA_MODEL) {
      expect(used).toContain(guard);
    }
  });

  it("implements every guard it declares, so no transition rests on a missing predicate", () => {
    expect(Object.keys(reviewMachine.implementations.guards ?? {}).sort()).toEqual(
      [...GUARDS_FROM_DATA_MODEL].sort(),
    );
  });
});

describe("the order the design requires", () => {
  it("starts at resolvingSettings", () => {
    expect(reviewMachineConfig.initial).toBe("resolvingSettings");
  });

  it("checks prerequisites immediately after settings, before every other check (FR-051)", () => {
    // FR-051 requires both verifications before any model tokens are spent, so this state sits
    // ahead of identity, progress, size, and budgets.
    expect(fallthroughTarget("resolvingSettings")).toBe("checkingPrerequisites");
  });

  it("runs the remaining checks in the declared order, ending at reviewing", () => {
    expect(fallthroughTarget("checkingPrerequisites")).toBe("checkingIdentity");
    expect(fallthroughTarget("checkingIdentity")).toBe("checkingProgress");
    expect(fallthroughTarget("checkingProgress")).toBe("checkingSize");
    expect(fallthroughTarget("checkingSize")).toBe("checkingBudgets");
    expect(fallthroughTarget("checkingBudgets")).toBe("reviewing");
  });

  it("reaches the gate only through reviewing and reconciling", () => {
    expect(fallthroughTarget("reviewing")).toBe("reconciling");
    expect(fallthroughTarget("reconciling")).toBe("reportingGate");
    expect(fallthroughTarget("reportingGate")).toBe("done");
  });
});

describe("guarded exits (data-model.md)", () => {
  it("fails the gate on invalid settings, spending nothing (FR-028, FR-050)", () => {
    expect(guardedTargets("resolvingSettings")["settingsInvalid"]).toBe("failingGate");
  });

  it("fails the gate on a missing permission and on a gate nothing requires (FR-003, FR-051)", () => {
    const guards = guardedTargets("checkingPrerequisites");

    expect(guards["permissionsMissing"]).toBe("failingGate");
    expect(guards["gateNotRequiredByBranchProtection"]).toBe("failingGate");
  });

  it("escalates a self-authored pull request (FR-004)", () => {
    expect(guardedTargets("checkingIdentity")["selfAuthored"]).toBe("escalating");
  });

  it("escalates a failed round and an exhausted round cap (FR-020, FR-046)", () => {
    const guards = guardedTargets("checkingProgress");

    expect(guards["noForwardProgress"]).toBe("escalating");
    expect(guards["roundCapExceeded"]).toBe("escalating");
  });

  it("escalates an exhausted token budget (FR-031)", () => {
    expect(guardedTargets("checkingBudgets")["tokenBudgetExhausted"]).toBe("escalating");
  });
});

describe("the empty-diff exit (FR-052)", () => {
  it("hangs off checkingSize, where the design places it", () => {
    expect(guardedTargets("checkingSize")["diffEmpty"]).toBe("failingGate");
  });

  it("sits beside the reviewable-size exit, which also spends nothing (FR-037)", () => {
    expect(guardedTargets("checkingSize")["diffExceedsReviewableSize"]).toBe("failingGate");
  });

  it("never reaches reviewing, so no verdict is recorded for either role", () => {
    const emptyDiffTargets = transitionsOf("checkingSize")
      .filter((t) => t.guard === "diffEmpty")
      .map((t) => t.target);

    expect(emptyDiffTargets).not.toContain("reviewing");
  });
});

describe("terminal states", () => {
  it("makes done and halted final, so nothing runs after them", () => {
    expect(reviewMachineConfig.states.done.type).toBe("final");
    expect(reviewMachineConfig.states.halted.type).toBe("final");
  });

  it("has no path from failingGate that reaches done", () => {
    const targets = transitionsOf("failingGate").map((t) => t.target);

    expect(targets).not.toContain("done");
    expect(targets).toContain("escalating");
  });

  it("always escalates before halting, so a stop is never silent (Principle VII)", () => {
    expect(transitionsOf("escalating").map((t) => t.target)).toContain("halted");
  });

  it("routes an unhandled error to failingGate from any state (FR-023)", () => {
    expect(reviewMachineConfig.on["ERROR"]?.map((t) => t.target)).toContain("failingGate");
  });
});

describe("staleness (FR-017)", () => {
  it("has no transition that reads a stored verdict — reviewing is entered on every run", () => {
    // The only route to reportingGate runs through reviewing and reconciling; no edge skips them
    // by consulting a prior approval.
    expect(transitionsOf("checkingBudgets").map((t) => t.target)).not.toContain("reportingGate");
    expect(transitionsOf("checkingBudgets").map((t) => t.target)).toContain("reviewing");
  });
});

describe("rate-limit waiting (FR-040)", () => {
  it("diverts to waitingForReset at the platform reserve rather than failing", () => {
    expect(guardedTargets("checkingBudgets")["platformReserveReached"]).toBe("waitingForReset");
  });

  it("loops waitingForReset back to checkingBudgets rather than onward to reviewing", () => {
    expect(fallthroughTarget("waitingForReset")).toBe("checkingBudgets");
  });

  it("escalates a wait past the configured maximum (FR-040)", () => {
    expect(guardedTargets("checkingBudgets")["rateLimitWaitExceeded"]).toBe("escalating");
  });
});
