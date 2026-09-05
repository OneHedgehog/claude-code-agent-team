import { query } from "@anthropic-ai/claude-agent-sdk";

import {
  buildReviewPrompt,
  parseReviewResponse,
  REVIEW_MODEL,
  REVIEW_RESPONSE_SCHEMA,
} from "./anthropic.js";
import {
  ModelError,
  type ModelClient,
  type ModelUsage,
  type ReviewRequest,
  type ReviewResponse,
} from "./client.js";

/**
 * The subscription-funded transport (FR-029, FR-032).
 *
 * Identical work to `AnthropicModelClient`, reached a different way: instead of calling the
 * Messages API with a credential this process holds, it runs Claude Code as a library, which
 * authenticates itself and bills the operator's subscription. The Developer Platform meters API
 * calls against an organisation's credits; a subscription funds the Claude Code product. A
 * repository whose reviewer must keep running without a metered balance needs the second, and this
 * is the supported way to reach it -- not by borrowing a credential issued to another program.
 *
 * What it deliberately keeps from the API transport: the same prompt, the same schema, and the same
 * parser. `buildReviewPrompt` and `parseReviewResponse` are imported rather than reimplemented, so
 * the injection guard (FR-036) and the response contract cannot drift between the two paths.
 *
 * What it loses is the *guarantee*. `output_config.format` constrained the model to the schema
 * before a byte was returned; here the schema is asked for in words and enforced on arrival. That
 * is a real reduction, and it is survivable only because validation already existed: a response
 * that does not satisfy the schema raises `ModelError`, which becomes a missing verdict, which
 * fails the gate. Prose is never parsed and a malformed answer can never become an approval
 * (FR-007).
 */

/** The single turn a review takes. There is no loop here: one question, one answer, no tools. */
const MAX_TURNS = 1;

/** The shape this adapter needs from the SDK, narrowed so a test can substitute it. */
export type AgentQuery = typeof query;

export interface AgentSdkOptions {
  readonly agentQuery?: AgentQuery;
  readonly model?: string;
}

/**
 * Restates the schema as an instruction, because this transport cannot constrain the response the
 * way `output_config.format` did. Deliberately terse: the schema itself is the contract, and the
 * parser is what enforces it.
 */
function jsonOnlyInstruction(): string {
  return [
    "Reply with a single JSON object and nothing else -- no prose, no explanation, no code fence.",
    "It is validated against the JSON Schema below and anything that fails validation is discarded,",
    "recording the review as having produced no verdict. The schema is the contract, reproduced in",
    "full because this transport cannot constrain the response the way a schema-constrained API",
    "call does:",
    "",
    JSON.stringify(REVIEW_RESPONSE_SCHEMA, null, 2),
  ].join("\n");
}

function readUsage(raw: unknown): ModelUsage {
  const usage = raw as
    | {
        input_tokens?: unknown;
        output_tokens?: unknown;
        cache_creation_input_tokens?: unknown;
        cache_read_input_tokens?: unknown;
      }
    | undefined;
  const count = (value: unknown): number => (typeof value === "number" ? value : 0);

  // The harness caches its own prefix, and reports it. Folded into input rather than dropped:
  // cached tokens are still tokens the run consumed, and a ledger that ignored them would
  // under-count exactly the spend the cache is meant to make cheap (FR-031).
  return {
    inputTokens:
      count(usage?.input_tokens) +
      count(usage?.cache_creation_input_tokens) +
      count(usage?.cache_read_input_tokens),
    outputTokens: count(usage?.output_tokens),
  };
}

export class AgentSdkModelClient implements ModelClient {
  readonly #query: AgentQuery;
  readonly #model: string;

  constructor(options: AgentSdkOptions = {}) {
    this.#query = options.agentQuery ?? query;
    this.#model = options.model ?? REVIEW_MODEL;
  }

  async review(request: ReviewRequest): Promise<ReviewResponse> {
    const prompt = buildReviewPrompt(request);

    let text = "";
    let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };

    try {
      for await (const message of this.#query({
        prompt: `${prompt.userContent}\n\n${jsonOnlyInstruction()}`,
        options: {
          model: this.#model,
          systemPrompt: prompt.systemPrompt,
          maxTurns: MAX_TURNS,
          // No tools at all. The reviewer reads a diff that arrived as data and must not act on
          // it -- not read a file, not run a command, not fetch a URL. An agent harness makes that
          // an explicit choice rather than a property of the transport (Principle V, FR-036).
          allowedTools: [],
          // No settings, no project instructions, no user memory. A review must depend on the diff
          // and the target's own constitution, not on whatever the operator's machine happens to
          // carry -- otherwise the same revision reviews differently on two hosts (Principle VII).
          settingSources: [],
        },
      })) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") text += block.text;
          }
        }
        if (message.type === "result" && "usage" in message) {
          usage = readUsage(message.usage);
        }
      }
    } catch (error) {
      throw new ModelError(
        `model call failed: ${error instanceof Error ? error.message : String(error)}`,
        usage,
      );
    }

    return { ...parseReviewResponse(extractJson(text), usage), usage };
  }
}

/**
 * Takes the JSON object out of an answer that was asked for JSON only.
 *
 * A fenced block or a sentence of preamble is the likeliest way a harness-driven answer differs
 * from a schema-constrained one, and refusing those outright would turn a recoverable formatting
 * habit into a failed review. Anything that is not a JSON object still reaches the parser
 * unchanged, and is still rejected there -- this widens what is accepted, never what is trusted.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end <= start) return candidate;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return candidate;
  }
}
