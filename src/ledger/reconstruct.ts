/**
 * Rebuilding the cumulative token total from check-run outputs (FR-038, research.md R-010).
 *
 * Principle VII calls local state a cache and requires every state to be reconstructible from
 * GitHub. Each run writes its own spend into its check-run output, so the total survives the
 * runner host losing its JSONL file. A disagreement between the two sources escalates rather than
 * being silently corrected — a ledger that quietly repairs itself is a ledger nobody can audit.
 */

export interface CheckRunSpend {
  readonly runId: string;
  readonly tokensConsumed: number;
  readonly budgetRemaining?: number;
}

export interface LedgerComparison {
  readonly agrees: boolean;
  /** What the next run should treat as the total. GitHub wins, being the system of record. */
  readonly authoritativeTotal: number;
  readonly escalation?: { readonly reason: string };
}

/**
 * Sums one figure per run. A check run is created and then updated, so the same `runId` appears
 * more than once; the largest reported figure for a run is taken, because a later update
 * supersedes an earlier one and spend only ever grows within a run.
 */
export function reconstructTotal(spends: readonly CheckRunSpend[]): number {
  const perRun = new Map<string, number>();

  for (const spend of spends) {
    if (!Number.isFinite(spend.tokensConsumed) || spend.tokensConsumed < 0) {
      throw new Error(
        `check-run output for ${JSON.stringify(spend.runId)} reports a negative spend (${spend.tokensConsumed}); a spend can never reduce the total`,
      );
    }

    perRun.set(spend.runId, Math.max(perRun.get(spend.runId) ?? 0, spend.tokensConsumed));
  }

  return [...perRun.values()].reduce((sum, amount) => sum + amount, 0);
}

export function compareWithLocal(input: {
  localTotal: number | undefined;
  remoteTotal: number;
}): LedgerComparison {
  const { localTotal, remoteTotal } = input;

  // An absent local file is the ordinary case after a host is rebuilt: reconstruct and carry on,
  // rather than assuming zero spend and handing the next run the whole budget again.
  if (localTotal === undefined) {
    return { agrees: true, authoritativeTotal: remoteTotal };
  }

  if (localTotal === remoteTotal) {
    return { agrees: true, authoritativeTotal: remoteTotal };
  }

  return {
    agrees: false,
    authoritativeTotal: remoteTotal,
    escalation: {
      reason: `budget ledger disagrees with GitHub: the local ledger reports ${localTotal} tokens consumed, the check-run outputs reconstruct to ${remoteTotal}`,
    },
  };
}
