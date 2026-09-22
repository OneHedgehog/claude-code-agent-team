import { ModelError, type ModelClient, type ReviewRequest, type ReviewResponse } from "./client.js";

/**
 * The deterministic double every end-to-end test substitutes for the real model (FR-029, FR-030,
 * research.md R-015). It is the one substitution Principle II permits, so it must be the only
 * thing an e2e test replaces.
 *
 * It records the requests it received, so a test can assert that the diff and the constitution
 * were resolved through the target parameter (FR-026) and that reviewed content was passed as
 * data rather than acted on (FR-036) — without ever asserting on generated wording.
 *
 * **Under routing it stands in for one provider, never for the router** (FR-085, R-023).
 * Principle II permits exactly one substitution and the thing substituted must not be the thing
 * under test: a route is built from several of these, and the `RoutingModelClient` above them is
 * the real one. Otherwise failover would only be demonstrable by exhausting a real vendor's
 * quota, which is a path nobody will test.
 */

/** One scripted outcome, or a sequence consumed in order — the last entry repeats. */
export type ScriptEntry = ReviewResponse | ModelError | readonly (ReviewResponse | ModelError)[];

/** Keyed by role, so one scenario can script the security and implementation reviewers apart. */
export type Script = Readonly<Record<string, ScriptEntry>>;

export interface ScriptedOptions {
  /**
   * The provider name this double answers to, stamped onto every response it returns (FR-079).
   *
   * Named per instance because a route holds several of them, and a test asserting which
   * provider produced the verdict is asserting the thing failover is most likely to get wrong.
   */
  readonly providerName?: string;
}

export class ScriptedModelClient implements ModelClient {
  readonly received: ReviewRequest[] = [];
  readonly providerName: string;

  #script: Script;
  /** Per-role call counter, so a scripted sequence advances independently for each role. */
  readonly #calls = new Map<string, number>();

  constructor(script: Script, options: ScriptedOptions = {}) {
    this.#script = script;
    this.providerName = options.providerName ?? "scripted";
  }

  /** Replaces the script mid-run, so a round-two response can differ from round one. */
  setScript(script: Script): void {
    this.#script = script;
    this.#calls.clear();
  }

  requestsFor(role: string): ReviewRequest[] {
    return this.received.filter((request) => request.role === role);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async review(request: ReviewRequest): Promise<ReviewResponse> {
    this.received.push(request);

    const scripted = this.#script[request.role];

    if (scripted === undefined) {
      // Rejecting is the correct behavior: a double that invented a verdict for an unscripted
      // role would let a test pass on a path nobody wrote down (FR-007).
      throw new ModelError(
        `no scripted response for role ${JSON.stringify(request.role)}`,
        undefined,
        { provider: this.providerName },
      );
    }

    const outcome = this.#next(request.role, scripted);

    if (outcome instanceof ModelError) {
      // Re-thrown with this double's own provider name when the script did not set one, so a
      // route built from several doubles attributes each failure to the right leaf without every
      // test having to say so twice.
      throw outcome.provider === "unknown"
        ? new ModelError(outcome.message, outcome.usage, {
            failureClass: outcome.failureClass,
            provider: this.providerName,
            cause: outcome,
          })
        : outcome;
    }

    return { ...outcome, provider: outcome.provider || this.providerName };
  }

  /** Advances a scripted sequence; a single entry is returned on every call. */
  #next(role: string, entry: ScriptEntry): ReviewResponse | ModelError {
    if (!Array.isArray(entry)) return entry as ReviewResponse | ModelError;

    const sequence = entry as readonly (ReviewResponse | ModelError)[];
    if (sequence.length === 0) {
      throw new ModelError(`empty scripted sequence for role ${JSON.stringify(role)}`, undefined, {
        provider: this.providerName,
      });
    }

    const seen = this.#calls.get(role) ?? 0;
    this.#calls.set(role, seen + 1);

    // The last entry repeats rather than the sequence wrapping: a test that scripts two outcomes
    // and gets asked three times is asserting about the first two, and wrapping would quietly
    // answer the third with the first.
    return sequence[Math.min(seen, sequence.length - 1)] as ReviewResponse | ModelError;
  }
}

/** A capacity failure for one provider — the shape a failover scenario scripts (FR-078). */
export function scriptedCapacityFailure(provider: string, message = "session limit"): ModelError {
  return new ModelError(message, undefined, { failureClass: "capacity", provider });
}

/** A contract failure — scripted where a test asserts the route does NOT advance (FR-078). */
export function scriptedContractFailure(
  provider: string,
  message = "model response did not satisfy the review schema",
): ModelError {
  return new ModelError(message, undefined, { failureClass: "contract", provider });
}
