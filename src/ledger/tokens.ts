import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The repository-wide budget ledger (FR-031, FR-038, FR-047, research.md R-010).
 *
 * It is deliberately not reviewer-private: later features record their spend against *this*
 * ledger rather than keeping their own, which is what makes the reviewer reserve mean anything.
 * The reserve is the whole point — other agents draining the budget must not be able to leave a
 * pull request ungated, so `review` is the only actor permitted to draw into it.
 *
 * The append-only JSONL file is a cache. Its authoritative counterpart is the per-run spend
 * written into each check-run output, from which `reconstruct.ts` rebuilds the same total.
 */

export type Resource = "tokens" | "platform-requests";

/** `review` is a reserved actor; every other string is ordinary non-review work. */
export type Actor = "review" | (string & {});

export interface LedgerEntry {
  readonly runId: string;
  readonly at: string;
  readonly actor: Actor;
  readonly resource: Resource;
  readonly amount: number;
}

export type CheckResult =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export interface Limits {
  readonly tokenBudget: number;
  readonly reviewerTokenReserve: number;
  readonly platformApiBudget?: number;
  readonly platformApiReserve?: number;
}

export interface Ledger {
  /** Pre-spend check. `review` alone may draw into the reserve (FR-047). */
  check(target: string, actor: Actor, resource: Resource, estimate: number): CheckResult;
  /** Append-only: never rewrites or compacts an existing entry. */
  record(entry: LedgerEntry): void;
  total(resource: Resource): number;
  remaining(resource: Resource): number;
  entries(): readonly LedgerEntry[];
}

export interface LedgerStore {
  readAll(): LedgerEntry[];
  append(entry: LedgerEntry): void;
}

export class InMemoryLedgerStore implements LedgerStore {
  #entries: LedgerEntry[];

  constructor(entries: readonly LedgerEntry[] = []) {
    this.#entries = [...entries];
  }

  readAll(): LedgerEntry[] {
    return [...this.#entries];
  }

  append(entry: LedgerEntry): void {
    this.#entries.push(entry);
  }
}

/** The version-one persistence: one JSON object per line under the runner host's state directory. */
export class JsonlLedgerStore implements LedgerStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  readAll(): LedgerEntry[] {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch {
      // An absent file is an empty ledger, not an error: the authority is GitHub (R-010).
      return [];
    }

    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as LedgerEntry);
  }

  append(entry: LedgerEntry): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    appendFileSync(this.#path, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

function budgetFor(limits: Limits, resource: Resource): { budget: number; reserve: number } {
  if (resource === "tokens") {
    return { budget: limits.tokenBudget, reserve: limits.reviewerTokenReserve };
  }

  const budget = limits.platformApiBudget;
  const reserve = limits.platformApiReserve;
  if (budget === undefined || reserve === undefined) {
    throw new Error("platform request limits are not configured for this ledger");
  }

  return { budget, reserve };
}

export function createLedger(options: {
  target: string;
  limits: Limits;
  store: LedgerStore;
}): Ledger {
  const { target, limits, store } = options;

  const requireTarget = (addressed: string): void => {
    if (addressed !== target) {
      throw new Error(
        `ledger is addressed to ${JSON.stringify(target)}, not ${JSON.stringify(addressed)}`,
      );
    }
  };

  const total = (resource: Resource): number =>
    store
      .readAll()
      .filter((entry) => entry.resource === resource)
      .reduce((sum, entry) => sum + entry.amount, 0);

  return {
    check(addressed, actor, resource, estimate) {
      requireTarget(addressed);

      const { budget, reserve } = budgetFor(limits, resource);
      const spent = total(resource);

      // Review work may spend the whole budget; everything else stops at the reserve.
      const ceiling = actor === "review" ? budget : budget - reserve;

      if (spent + estimate <= ceiling) {
        return { allowed: true };
      }

      const reason =
        actor === "review"
          ? `${resource} budget exhausted: ${spent} spent plus ${estimate} estimated exceeds the budget of ${budget}`
          : `${resource} reserve reached: ${spent} spent plus ${estimate} estimated exceeds ${ceiling}, the budget of ${budget} less the reviewer reserve of ${reserve}`;

      return { allowed: false, reason };
    },

    record(entry) {
      if (!Number.isInteger(entry.amount) || entry.amount < 0) {
        throw new Error(
          `ledger amounts are non-negative integers; received ${String(entry.amount)}`,
        );
      }
      store.append(entry);
    },

    total,

    remaining(resource) {
      return budgetFor(limits, resource).budget - total(resource);
    },

    entries() {
      return store.readAll();
    },
  };
}
