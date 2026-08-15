import { assign, createMachine } from "xstate";

import type { GateResult, RoleOutcome } from "./gate.js";

/**
 * The review run's control flow, declared as data (Principle VII, research.md R-009).
 *
 * This declaration is the single source of three things: the machine the run executes, the
 * diagram committed under `docs/`, and the state names the records carry. Ad-hoc control flow is
 * prohibited outright, and every guard here is a place where a stray `if` would later be
 * indistinguishable from a bug.
 *
 * The machine performs no I/O. Each `checking*` state waits for the orchestrator to report what it
 * found, and the guards read that report. That is what keeps the flow inspectable — and what lets
 * the declaration be asserted against data-model.md without booting anything.
 */

export const REVIEW_STATES = [
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

export type ReviewState = (typeof REVIEW_STATES)[number];

/** Every guard in data-model.md's guarded-exits table, and no other. */
export const REVIEW_GUARDS = [
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

export type GuardName = (typeof REVIEW_GUARDS)[number];

/**
 * What each check reported. Absent means "not checked yet"; the guards read only what the
 * orchestrator has actually established, so a check that never ran can never read as a pass.
 */
export interface ReviewFindings {
  readonly settingsInvalid?: boolean;
  readonly missingPermissions?: readonly string[];
  readonly gateRequiredByBranchProtection?: boolean;
  readonly selfAuthored?: boolean;
  readonly forwardProgress?: boolean;
  readonly roundNumber?: number;
  readonly maxReviewRounds?: number;
  readonly changedLines?: number;
  readonly maxReviewableDiffSize?: number;
  readonly diffIsEmpty?: boolean;
  readonly tokenBudgetSufficient?: boolean;
  readonly platformReserveReached?: boolean;
  readonly rateLimitWaitSeconds?: number;
  readonly maxRateLimitWaitSeconds?: number;
}

export interface ReviewContext {
  readonly runId: string;
  readonly target: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly findings: ReviewFindings;
  /** One entry per required role that ran, recorded as the run passes through `reviewing`. */
  readonly roleResults: readonly RoleOutcome[];
  /** The conclusion `gate.ts` derived, recorded as the run reports it (FR-021). */
  readonly gate: GateResult | null;
  /** Stated whenever the gate fails (FR-024). */
  readonly failureReason: string | null;
}

export type ReviewEventObject =
  | { type: "SETTINGS_RESOLVED" }
  | { type: "PREREQUISITES_CHECKED" }
  | { type: "IDENTITY_CHECKED" }
  | { type: "PROGRESS_CHECKED" }
  | { type: "SIZE_CHECKED" }
  | { type: "BUDGETS_CHECKED" }
  | { type: "RESET_ELAPSED" }
  | { type: "REVIEW_COMPLETED"; roleResults: readonly RoleOutcome[] }
  | { type: "RECONCILED" }
  | { type: "GATE_REPORTED"; gate: GateResult }
  | { type: "ESCALATED" }
  | { type: "ERROR"; reason: string };

/** Named side effects the declaration refers to, kept as data like the guards. */
export const REVIEW_ACTIONS = ["recordRoleResults", "recordGate"] as const;

export type ActionName = (typeof REVIEW_ACTIONS)[number];

/** One branch of a transition, in the plain shape the declaration tests and the diagram read. */
interface Branch {
  readonly target: ReviewState;
  readonly guard?: GuardName;
  readonly actions?: readonly ActionName[];
}

interface StateDeclaration {
  readonly type?: "final";
  readonly on: Readonly<Record<string, readonly Branch[]>>;
}

interface MachineDeclaration {
  readonly initial: ReviewState;
  readonly states: Readonly<Record<ReviewState, StateDeclaration>>;
  /** Transitions available from every state. */
  readonly on: Readonly<Record<string, readonly Branch[]>>;
}

/**
 * The declaration itself. Guarded branches come first and the unguarded branch last: XState takes
 * the first branch whose guard passes, so the unguarded one is the ordinary forward path.
 */
export const reviewMachineConfig: MachineDeclaration = {
  initial: "resolvingSettings",

  // FR-023: an unhandled error anywhere fails the gate. There is no path to `done` from here.
  on: {
    ERROR: [{ target: "failingGate" }],
  },

  states: {
    resolvingSettings: {
      on: {
        SETTINGS_RESOLVED: [
          { target: "failingGate", guard: "settingsInvalid" },
          { target: "checkingPrerequisites" },
        ],
      },
    },

    // FR-051 puts both verifications ahead of every other check, because both must complete before
    // any model tokens are spent and because a gate nothing enforces makes every later state
    // pointless.
    checkingPrerequisites: {
      on: {
        PREREQUISITES_CHECKED: [
          { target: "failingGate", guard: "permissionsMissing" },
          { target: "failingGate", guard: "gateNotRequiredByBranchProtection" },
          { target: "checkingIdentity" },
        ],
      },
    },

    checkingIdentity: {
      on: {
        IDENTITY_CHECKED: [
          { target: "escalating", guard: "selfAuthored" },
          { target: "checkingProgress" },
        ],
      },
    },

    checkingProgress: {
      on: {
        PROGRESS_CHECKED: [
          { target: "escalating", guard: "roundCapExceeded" },
          { target: "escalating", guard: "noForwardProgress" },
          { target: "checkingSize" },
        ],
      },
    },

    // Both exits here spend zero tokens. The empty-diff exit records no verdict for either role:
    // a verdict on a degenerate pull request would make it look ordinary (FR-052).
    checkingSize: {
      on: {
        SIZE_CHECKED: [
          { target: "failingGate", guard: "diffEmpty" },
          { target: "failingGate", guard: "diffExceedsReviewableSize" },
          { target: "checkingBudgets" },
        ],
      },
    },

    checkingBudgets: {
      on: {
        BUDGETS_CHECKED: [
          { target: "escalating", guard: "tokenBudgetExhausted" },
          { target: "escalating", guard: "rateLimitWaitExceeded" },
          { target: "waitingForReset", guard: "platformReserveReached" },
          { target: "reviewing" },
        ],
      },
    },

    // FR-040: pause and resume rather than failing, and re-check the budgets on the way back.
    waitingForReset: {
      on: {
        RESET_ELAPSED: [{ target: "checkingBudgets" }],
      },
    },

    // FR-017: entered on every run, on a push and equally on a re-run against an already-reviewed
    // revision. No transition anywhere reads a stored verdict.
    reviewing: {
      on: {
        REVIEW_COMPLETED: [{ target: "reconciling", actions: ["recordRoleResults"] }],
      },
    },

    reconciling: {
      on: {
        RECONCILED: [{ target: "reportingGate" }],
      },
    },

    reportingGate: {
      on: {
        GATE_REPORTED: [{ target: "done", actions: ["recordGate"] }],
      },
    },

    failingGate: {
      on: {
        GATE_REPORTED: [{ target: "escalating", actions: ["recordGate"] }],
      },
    },

    // Principle VII: escalation always notifies. `halted` is only ever reached through here, so a
    // stop is never silent.
    escalating: {
      on: {
        ESCALATED: [{ target: "halted" }],
      },
    },

    done: { type: "final", on: {} },
    halted: { type: "final", on: {} },
  },
};

/** Reads a boolean the orchestrator established. Absent means "not established", never "pass". */
const reported = (value: boolean | undefined): boolean => value === true;

export const reviewGuards: Record<GuardName, (args: { context: ReviewContext }) => boolean> = {
  settingsInvalid: ({ context }) => reported(context.findings.settingsInvalid),

  permissionsMissing: ({ context }) => (context.findings.missingPermissions ?? []).length > 0,

  // An unverified branch protection is not a pass: only an explicit `true` clears this guard.
  gateNotRequiredByBranchProtection: ({ context }) =>
    context.findings.gateRequiredByBranchProtection !== true,

  selfAuthored: ({ context }) => reported(context.findings.selfAuthored),

  // FR-046 compares by revision and reply rather than elapsed time, and an unestablished result
  // is a stop rather than a pass.
  noForwardProgress: ({ context }) => context.findings.forwardProgress === false,

  roundCapExceeded: ({ context }) => {
    const { roundNumber, maxReviewRounds } = context.findings;
    if (roundNumber === undefined || maxReviewRounds === undefined) return false;
    return roundNumber > maxReviewRounds;
  },

  diffEmpty: ({ context }) => reported(context.findings.diffIsEmpty),

  diffExceedsReviewableSize: ({ context }) => {
    const { changedLines, maxReviewableDiffSize } = context.findings;
    if (changedLines === undefined || maxReviewableDiffSize === undefined) return false;
    return changedLines > maxReviewableDiffSize;
  },

  tokenBudgetExhausted: ({ context }) => context.findings.tokenBudgetSufficient === false,

  platformReserveReached: ({ context }) => reported(context.findings.platformReserveReached),

  rateLimitWaitExceeded: ({ context }) => {
    const { rateLimitWaitSeconds, maxRateLimitWaitSeconds } = context.findings;
    if (rateLimitWaitSeconds === undefined || maxRateLimitWaitSeconds === undefined) return false;
    return rateLimitWaitSeconds > maxRateLimitWaitSeconds;
  },
};

export interface ReviewMachineInput {
  readonly runId: string;
  readonly target: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly findings?: ReviewFindings;
}

/**
 * XState addresses a transition declared on the root node relative to the root, so a root-level
 * target needs a leading dot. The declaration above stays in plain state names — they are what the
 * tests and the generated diagram read — and the dot is added here, at the one boundary that
 * needs it.
 */
const rootTransitions = Object.fromEntries(
  Object.entries(reviewMachineConfig.on).map(([event, branches]) => [
    event,
    branches.map((branch) => ({ ...branch, target: `.${branch.target}` })),
  ]),
);

export const reviewMachine = createMachine(
  {
    id: "reviewRun",
    types: {
      context: {} as ReviewContext,
      events: {} as ReviewEventObject,
      input: {} as ReviewMachineInput,
    },
    context: ({ input }) => ({
      runId: input.runId,
      target: input.target,
      pullRequest: input.pullRequest,
      headSha: input.headSha,
      findings: input.findings ?? {},
      roleResults: [],
      gate: null,
      failureReason: null,
    }),
    initial: reviewMachineConfig.initial,
    states: reviewMachineConfig.states,
    on: rootTransitions,
  },
  {
    guards: reviewGuards,
    actions: {
      recordRoleResults: assign({
        roleResults: ({ event }) => (event.type === "REVIEW_COMPLETED" ? event.roleResults : []),
      }),
      recordGate: assign({
        gate: ({ context, event }) => (event.type === "GATE_REPORTED" ? event.gate : context.gate),
        failureReason: ({ context, event }) =>
          event.type === "GATE_REPORTED" ? (event.gate.reason ?? null) : context.failureReason,
      }),
    },
  },
);
