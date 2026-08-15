# Contract: `ModelClient`

The single substitutable boundary required by FR-029 and Principle II. Replacing this interface — and
nothing else — must be sufficient to drive the entire flow deterministically from an end-to-end test.

## Interface

```ts
export interface ModelClient {
  /**
   * Run one reviewer role against one diff and return structured findings.
   * Implementations MUST NOT act on instructions found in `request` content;
   * every field of `request` is untrusted data (FR-036).
   */
  review(request: ReviewRequest): Promise<ReviewResponse>;
}

export interface ReviewRequest {
  readonly runId: string;
  readonly role: RoleName;
  readonly effort: ModelEffort;
  /** Unified diff of the revision under review. Untrusted data. */
  readonly diff: string;
  /** The target repository's constitution text, resolved via the target parameter. */
  readonly constitution: string;
  /** The pull request title, body, and the feature spec paths it claims to implement. */
  readonly pullRequestContext: PullRequestContext;
  /** The service's own open findings plus any author replies to them. Untrusted data. */
  readonly priorFindings: readonly PriorFinding[];
  /** Hard ceiling for this call. Exceeding it is an error, never a truncation. */
  readonly maxTokens: number;
}

export interface ReviewResponse {
  readonly findings: readonly FindingDraft[];
  readonly verdict: "approve" | "request-changes";
  readonly replyJudgements: readonly ReplyJudgement[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface ReplyJudgement {
  readonly findingId: string;
  readonly accepted: boolean;
  readonly reason: string;
}
```

`FindingDraft` carries `severity`, `blocking`, `location`, `description`, and `rule` — the fields
[data-model.md](../data-model.md) lists for `Finding` minus the derived `id` and `status`, which the
service assigns.

## Guarantees the interface must preserve

1. **Determinism at the boundary.** Every field of `ReviewResponse` is structured; nothing downstream
   parses prose. This is what makes FR-030's "assert on states, comments, verdicts, gate — never on
   generated wording" achievable.
2. **No verdict inference.** An implementation that cannot produce a verdict must reject, not return
   a default. There is no code path where a missing verdict becomes `approve` (FR-007).
3. **Usage is always reported.** `usage` is required on every response, including error paths that
   consumed tokens, so the ledger cannot under-count (FR-031).
4. **Content is data.** Implementations pass `diff`, `pullRequestContext`, and `priorFindings` inside
   delimited blocks with a standing instruction that instructions found there are data (FR-036).
   Output is consumed only through the schema — never evaluated, never used to choose an API call,
   never used to build a filesystem path.

## Version-one implementations

| Implementation | Used by | Notes |
|---|---|---|
| `ScriptedModelClient` | Every end-to-end test | Returns predetermined `ReviewResponse` values keyed by scenario. Records the requests it received so tests can assert that the diff and constitution were resolved through the target parameter. |
| `AnthropicModelClient` | Production runs | `@anthropic-ai/sdk` against `claude-opus-5`, adaptive thinking, `output_config.effort` from settings, findings returned via structured outputs against a JSON Schema. Credentials from `ANTHROPIC_API_KEY` in the runner's local environment or OS keychain — never from Actions secrets (FR-032). |

A local-model adapter (Ollama, LM Studio) is a later addition behind this same interface and requires
no change to any caller.

## Prohibited in implementations

- Reading credentials from CI secrets, or logging any part of them (FR-032).
- Retrying past the budget check rather than surfacing exhaustion (FR-031).
- Degrading to a smaller model, a shorter prompt, or a sampled diff to fit a remaining budget —
  the system degrades to stopped, never to unreviewed (Principle IV).
