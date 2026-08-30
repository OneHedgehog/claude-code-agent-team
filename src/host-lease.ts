import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The host-wide agent lease (FR-041, Principle VIII, research.md R-019).
 *
 * Principle VIII's concurrency cap "is global across every in-flight feature and task combined,
 * never per feature, and it counts any CI or reviewer job executing on the same host". No number
 * held in one process's memory can satisfy that: a `/speckit-implement` task, a local CI run, and a
 * review would each stay inside their own limit while three of them ran against a cap of two. The
 * cap therefore lives on the filesystem, where every process on the machine can see it.
 *
 * The mechanism is deliberately the smallest thing that works. `open(O_CREAT | O_EXCL)` against
 * `slot-01 … slot-NN` is atomic in the kernel, so acquisition has no critical section to get wrong —
 * unlike a count inside a single locked file, which needs a read-modify-write under the lock to
 * achieve the same thing.
 *
 * A lease is not a ledger entry and the difference is load-bearing. The token ledger is append-only
 * and treated as a cache reconstructible from GitHub. A lease must be exclusive, must be lost when
 * its holder dies, and must never be rebuilt after the fact — a reconstructed lease is one slot two
 * processes both believe they hold. Nothing in this module reconstructs one.
 *
 * This feature owns the mechanism and is, today, its only holder. That is the same arrangement
 * FR-047 establishes for the token ledger: the feature that first needs a shared resource defines
 * it, and later agents record against it rather than keeping their own. A cap that only becomes
 * real once a second agent exists is a cap nobody will retrofit.
 */

export class HostLeaseError extends Error {
  override readonly name = "HostLeaseError";
}

/** What a slot file holds: who is in it, and since when. */
export interface SlotRecord {
  readonly pid: number;
  readonly startedAt: string;
}

export interface HostLease {
  /** 1-based, matching the slot file's name. */
  readonly slot: number;
  readonly path: string;
  readonly pid: number;
  readonly startedAt: string;
  /** Idempotent, and safe to call on both the success and the failure path. */
  release(): void;
}

/**
 * Where the slots live. The path belongs to no single agent — it is `agents/slots`, not
 * `review-service/slots` — because a cap each agent kept under its own name would be the private
 * counter R-019 rejects, spelled differently.
 */
export function hostSlotsDirectory(env: Record<string, string | undefined>): string {
  const configured = env["XDG_STATE_HOME"];
  const base =
    typeof configured === "string" && configured !== ""
      ? configured
      : join(env["HOME"] ?? homedir(), ".local", "state");

  return join(base, "agents", "slots");
}

/** `slot-01 … slot-NN`, padded so the directory listing sorts and reads as a cap. */
export function slotFileName(slot: number, capacity: number): string {
  const width = Math.max(2, String(capacity).length);

  return `slot-${String(slot).padStart(width, "0")}`;
}

/** Reads a slot's record. An unreadable or unparseable file is not a holder. */
export function readSlotRecord(path: string): SlotRecord | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A half-written or corrupted slot file records nobody. Treating it as occupied would shrink
    // the host's capacity permanently for the sake of a file no process is watching.
    return null;
  }

  if (parsed === null || typeof parsed !== "object") return null;

  const { pid, startedAt } = parsed as { pid?: unknown; startedAt?: unknown };
  if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
  if (typeof startedAt !== "string") return null;

  return { pid, startedAt };
}

/**
 * Whether a recorded holder is still running. `EPERM` counts as live: the process exists, it is
 * simply owned by another user, and treating it as dead would hand its slot to a second holder.
 *
 * PID reuse is a real if remote hazard — a recycled PID makes a dead holder look live, which costs
 * capacity rather than exclusivity. Erring that way is the correct direction: a slot briefly
 * believed occupied delays an agent, whereas a slot wrongly believed free runs two.
 */
function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface AcquireOptions {
  readonly directory: string;
  /** `host.maxConcurrentAgents`. */
  readonly capacity: number;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly isAlive?: (pid: number) => boolean;
}

function makeLease(path: string, slot: number, record: SlotRecord): HostLease {
  let released = false;

  return {
    slot,
    path,
    pid: record.pid,
    startedAt: record.startedAt,
    release(): void {
      // The flag, not the file, is what makes a second release safe. Within one process the PID
      // check below cannot tell this holder from the next one, so releasing twice would otherwise
      // delete a slot somebody else has since taken.
      if (released) return;
      released = true;

      const current = readSlotRecord(path);
      if (current === null || current.pid !== record.pid) return;

      try {
        unlinkSync(path);
      } catch {
        // Already gone — reclaimed as stale, or removed by hand. Either way the slot is free,
        // which is all release promises.
      }
    },
  };
}

/**
 * Creates the slot file exclusively **with its record already in it**, or reports that the slot is
 * taken.
 *
 * The two steps have to be one. `open(O_CREAT | O_EXCL)` followed by a write leaves a window in
 * which the file exists and is empty, and an empty file records no holder — so a sibling arriving
 * inside that window reads "nobody" and reclaims a slot that was just taken. That is not
 * theoretical: it issued the same slot to two racing processes before this was changed.
 *
 * `link()` closes it. The record is written to a temporary file first, and the link that publishes
 * it under the slot's name is atomic and fails with `EEXIST` if the slot is taken — so the slot
 * file never exists in a state that does not name its holder.
 */
function claim(directory: string, path: string, record: SlotRecord): boolean {
  const temporary = join(directory, `.slot-staging-${process.pid}-${randomUUID()}`);
  writeFileSync(temporary, `${JSON.stringify(record)}\n`);

  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The staging file has served its purpose either way; a leftover would be inert.
    }
  }
}

/**
 * Takes the lowest free slot, or returns `null` when every slot is held. Returning `null` rather
 * than waiting or exceeding the cap is what makes the caller's wait visible: FR-041 measures that
 * wait and escalates past a configured maximum.
 */
export function acquireHostLease(options: AcquireOptions): HostLease | null {
  const { directory, capacity } = options;

  if (!Number.isInteger(capacity) || capacity < 1) {
    // A cap below one is not a saturated host, it is a configuration error under which no agent
    // could ever run. Reporting it as saturation would make it look like transient load.
    throw new HostLeaseError(
      `host concurrency cap must be a positive integer, received ${JSON.stringify(capacity)}`,
    );
  }

  mkdirSync(directory, { recursive: true });

  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? pidIsLive;
  const now = options.now ?? ((): Date => new Date());

  for (let slot = 1; slot <= capacity; slot += 1) {
    const path = join(directory, slotFileName(slot, capacity));
    const record: SlotRecord = { pid, startedAt: now().toISOString() };

    if (claim(directory, path, record)) return makeLease(path, slot, record);

    const held = readSlotRecord(path);
    if (held !== null && isAlive(held.pid)) continue;

    // Stale: the holder crashed, or the file records nobody. Reclaiming it is what keeps a crashed
    // agent from permanently shrinking the host's capacity.
    //
    // A bounded window is accepted here and stated rather than left to be discovered: two agents
    // that judge the *same* dead slot stale in the same instant can both unlink and one can remove
    // the other's fresh record, leaving two holders. It requires two agents starting simultaneously
    // immediately after a crash, and it costs one extra agent transiently rather than a lost lease.
    // Closing it needs a second lock with its own staleness problem, which is a worse trade for a
    // cap whose purpose is to keep one laptop from thrashing.
    try {
      unlinkSync(path);
    } catch {
      // Another acquirer reclaimed it first. Fall through to the retry, which will simply fail.
    }

    if (claim(directory, path, record)) return makeLease(path, slot, record);
  }

  return null;
}

/** Reported when no slot was free, so a caller cannot mistake it for work that returned nothing. */
export const NO_SLOT = { acquired: false } as const;

export type NoSlot = typeof NO_SLOT;

export function noSlot(result: unknown): result is NoSlot {
  return result === NO_SLOT;
}

/**
 * Runs work under a lease and releases it on both the success and the failure path. The failure is
 * re-thrown rather than swallowed: the lease is released because the work stopped, not because the
 * work succeeded.
 */
export async function withHostLease<T>(
  options: AcquireOptions,
  work: (lease: HostLease) => Promise<T>,
): Promise<T | NoSlot> {
  const lease = acquireHostLease(options);
  if (lease === null) return NO_SLOT;

  try {
    return await work(lease);
  } finally {
    lease.release();
  }
}
