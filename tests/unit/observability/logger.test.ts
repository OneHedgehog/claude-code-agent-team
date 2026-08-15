import { describe, expect, it } from "vitest";

import { createLogger, redact } from "../../../src/observability/logger.js";

/** Collects the serialized lines a logger writes, so tests assert on the wire format. */
function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

function parseOnly(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(line);
    return parsed as Record<string, unknown>;
  });
}

describe("JSON-lines logger (FR-033)", () => {
  it("writes exactly one JSON object per line", () => {
    const sink = capture();
    const log = createLogger({ runId: "run-1", write: sink.write });

    log.info("run.started", { target: "owner/name", pullRequest: 7 });
    log.info("run.concluded", { target: "owner/name", pullRequest: 7 });

    expect(sink.lines).toHaveLength(2);
    for (const line of sink.lines) {
      expect(line).not.toContain("\n");
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
  });

  it("carries the run identifier on every record", () => {
    const sink = capture();
    const log = createLogger({ runId: "run-abc", write: sink.write });

    log.debug("state.entered", { state: "resolvingSettings" });
    log.warn("platform.reserve_reached", {});
    log.error("error.unhandled", { error: { kind: "Error", message: "boom" } });

    for (const record of parseOnly(sink.lines)) {
      expect(record["runId"]).toBe("run-abc");
    }
  });

  it("carries level, event, and an ISO-8601 timestamp on every record", () => {
    const sink = capture();
    const log = createLogger({ runId: "run-1", write: sink.write });

    log.warn("budget.exhausted", {});

    const [record] = parseOnly(sink.lines);
    expect(record?.["level"]).toBe("warn");
    expect(record?.["event"]).toBe("budget.exhausted");
    expect(typeof record?.["timestamp"]).toBe("string");
    expect(new Date(record?.["timestamp"] as string).toISOString()).toBe(record?.["timestamp"]);
  });

  it("emits no bare prose — every write is parseable JSON (FR-033)", () => {
    const sink = capture();
    const log = createLogger({ runId: "run-1", write: sink.write });

    log.info("gate.reported", { gate: { conclusion: "failure", reason: "a blocking finding" } });

    for (const line of sink.lines) {
      const parsed: unknown = JSON.parse(line);
      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();
    }
  });
});

/**
 * A synthetic JWT, assembled from its three segments rather than written as one literal so that
 * secret scanners do not flag a test fixture. The payload decodes to `{"iss":"12345","exp":1999}`
 * and the signature is the text "signature-value-here" — there is nothing real here to leak.
 */
const FAKE_JWT = [
  "eyJhbGciOiJSUzI1NiJ9",
  "eyJpc3MiOiIxMjM0NSIsImV4cCI6MTk5OX0",
  "c2lnbmF0dXJlLXZhbHVlLWhlcmU",
].join(".");

describe("credential redaction (FR-032)", () => {
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ["classic GitHub token", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["GitHub server token", "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["fine-grained GitHub token", "github_pat_11ABCDEFG0abcdefghijklmnop_QRSTUVWXYZ0123456789ab"],
    ["Anthropic key", "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["JWT", FAKE_JWT],
  ];

  it.each(secrets)("redacts a %s appearing as a value", (_label, secret) => {
    const sink = capture();
    const log = createLogger({ runId: "run-1", write: sink.write });

    log.info("run.started", { error: { kind: "Auth", message: `failed with ${secret}` } });

    const line = sink.lines[0] ?? "";
    expect(line).not.toContain(secret);
    expect(line).toContain("[REDACTED]");
  });

  it("redacts a PEM private key however it is embedded", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx\n-----END RSA PRIVATE KEY-----";

    const redacted = JSON.stringify(redact({ error: { message: pem } }));

    expect(redacted).not.toContain("MIIEowIBAAKCAQEAx");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts by key name even when the value looks ordinary", () => {
    const redacted = redact({
      token: "hunter2",
      apiKey: "hunter2",
      private_key: "hunter2",
      authorization: "hunter2",
      password: "hunter2",
    }) as Record<string, unknown>;

    for (const value of Object.values(redacted)) {
      expect(value).toBe("[REDACTED]");
    }
  });

  it("reaches credentials nested in objects and arrays", () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    const redacted = JSON.stringify(
      redact({ a: [{ b: { c: secret } }], d: [secret], e: `prefix ${secret} suffix` }),
    );

    expect(redacted).not.toContain(secret);
  });

  it("leaves ordinary values untouched", () => {
    const input = { path: "src/cli.ts", line: 42, blocking: true, severity: "high" };

    expect(redact(input)).toEqual(input);
  });

  it("redacts before serialization, so no credential can reach the sink", () => {
    const sink = capture();
    const log = createLogger({ runId: "run-1", write: sink.write });
    const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    log.error("error.unhandled", { error: { kind: "ModelError", message: secret } });

    expect(sink.lines.join("\n")).not.toContain(secret);
  });
});
