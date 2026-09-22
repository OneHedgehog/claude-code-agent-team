import { ATTEMPT_BOUND_MS, type RoleName } from "../config/settings.js";
import {
  CHARS_PER_TOKEN,
  ModelError,
  RouteExhaustedError,
  ZERO_USAGE,
  type ModelClient,
  type ModelUsage,
  type ReviewRequest,
  type ReviewResponse,
  type RouteAttempt,
} from "./client.js";

/**
 * The routing composite (FR-076, FR-078, FR-079, FR-080, FR-086; contracts/model-client.md).
 *
 * It is itself a `ModelClient`, which is the entire point: nothing above the model boundary
 * changes. The roles, the gate, the daemon and the queue keep calling `review()` and never learn
 * that several providers might be asked.
 *
 * **It sits above the substituted leaves, never in place of them** (R-023). Principle II permits
 * one substitution at the model boundary, and the thing substituted must not be the thing under
 * test — so a test builds a route out of scripted clients and exercises this class for real.
 *
 * The rule it exists to enforce is one sentence long and easy to get backwards: advance on
 * `capacity`, never on `contract`. A capacity failure says nothing about the reviewed revision,
 * so asking someone else is reasonable. A contract failure is a statement about *this* run or
 * *this* content, and asking someone else until one of them approves is not a gate.
 */

export type Routes = Readonly<Partial<Record<RoleName, readonly ModelClient[]>>>;

export interface RoutingOptions {
  /**
   * Names for the leaves, positionally, where a leaf cannot name itself.
   *
   * A real provider client stamps its own name onto every response and every `ModelError`, so
   * this is normally unnecessary. It exists for the one case that would otherwise record
   * `unknown`: a bare `ModelClient` used as a leaf in a test or an adapter written before this
   * feature. Attribution is required on every verdict (FR-079), so there has to be a fallback
   * that is not a guess.
   */
  readonly providerNames?: readonly string[];
  /** The per-attempt bound. Defaults to FR-086's 5 minutes; overridden only by tests. */
  readonly attemptBoundMs?: number;
}

/** What a settled attempt produced: a verdict, or a classified failure. */
type Settled =
  | { readonly kind: "verdict"; readonly response: ReviewResponse }
  | { readonly kind: "failed"; readonly error: ModelError };

export class RoutingModelClient implements ModelClient {
  readonly #routes: Routes;
  readonly #names: readonly string[];
  readonly #boundMs: number;

  constructor(routes: Routes, options: RoutingOptions = {}) {
    this.#routes = routes;
    this.#names = options.providerNames ?? [];
    this.#boundMs = options.attemptBoundMs ?? ATTEMPT_BOUND_MS;
  }

  /**
   * The leaves a role is routed to, in order.
   *
   * Exposed because "which adapter is actually behind this role" is a question worth being able
   * to answer from outside — a composition test asserting that `agent-sdk` built an
   * `AgentSdkModelClient` is asserting something real, and wrapping the client in a router should
   * not turn that into an assertion about the wrapper.
   */
  providersFor(role: RoleName): readonly ModelClient[] {
    return this.#routes[role] ?? [];
  }

  async review(request: ReviewRequest): Promise<ReviewResponse> {
    const route = this.#routes[request.role];

    if (route === undefined || route.length === 0) {
      // Unreachable in a configured service: preflight refuses a required role with no route
      // (FR-076, FR-084). Stated anyway, because the alternative to a loud failure here is a
      // silent fall-through to some default provider, which is the thing the edge case forbids.
      throw new ModelError(
        `no route is configured for role ${JSON.stringify(request.role)}; preflight should have ` +
          `refused this configuration, and there is no implicit fallback to a default provider`,
        ZERO_USAGE,
        { failureClass: "contract" },
      );
    }

    const attempts: RouteAttempt[] = [];

    for (const [index, client] of route.entries()) {
      const settled = await this.#attempt(client, request, index);

      if (settled.kind === "verdict") {
        // Exactly one verdict per role per revision, from exactly one provider (FR-079).
        // Returning here is what makes that true: no later provider is asked once one answered.
        return settled.response;
      }

      const { error } = settled;
      attempts.push({
        provider: error.provider,
        index,
        failureClass: error.failureClass,
        usage: error.usage,
      });

      if (error.failureClass === "contract") {
        // The route stops dead. The failure is rethrown as itself rather than wrapped in a
        // route-exhausted error, because the stated reason an author reads must be the schema
        // violation or the refused tool — not "every provider failed", which would be false and
        // would point at the wrong thing to fix.
        throw this.#withAccumulated(error, attempts);
      }
    }

    // Every provider returned a capacity failure. Fail closed, naming each one and its class
    // (FR-080). Principle IV applies unchanged: no limit is raised, no required role is dropped,
    // and no provider absent from the route is invented. The system degrades to stopped.
    throw new RouteExhaustedError(request.role, attempts);
  }

  /**
   * One provider's turn, bounded and classified.
   *
   * The bound is per attempt rather than per role (FR-086). That is only safe because of the
   * arithmetic — at five minutes, a six-provider route still fits inside the thirty
   * `maxQueueWaitSeconds` promises whatever is queued behind it — and preflight checks that
   * arithmetic rather than trusting this comment.
   */
  async #attempt(client: ModelClient, request: ReviewRequest, index: number): Promise<Settled> {
    const fallbackName = this.#names[index] ?? `provider-${String(index)}`;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const bounded = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ModelError(
              `provider did not answer within ${String(Math.round(this.#boundMs / 1000))}s`,
              // FR-067: the prompt was sent, so the attempt is charged at no less than that.
              // A real client reports its own floor; this is the bound's own charge for an
              // attempt that never reported anything at all.
              promptFloor(request),
              { failureClass: "capacity", provider: fallbackName },
            ),
          );
        }, this.#boundMs);
      });

      const response = await Promise.race([client.review(request), bounded]);

      return {
        kind: "verdict",
        // A leaf that named itself keeps its name; one that did not gets the positional
        // fallback, because FR-079 admits no unattributed verdict.
        response: { ...response, provider: response.provider || fallbackName },
      };
    } catch (error) {
      if (error instanceof ModelError) {
        return {
          kind: "failed",
          error:
            error.provider === "unknown"
              ? new ModelError(error.message, error.usage, {
                  failureClass: error.failureClass,
                  provider: fallbackName,
                  cause: error,
                })
              : error,
        };
      }

      // Not a `ModelError` at all — a leaf threw something unexpected. Classified `contract`
      // because that is the direction that fails closed: treating an unknown failure as capacity
      // would silently ask the next provider, which is the verdict-shopping FR-078 forbids.
      return {
        kind: "failed",
        error: new ModelError(
          `provider failed: ${error instanceof Error ? error.message : String(error)}`,
          ZERO_USAGE,
          { failureClass: "contract", provider: fallbackName, cause: error },
        ),
      };
    } finally {
      // Cancelled rather than abandoned. An orphaned timer would hold the event loop open past
      // the run, and the racing promise is already settled either way.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Carries the spend of earlier attempts onto a failure that ends the route.
   *
   * Without this, a contract failure on the second provider would report only its own usage and
   * the first attempt's tokens would vanish from the ledger — under-counting, which FR-031 exists
   * to prevent.
   */
  #withAccumulated(error: ModelError, attempts: readonly RouteAttempt[]): ModelError {
    if (attempts.length <= 1) return error;

    const total = attempts.reduce<ModelUsage>(
      (sum, attempt) => ({
        inputTokens: sum.inputTokens + attempt.usage.inputTokens,
        outputTokens: sum.outputTokens + attempt.usage.outputTokens,
        cacheWriteTokens: sum.cacheWriteTokens + attempt.usage.cacheWriteTokens,
        cacheReadTokens: sum.cacheReadTokens + attempt.usage.cacheReadTokens,
      }),
      ZERO_USAGE,
    );

    return new ModelError(error.message, total, {
      failureClass: error.failureClass,
      provider: error.provider,
      cause: error,
    });
  }
}

/**
 * The floor charged for an attempt that was cut off before reporting anything (FR-067).
 *
 * The prompt was sent and its tokens were spent, so recording zero would make the most expensive
 * failure this router produces look free. Estimated from the request at the same characters-per-
 * token constant the budget forecast uses, so the two agree.
 */
function promptFloor(request: ReviewRequest): ModelUsage {
  const characters =
    request.diff.length +
    request.constitution.length +
    request.pullRequestContext.title.length +
    request.pullRequestContext.body.length;

  // `CHARS_PER_TOKEN` is imported rather than restated, so this floor and the budget forecast
  // that authorised the review cannot drift apart into two different estimates of one thing.
  return { ...ZERO_USAGE, inputTokens: Math.ceil(characters / CHARS_PER_TOKEN) };
}
