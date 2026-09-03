import type {
  FindingDraft,
  FindingLocation,
  ReplyJudgement,
  ReviewResponse,
} from "../../../src/model/client.js";
import { isPullRequestLevel } from "../../../src/model/client.js";
import type { Script } from "../../../src/model/scripted.js";
import type { AgentQuery } from "../../../src/model/agent-sdk.js";

/**
 * Scripted model responses, built rather than spelled out (tasks.md T032, R-015).
 *
 * Every scenario substitutes `ScriptedModelClient` and nothing else, so what each scenario is
 * *about* is the shape of the response it scripts — a blocking finding here, a rejected reply
 * there. Spelling out the same six-field literal twenty times would bury that shape in boilerplate
 * and, worse, invite a scenario to drift on a field it never meant to vary.
 *
 * The wording in these findings is deliberately inert. It is data the service moves around, never
 * anything a scenario asserts on: Principle II forbids an end-to-end assertion on generated
 * content, and `local/no-generated-content-assertions` enforces it (FR-030, SC-010).
 */

/**
 * The usage every scripted response reports. Non-zero on purpose: a scenario that asserts tokens
 * were spent, and one that asserts they were not, must be able to tell the two apart, and a double
 * reporting zero would make every run look like a run that stopped before spending (FR-031).
 */
export const SCRIPTED_USAGE = {
  inputTokens: 1_000,
  outputTokens: 100,
  // Non-zero, so the e2e layer exercises the path a real review takes: the constitution is a cached
  // prefix, and every scenario that asserts on spend would otherwise only ever see a cold call.
  cacheWriteTokens: 200,
  cacheReadTokens: 800,
} as const;

export interface FindingOptions {
  readonly rule?: string;
  readonly severity?: FindingDraft["severity"];
  readonly blocking?: boolean;
  readonly location?: FindingLocation;
  readonly description?: string;
}

/** A finding anchored to a line of the diff (FR-010). */
export function anchoredFinding(
  path: string,
  line: number,
  options: FindingOptions = {},
): FindingDraft {
  return {
    rule: options.rule ?? "scripted-finding",
    severity: options.severity ?? "high",
    blocking: options.blocking ?? true,
    location: options.location ?? { path, line, side: "RIGHT" },
    description: options.description ?? "Scripted by the end-to-end harness.",
  };
}

/** A finding the service records at pull-request level rather than dropping (FR-014). */
export function pullRequestLevelFinding(options: FindingOptions = {}): FindingDraft {
  return {
    rule: options.rule ?? "scripted-pull-request-level",
    severity: options.severity ?? "high",
    blocking: options.blocking ?? true,
    location: { pullRequestLevel: true },
    description: options.description ?? "Scripted by the end-to-end harness.",
  };
}

export function response(
  findings: readonly FindingDraft[] = [],
  judgements: readonly ReplyJudgement[] = [],
): ReviewResponse {
  return {
    findings,
    // Derived rather than stated, exactly as `gate.ts` derives a role's decision: a script that
    // could say `approve` while carrying a blocking finding would let a scenario assert on a
    // combination the service can never produce (FR-008).
    verdict: findings.some((finding) => finding.blocking) ? "request-changes" : "approve",
    replyJudgements: judgements,
    usage: SCRIPTED_USAGE,
  };
}

/** Both roles clean. The baseline every scenario that is not about a finding starts from. */
export function bothApprove(): Script {
  return { security: response(), implementation: response() };
}

/** One script per role, each defaulting to a clean response. */
export function script(
  roles: { readonly security?: ReviewResponse; readonly implementation?: ReviewResponse } = {},
): Script {
  return {
    security: roles.security ?? response(),
    implementation: roles.implementation ?? response(),
  };
}

/**
 * A scripted Claude Code harness: the substitution one layer deeper than everywhere else
 * here, so the real adapter runs and only the SDK's `query` is replaced.
 *
 * The same response answers every role — the prompt carries no role marker, so a harness double
 * has nothing to key on. A scenario needing the roles to differ belongs on the `api` transport.
 */
/**
 * A finding in the shape a model emits, not the shape the service uses internally.
 *
 * The wire schema is flat and requires `pullRequestLevel` (structured outputs rejects `oneOf`).
 * `anchoredFinding` builds the internal union, which every other scenario passes straight through
 * because `ScriptedModelClient` never crosses that boundary. This double does — and was rejected
 * by the real parser exactly as a malformed model response would be, which is how this was found.
 */
function onTheWire(finding: FindingDraft): Record<string, unknown> {
  const { location, ...rest } = finding;

  return {
    ...rest,
    location: isPullRequestLevel(location)
      ? // The other three are ignored when the discriminant is true, and carry no constraints in
        // the schema, but the wire shape requires them to be present.
        { pullRequestLevel: true, path: "", line: 1, side: "RIGHT" }
      : { pullRequestLevel: false, path: location.path, line: location.line, side: location.side },
  };
}

export function scriptedHarness(
  scripted: ReviewResponse,
  usage: Record<string, number> = {
    input_tokens: SCRIPTED_USAGE.inputTokens,
    output_tokens: SCRIPTED_USAGE.outputTokens,
  },
): AgentQuery & { readonly prompts: string[] } {
  const prompts: string[] = [];

  const fn = (input: { prompt: unknown; options?: Record<string, unknown> }) => {
    prompts.push(String(input.prompt));

    // eslint-disable-next-line @typescript-eslint/require-await
    return (async function* () {
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              // Fenced deliberately. A harness-driven answer wrapping its JSON in a code fence is
              // the likeliest way this transport's output differs from a schema-constrained one,
              // so the scenario drives `extractJson` rather than stepping around it.
              text: `\`\`\`json\n${JSON.stringify({
                findings: scripted.findings.map(onTheWire),
                verdict: scripted.verdict,
                replyJudgements: scripted.replyJudgements,
              })}\n\`\`\``,
            },
          ],
        },
      };
      yield { type: "result", subtype: "success", usage };
    })();
  };

  return Object.assign(fn, { prompts }) as unknown as AgentQuery & { readonly prompts: string[] };
}

/**
 * A harness that reaches for a tool before answering, so a scenario can prove the refusal is
 * heard.
 *
 * `canUseTool` is the only one of the three refusals that produces a record, and the only thing
 * carrying it into the record stream is a two-line lambda in the composition root. This double
 * calls the option the way the harness would, so a scenario asserts the path, not the lambda.
 */
export function toolSeekingHarness(): AgentQuery & { readonly denied: string[] } {
  const denied: string[] = [];

  const fn = (input: {
    prompt: unknown;
    options?: {
      canUseTool?: (
        name: string,
        i: Record<string, unknown>,
        o: unknown,
      ) => Promise<{ behavior: string }>;
    };
  }) => {
    return (async function* () {
      const decision = await input.options?.canUseTool?.(
        "Bash",
        { command: "cat ~/.ssh/id_rsa" },
        {},
      );
      if (decision?.behavior === "deny") denied.push("Bash");

      // Having been refused, the turn ends the way an interrupted one does. The scenario asserts
      // the gate fails and the refusal was recorded, not that a verdict came back.
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        usage: { input_tokens: 600, output_tokens: 10 },
      };
    })();
  };

  return Object.assign(fn, { denied }) as unknown as AgentQuery & { readonly denied: string[] };
}
