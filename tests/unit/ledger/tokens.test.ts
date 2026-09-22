import { describe, expect, it } from "vitest";

import { InMemoryLedgerStore, createLedger, type LedgerEntry } from "../../../src/ledger/tokens.js";

const TARGET = "owner/name";

const LIMITS = { tokenBudget: 1000, reviewerTokenReserve: 300 } as const;

function ledger(entries: readonly LedgerEntry[] = []) {
  return createLedger({ target: TARGET, limits: LIMITS, store: new InMemoryLedgerStore(entries) });
}

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    runId: "run-1",
    at: "2026-08-15T00:00:00.000Z",
    actor: "review",
    resource: "tokens",
    amount: 0,
    ...overrides,
  };
}

describe("pre-spend check for review work (FR-031)", () => {
  it("allows a spend that fits inside the whole budget", () => {
    expect(ledger().check(TARGET, "review", "tokens", 1000).allowed).toBe(true);
  });

  it("denies a spend that would exceed the whole budget", () => {
    const result = ledger().check(TARGET, "review", "tokens", 1001);

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/budget/i);
  });

  it("accounts for what is already spent", () => {
    const spent = ledger([entry({ amount: 900 })]);

    expect(spent.check(TARGET, "review", "tokens", 100).allowed).toBe(true);
    expect(spent.check(TARGET, "review", "tokens", 101).allowed).toBe(false);
  });
});

describe("the reviewer reserve (FR-047)", () => {
  it("holds the reserve back from non-review work", () => {
    const result = ledger().check(TARGET, "authoring", "tokens", 701);

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/reserve/i);
  });

  it("lets non-review work spend up to the budget minus the reserve", () => {
    expect(ledger().check(TARGET, "authoring", "tokens", 700).allowed).toBe(true);
  });

  it("keeps review work fundable after other agents have exhausted their share", () => {
    const drained = ledger([entry({ actor: "authoring", amount: 700 })]);

    expect(drained.check(TARGET, "authoring", "tokens", 1).allowed).toBe(false);
    expect(drained.check(TARGET, "review", "tokens", 300).allowed).toBe(true);
  });

  it("denies review work only once the reserve itself is gone", () => {
    const drained = ledger([entry({ actor: "authoring", amount: 700 }), entry({ amount: 300 })]);

    expect(drained.check(TARGET, "review", "tokens", 1).allowed).toBe(false);
  });

  it("names `review` as the only actor permitted to draw into the reserve", () => {
    for (const actor of ["authoring", "eval", "anything-else"]) {
      expect(ledger().check(TARGET, actor, "tokens", 800).allowed).toBe(false);
    }
    expect(ledger().check(TARGET, "review", "tokens", 800).allowed).toBe(true);
  });
});

describe("the cumulative total (FR-038)", () => {
  it("starts at zero", () => {
    expect(ledger().total("tokens")).toBe(0);
  });

  it("sums every actor's spend, not only the reviewer's", () => {
    const mixed = ledger([entry({ amount: 100 }), entry({ actor: "authoring", amount: 250 })]);

    expect(mixed.total("tokens")).toBe(350);
  });

  it("counts each resource separately, because platform requests refill and tokens do not", () => {
    const mixed = ledger([
      entry({ amount: 100 }),
      entry({ resource: "platform-requests", amount: 40 }),
    ]);

    expect(mixed.total("tokens")).toBe(100);
    expect(mixed.total("platform-requests")).toBe(40);
  });

  it("reports what remains against the budget", () => {
    expect(ledger([entry({ amount: 250 })]).remaining("tokens")).toBe(750);
  });
});

describe("the addressing interface (FR-047)", () => {
  it("exposes exactly `check` and `record` as its spend operations", () => {
    const led = ledger();

    expect(typeof led.check).toBe("function");
    expect(typeof led.record).toBe("function");
  });

  it("is addressed by target repository, and refuses a mismatched target", () => {
    expect(() => ledger().check("other/repo", "review", "tokens", 1)).toThrow();
  });

  it("appends rather than rewriting, so a recorded entry is never compacted away", () => {
    const store = new InMemoryLedgerStore([entry({ runId: "run-1", amount: 10 })]);
    const led = createLedger({ target: TARGET, limits: LIMITS, store });

    led.record(entry({ runId: "run-2", amount: 20 }));
    led.record(entry({ runId: "run-2", amount: 5 }));

    expect(store.readAll()).toHaveLength(3);
    expect(led.total("tokens")).toBe(35);
  });

  it("rejects a negative amount rather than letting a spend reduce the total", () => {
    expect(() => ledger().record(entry({ amount: -1 }))).toThrow();
  });

  it("makes a recorded spend visible to the next check", () => {
    const led = ledger();

    expect(led.check(TARGET, "review", "tokens", 1000).allowed).toBe(true);
    led.record(entry({ amount: 1000 }));
    expect(led.check(TARGET, "review", "tokens", 1).allowed).toBe(false);
  });
});

/**
 * Per-account budgets (FR-081, R-024, R-029).
 *
 * The account is the thing that gets billed or throttled, so it is the thing a budget can bound.
 * Attribution stays finer: a draw is recorded against the *provider* that incurred it, because
 * that is what Principle VII weighs later and what SC-003 needs readable on its own.
 *
 * Budgeting per provider instead would let two providers on one account carry two budgets whose
 * sum exceeds what the account holds, each passing its own reserve check while the shared quota
 * was already gone — the concealment FR-081 exists to prevent, one level up.
 */
describe("per-account budgets and reserves", () => {
  const ACCOUNTS = {
    subscription: { budget: 1000, reserve: 200 },
    api: { budget: 500, reserve: 100 },
  };

  function accountLedger(entries: readonly LedgerEntry[] = []) {
    return createLedger({
      target: "o/r",
      limits: { tokenBudget: 1500, reviewerTokenReserve: 300, accounts: ACCOUNTS },
      store: new InMemoryLedgerStore(entries),
      defaultAccount: "subscription",
      defaultProvider: "claude-subscription",
    });
  }

  function spend(account: string, provider: string, amount: number): LedgerEntry {
    return {
      runId: "r1",
      at: "2026-09-20T00:00:00.000Z",
      actor: "review",
      resource: "tokens",
      amount,
      account,
      provider,
    };
  }

  it("bounds each account by its own budget, not by a shared total", () => {
    const ledger = accountLedger([spend("api", "claude-api", 450)]);

    // The api account is nearly gone; the subscription account is untouched. A single total
    // would have said 450 of 1500 and waved both through.
    expect(ledger.check("o/r", "review", "tokens", 100, "api").allowed).toBe(false);
    expect(ledger.check("o/r", "review", "tokens", 100, "subscription").allowed).toBe(true);
  });

  it("keeps the reserve per account, with `review` the only actor allowed into it", () => {
    const ledger = accountLedger([spend("subscription", "claude-subscription", 750)]);

    // 1000 budget less the 200 reserve leaves 800 for non-review work.
    expect(ledger.check("o/r", "authoring", "tokens", 100, "subscription").allowed).toBe(false);
    expect(ledger.check("o/r", "review", "tokens", 100, "subscription").allowed).toBe(true);
  });

  it("makes two providers on one account draw on one limit (R-029)", () => {
    // The whole reason budgets sit on the account: these are two providers and one quota.
    const ledger = accountLedger([
      spend("subscription", "claude-subscription", 500),
      spend("subscription", "claude-other", 400),
    ]);

    expect(ledger.total("tokens", "subscription")).toBe(900);
    expect(ledger.check("o/r", "review", "tokens", 200, "subscription").allowed).toBe(false);
  });

  it("reports what remains per account", () => {
    const ledger = accountLedger([spend("api", "claude-api", 200)]);

    expect(ledger.remaining("tokens", "api")).toBe(300);
    expect(ledger.remaining("tokens", "subscription")).toBe(1000);
  });

  it("keeps spend attributable per provider even when the limit is per account", () => {
    const ledger = accountLedger([
      spend("subscription", "claude-subscription", 100),
      spend("subscription", "claude-other", 250),
    ]);

    const byProvider = ledger.entries().filter((e) => e.provider === "claude-other");
    expect(byProvider.reduce((n, e) => n + e.amount, 0)).toBe(250);
  });

  it("attributes a pre-feature entry carrying no account to the migrated one (R-024)", () => {
    // Entries already on disk predate the field. The only reading consistent with what the
    // operator actually spent is the single account the migration synthesised.
    const legacy: LedgerEntry = {
      runId: "old",
      at: "2026-09-01T00:00:00.000Z",
      actor: "review",
      resource: "tokens",
      amount: 900,
    };
    const ledger = accountLedger([legacy]);

    expect(ledger.total("tokens", "subscription")).toBe(900);
    expect(ledger.check("o/r", "review", "tokens", 200, "subscription").allowed).toBe(false);
  });

  it("still answers the unscoped question, so a caller that has no account keeps working", () => {
    const ledger = accountLedger([spend("api", "claude-api", 200)]);

    expect(ledger.total("tokens")).toBe(200);
  });
});
