import { describe, expect, it } from "vitest";

import {
  compareWithLocal,
  reconstructTotal,
  type CheckRunSpend,
} from "../../../src/ledger/reconstruct.js";

function spend(runId: string, tokensConsumed: number): CheckRunSpend {
  return { runId, tokensConsumed };
}

describe("reconstructing the cumulative total from check-run outputs (FR-038)", () => {
  it("is zero when no round has concluded", () => {
    expect(reconstructTotal([])).toBe(0);
  });

  it("sums each round's reported spend", () => {
    expect(reconstructTotal([spend("run-1", 100), spend("run-2", 250)])).toBe(350);
  });

  it("counts a run once however many times its check run was updated", () => {
    // A check run is created and then PATCHed, so the same runId appears more than once.
    const outputs = [spend("run-1", 40), spend("run-1", 100), spend("run-2", 250)];

    expect(reconstructTotal(outputs)).toBe(350);
  });

  it("takes the largest reported figure for a run, since a later update supersedes an earlier one", () => {
    expect(reconstructTotal([spend("run-1", 100), spend("run-1", 40)])).toBe(100);
  });

  it("ignores a round that reported no spend at all", () => {
    expect(reconstructTotal([spend("run-1", 0), spend("run-2", 250)])).toBe(250);
  });

  it("rejects a negative reported spend rather than letting it reduce the total", () => {
    expect(() => reconstructTotal([spend("run-1", -5)])).toThrow();
  });
});

describe("local ledger versus reconstruction (R-010)", () => {
  it("agrees when the two sources match", () => {
    const result = compareWithLocal({ localTotal: 350, remoteTotal: 350 });

    expect(result.agrees).toBe(true);
    expect(result.escalation).toBeUndefined();
  });

  it("escalates a mismatch rather than silently correcting it", () => {
    const result = compareWithLocal({ localTotal: 100, remoteTotal: 350 });

    expect(result.agrees).toBe(false);
    expect(result.escalation?.reason).toMatch(/ledger/i);
  });

  it("states both figures so a human can tell which source is wrong", () => {
    const result = compareWithLocal({ localTotal: 100, remoteTotal: 350 });

    expect(result.escalation?.reason).toContain("100");
    expect(result.escalation?.reason).toContain("350");
  });

  it("escalates a local total that runs ahead of GitHub just as loudly as one that lags", () => {
    expect(compareWithLocal({ localTotal: 500, remoteTotal: 350 }).agrees).toBe(false);
  });

  it("treats the reconstruction as authoritative for the run that follows a mismatch", () => {
    const result = compareWithLocal({ localTotal: 100, remoteTotal: 350 });

    expect(result.authoritativeTotal).toBe(350);
  });

  it("uses the reconstruction when the local file is absent, rather than assuming zero spend", () => {
    const result = compareWithLocal({ localTotal: undefined, remoteTotal: 350 });

    expect(result.agrees).toBe(true);
    expect(result.authoritativeTotal).toBe(350);
  });
});
