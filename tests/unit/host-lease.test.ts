import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireHostLease,
  HostLeaseError,
  hostSlotsDirectory,
  readSlotRecord,
  slotFileName,
  withHostLease,
  type HostLease,
} from "../../src/host-lease.js";

/**
 * The host-wide agent lease (FR-041, Principle VIII, research.md R-019).
 *
 * R-019's whole argument is that a worker count private to one process is not a host-wide cap: a
 * `/speckit-implement` task, a local CI run, and a review can each stay within their own limit
 * while three of them thrash a machine capped at two. Every assertion here is written against
 * that argument. In particular the contention test spawns real child processes rather than
 * simulating concurrency in one, because a test that never leaves this process could pass against
 * exactly the private counter R-019 rejects.
 *
 * The lease is deliberately unlike the token ledger. The ledger is append-only and reconstructible
 * from GitHub; a lease must be exclusive, must be lost when its holder dies, and must never be
 * rebuilt after the fact — a reconstructed lease is a slot two processes both believe they hold.
 */

let directory: string;
const leases: HostLease[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-slots-"));
});

afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
  rmSync(directory, { recursive: true, force: true });
});

function acquire(
  capacity: number,
  options: { pid?: number; isAlive?: (pid: number) => boolean } = {},
) {
  const lease = acquireHostLease({ directory, capacity, ...options });
  if (lease !== null) leases.push(lease);

  return lease;
}

/** A PID no process holds. `process.kill(pid, 0)` on it raises ESRCH. */
const DEAD_PID = 2_147_483_646;

function seedSlot(slot: number, record: { pid: number; startedAt: string }): string {
  const path = join(directory, slotFileName(slot, 4));
  writeFileSync(path, JSON.stringify(record));

  return path;
}

describe("where the slots live (R-019)", () => {
  it("is under XDG_STATE_HOME when that is set", () => {
    expect(hostSlotsDirectory({ XDG_STATE_HOME: "/state" })).toBe("/state/agents/slots");
  });

  it("falls back to ~/.local/state, not to the working directory", () => {
    expect(hostSlotsDirectory({ HOME: "/home/dev" })).toBe("/home/dev/.local/state/agents/slots");
  });

  it("is shared by every agent rather than namespaced per agent", () => {
    // A per-agent path would reintroduce the private counter R-019 rejects.
    expect(hostSlotsDirectory({ XDG_STATE_HOME: "/state" })).not.toContain("review");
  });
});

describe("acquiring a slot", () => {
  it("takes the lowest free slot", () => {
    const first = acquire(4);
    const second = acquire(4);

    expect(first?.slot).toBe(1);
    expect(second?.slot).toBe(2);
  });

  it("records the holder's pid and start time in the slot file", () => {
    const lease = acquire(4);
    const record = readSlotRecord(lease?.path ?? "");

    expect(record?.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(record?.startedAt ?? ""))).toBe(false);
  });

  it("names slots slot-01 … slot-NN so the directory reads as a cap", () => {
    acquire(4);

    expect(readdirSync(directory)).toEqual(["slot-01"]);
  });

  it("creates the slots directory when it does not yet exist", () => {
    const nested = join(directory, "deeper", "slots");
    const lease = acquireHostLease({ directory: nested, capacity: 2 });
    leases.push(lease as HostLease);

    expect(lease).not.toBeNull();
  });

  it("returns no lease when every slot is held, rather than exceeding the cap", () => {
    expect(acquire(2)?.slot).toBe(1);
    expect(acquire(2)?.slot).toBe(2);
    expect(acquire(2)).toBeNull();
  });

  it("holds the cap at one when that is what is configured", () => {
    expect(acquire(1)).not.toBeNull();
    expect(acquire(1)).toBeNull();
  });

  it("refuses a cap below one rather than reporting the host as permanently saturated", () => {
    // A cap of zero is a configuration error, not load. Reporting it as saturation would send an
    // operator looking for the agents holding the slots.
    expect(() => acquireHostLease({ directory, capacity: 0 })).toThrow(HostLeaseError);
  });
});

describe("releasing a slot", () => {
  it("frees it for the next acquirer", () => {
    const first = acquire(1);
    expect(acquire(1)).toBeNull();

    first?.release();
    expect(acquire(1)?.slot).toBe(1);
  });

  it("removes the slot file", () => {
    const lease = acquire(2);
    lease?.release();

    expect(readdirSync(directory)).toEqual([]);
  });

  it("is idempotent, so a release on both the success and the failure path is safe", () => {
    const lease = acquire(2);

    expect(() => {
      lease?.release();
      lease?.release();
    }).not.toThrow();
  });

  it("never removes a slot another holder has since taken", () => {
    const lease = acquire(2);
    lease?.release();

    const next = acquire(2);
    lease?.release();

    expect(readSlotRecord(next?.path ?? "")?.pid).toBe(process.pid);
    expect(readdirSync(directory)).toEqual(["slot-01"]);
  });
});

describe("a crashed holder does not permanently shrink the host's capacity", () => {
  it("reclaims a slot whose recorded pid is no longer live", () => {
    seedSlot(1, { pid: DEAD_PID, startedAt: "2026-08-20T00:00:00.000Z" });

    expect(acquire(1)?.slot).toBe(1);
  });

  it("leaves a slot whose recorded pid is still live alone", () => {
    seedSlot(1, { pid: process.pid, startedAt: new Date().toISOString() });

    expect(acquire(1)).toBeNull();
  });

  it("reclaims a slot whose record is unreadable — an unparseable holder is not a holder", () => {
    writeFileSync(join(directory, slotFileName(1, 4)), "not json");

    expect(acquire(1)?.slot).toBe(1);
  });

  it("skips past a live holder to the next free slot rather than stopping at it", () => {
    seedSlot(1, { pid: process.pid, startedAt: new Date().toISOString() });

    expect(acquire(3)?.slot).toBe(2);
  });
});

describe("a lease is never reconstructed after the fact, unlike the ledger", () => {
  it("exposes no way to rebuild one from a record on disk", async () => {
    const module: Record<string, unknown> = await import("../../src/host-lease.js");
    const rebuilders = Object.keys(module).filter((name) =>
      /reconstruct|restore|rebuild|fromRecord|adopt/i.test(name),
    );

    expect(rebuilders).toEqual([]);
  });

  it("gives a reclaimed slot to the acquirer, never back to the dead holder", () => {
    const path = seedSlot(1, { pid: DEAD_PID, startedAt: "2020-01-01T00:00:00.000Z" });
    const before = readFileSync(path, "utf8");

    const lease = acquire(1);
    const after = readSlotRecord(lease?.path ?? "");

    expect(after?.pid).toBe(process.pid);
    expect(after?.startedAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(readFileSync(path, "utf8")).not.toBe(before);
  });
});

describe("release on both the success and the failure path", () => {
  it("releases after the work returns", async () => {
    const held = await withHostLease({ directory, capacity: 1 }, (lease) =>
      Promise.resolve(lease.slot),
    );

    expect(held).toBe(1);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("releases after the work throws, and lets the failure through", async () => {
    await expect(
      withHostLease({ directory, capacity: 1 }, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    expect(readdirSync(directory)).toEqual([]);
  });

  it("reports that no slot was free rather than running the work anyway", async () => {
    acquire(1);
    let ran = false;

    const result = await withHostLease({ directory, capacity: 1 }, () => {
      ran = true;
      return Promise.resolve("done");
    });

    expect(result).toEqual({ acquired: false });
    expect(ran).toBe(false);
  });
});

describe("contention across processes, which is the only kind that matters (R-019)", () => {
  const HOST_LEASE = fileURLToPath(new URL("../../src/host-lease.ts", import.meta.url));

  /** One child that acquires, holds while its siblings try, and prints the slot it got. */
  function raceScript(capacity: number): string {
    return [
      `import { acquireHostLease } from ${JSON.stringify(HOST_LEASE)};`,
      `const lease = acquireHostLease({ directory: process.argv[2], capacity: ${capacity} });`,
      `process.stdout.write(lease === null ? "none" : String(lease.slot));`,
      // Held until every sibling has had its turn. A child that released immediately would let a
      // later one reuse the slot, and an over-issue would hide behind the timing.
      `await new Promise((resolve) => setTimeout(resolve, 500));`,
      `lease?.release();`,
    ].join("\n");
  }

  /**
   * The children must genuinely overlap in time, so they are spawned rather than run one after
   * another — a sequential run would let each child reclaim the previous one's slot as stale and
   * would pass against an implementation with no exclusion at all.
   */
  async function runRace(capacity: number, contenders: number): Promise<string[]> {
    const scriptDirectory = mkdtempSync(join(tmpdir(), "agent-slots-race-"));
    const script = join(scriptDirectory, "contend.ts");
    writeFileSync(script, raceScript(capacity));

    try {
      return await Promise.all(
        Array.from({ length: contenders }, async () => {
          const child = spawn(process.execPath, ["--experimental-strip-types", script, directory], {
            stdio: ["ignore", "pipe", "ignore"],
          });

          let output = "";
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => (output += chunk));

          await new Promise<void>((resolve, reject) => {
            child.on("error", reject);
            child.on("close", () => resolve());
          });

          return output;
        }),
      );
    } finally {
      rmSync(scriptDirectory, { recursive: true, force: true });
    }
  }

  it("yields exactly one holder when two acquirers race for the last slot", async () => {
    // Slot 1 is taken by a live holder, leaving exactly one free slot for the two children.
    seedSlot(1, { pid: process.pid, startedAt: new Date().toISOString() });

    const outcomes = await runRace(2, 2);

    expect(outcomes.filter((outcome) => outcome !== "none")).toHaveLength(1);
  });

  it("never issues more slots than the cap, however many agents contend", async () => {
    const outcomes = await runRace(2, 5);
    const held = outcomes.filter((outcome) => outcome !== "none");

    expect(held.length).toBeLessThanOrEqual(2);
    expect(new Set(held).size).toBe(held.length);
  });
});
