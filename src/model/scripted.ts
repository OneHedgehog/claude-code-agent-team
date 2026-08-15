import { ModelError, type ModelClient, type ReviewRequest, type ReviewResponse } from "./client.js";

/**
 * The deterministic double every end-to-end test substitutes for the real model (FR-029, FR-030,
 * research.md R-015). It is the one substitution Principle II permits, so it must be the only
 * thing an e2e test replaces.
 *
 * It records the requests it received, so a test can assert that the diff and the constitution
 * were resolved through the target parameter (FR-026) and that reviewed content was passed as
 * data rather than acted on (FR-036) — without ever asserting on generated wording.
 */

/** Keyed by role, so one scenario can script the security and implementation reviewers apart. */
export type Script = Readonly<Record<string, ReviewResponse | ModelError>>;

export class ScriptedModelClient implements ModelClient {
  readonly received: ReviewRequest[] = [];

  #script: Script;

  constructor(script: Script) {
    this.#script = script;
  }

  /** Replaces the script mid-run, so a round-two response can differ from round one. */
  setScript(script: Script): void {
    this.#script = script;
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
      throw new ModelError(`no scripted response for role ${JSON.stringify(request.role)}`);
    }
    if (scripted instanceof ModelError) {
      throw scripted;
    }

    return scripted;
  }
}
