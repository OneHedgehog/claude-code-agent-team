/**
 * Structured run records (FR-033) with credential redaction at the single serialization point
 * (FR-032).
 *
 * research.md R-014 chose ~40 lines over a logging dependency, and put redaction here rather than
 * at every call site so that "credentials must not appear in records" has exactly one place to be
 * right. Every record is one JSON object on one line; bare prose never reaches stdout.
 */

/** The event vocabulary of schemas/review-record.schema.json. */
export const REVIEW_EVENTS = [
  "run.started",
  "run.concluded",
  "state.entered",
  "settings.resolved",
  "settings.invalid",
  "settings.defaults_applied",
  "prerequisites.verified",
  "prerequisites.missing",
  "identity.self_authored_refused",
  "diff.empty",
  "paths.excluded",
  "progress.no_forward_progress",
  "rounds.cap_exceeded",
  "size.exceeds_reviewable",
  "size.exceeds_pull_request_cap",
  "budget.checked",
  "budget.exhausted",
  "budget.reported",
  "platform.reserve_reached",
  "platform.wait_started",
  "platform.wait_ended",
  "queue.wait_started",
  "queue.wait_exceeded",
  "role.started",
  "role.verdict",
  "role.verdict_missing",
  "finding.posted",
  "finding.resolved",
  "location.rejected",
  "tool.refused",
  "finding.waiver_requested",
  "roles.contradiction_recorded",
  "roles.disagreement_escalated",
  "gate.reported",
  "escalation.notified",
  "error.unhandled",
] as const;

export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

export type Level = "debug" | "info" | "warn" | "error";

/** The event-specific fields the record schema permits alongside the four required ones. */
export interface RecordFields {
  readonly target?: string;
  readonly pullRequest?: number;
  readonly revision?: string;
  readonly round?: number;
  readonly state?: string;
  readonly role?: "security" | "implementation";
  readonly verdict?: "approve" | "request-changes";
  readonly prerequisites?: {
    readonly permissionsHeld: boolean;
    readonly gateRequiredByBranchProtection: boolean;
    readonly baseBranch?: string;
    readonly missing?: readonly string[];
  };
  readonly excludedPaths?: {
    readonly count: number;
    readonly paths: readonly string[];
    readonly source?: readonly ("vcs-binary" | "declared-pattern")[];
  };
  readonly effectiveOptionalSettings?: Readonly<Record<string, unknown>>;
  /**
   * A location the model produced that was refused and downgraded to pull-request level. One of
   * its causes is model output naming a path outside the checkout, which is a security boundary
   * and must leave a record (Principle VII).
   */
  readonly location?: {
    readonly path: string;
    readonly reason: string;
  };
  /**
   * A tool the harness asked to use on the `agent-sdk` transport, and was refused.
   *
   * Expected never to appear. The reviewer is constructed with no tools at all, so a record here
   * means a diff that arrived as data persuaded a tool-less reviewer to reach for a tool -- the
   * single most important thing a run could have to say (FR-036, Principle VII).
   */
  readonly tool?: {
    readonly name: string;
  };
  readonly finding?: {
    readonly id: string;
    readonly severity: "critical" | "high" | "medium" | "low";
    readonly blocking: boolean;
    readonly path?: string;
    readonly line?: number;
    readonly pullRequestLevel?: boolean;
  };
  readonly gate?: {
    readonly conclusion: "success" | "failure" | "unreported";
    readonly reason?: string;
  };
  readonly usage?: {
    readonly tokensConsumed?: number;
    readonly budgetRemaining?: number;
    readonly platformRequestsUsed?: number;
    readonly platformRequestsRemaining?: number;
  };
  readonly escalation?: {
    readonly reason: string;
    readonly channelDelivered: boolean;
    readonly statedOnPullRequest: boolean;
  };
  readonly error?: { readonly kind?: string; readonly message?: string };
}

export interface Logger {
  readonly runId: string;
  debug(event: ReviewEvent, fields?: RecordFields): void;
  info(event: ReviewEvent, fields?: RecordFields): void;
  warn(event: ReviewEvent, fields?: RecordFields): void;
  error(event: ReviewEvent, fields?: RecordFields): void;
}

export interface LoggerOptions {
  readonly runId: string;
  /** Where a serialized record goes. Defaults to stdout. */
  readonly write?: (line: string) => void;
  /** Injectable so records are deterministic under test. */
  readonly now?: () => Date;
}

const REDACTED = "[REDACTED]";

/** The four fields every record carries by construction; a caller may not displace them. */
const RESERVED_RECORD_KEYS: ReadonlySet<string> = new Set(["runId", "timestamp", "level", "event"]);

/**
 * Value shapes that are credentials wherever they appear. Ordered longest-match-first so a PEM
 * block is replaced whole rather than leaving fragments behind.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9]{24,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/**
 * Key names whose value is a credential whatever it looks like. Matched on the whole normalized
 * key rather than as a substring, so that `tokensConsumed` and `tokenBudget` — real record fields
 * carrying the ledger's own numbers — are not mistaken for secrets.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "token",
  "tokens",
  "accesstoken",
  "installationtoken",
  "apitoken",
  "apikey",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "privatekey",
  "authorization",
  "auth",
  "bearer",
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""));
}

function scrubString(value: string): string {
  return CREDENTIAL_PATTERNS.reduce((text, pattern) => text.replace(pattern, REDACTED), value);
}

/**
 * Deep-copies a value with every credential removed. Exported so the redaction regression test
 * (FR-032) can drive it directly rather than through a sink.
 */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(redact);

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = isSensitiveKey(key) ? REDACTED : redact(nested);
    }
    return result;
  }

  return value;
}

export function createLogger(options: LoggerOptions): Logger {
  const { runId } = options;
  const now = options.now ?? (() => new Date());
  const write =
    options.write ??
    ((line: string) => {
      // The one place a record reaches stdout (research.md R-014).
      console.log(line);
    });

  const emit = (level: Level, event: ReviewEvent, fields: RecordFields = {}): void => {
    const scrubbed = redact(fields) as Record<string, unknown>;

    // The four identity fields win over anything a caller passes. Spreading the caller's fields
    // last would let a stray `runId` detach a record from its run, which is the one thing FR-033
    // asks these records to guarantee. Filtering rather than reordering keeps `runId` first in the
    // serialized line, where a human scanning JSONL expects it.
    const safe = Object.fromEntries(
      Object.entries(scrubbed).filter(([key]) => !RESERVED_RECORD_KEYS.has(key)),
    );

    const record = {
      runId,
      timestamp: now().toISOString(),
      level,
      event,
      ...safe,
    };

    write(JSON.stringify(record));
  };

  return {
    runId,
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
