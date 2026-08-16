import { describe, expect, it } from "vitest";

import { createLogger, redact } from "../../../src/observability/logger.js";
import { buildReviewPrompt } from "../../../src/model/anthropic.js";
import { renderFinding } from "../../../src/github/reviews.js";
import { createFinding } from "../../../src/review/findings.js";
import type { ReviewRequest } from "../../../src/model/client.js";

/**
 * Credential-leak regression (FR-032): no record, no comment, and no prompt carries a
 * credential-shaped value.
 *
 * Principle V puts this beyond a style preference — "secrets MUST NOT appear in the repository, in
 * logs, or in prompts". The three surfaces below are every place this service emits text that a
 * human or a model will read, so each is asserted rather than assumed.
 *
 * The fixtures are assembled from segments rather than written as literals so that secret scanners
 * do not flag this file. Nothing here is real.
 */

const FAKE = {
  classicToken: ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("_"),
  serverToken: ["ghs", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("_"),
  fineGrained: ["github", "pat", "11ABCDEFG0abcdefghijklmnop_QRSTUVWXYZ0123456789ab"].join("_"),
  anthropic: ["sk", "ant", "api03", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("-"),
  jwt: [
    "eyJhbGciOiJSUzI1NiJ9",
    "eyJpc3MiOiIxMjM0NSIsImV4cCI6MTk5OX0",
    "c2lnbmF0dXJlLXZhbHVlLWhlcmU",
  ].join("."),
  privateKey: `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAmockmockmock\n-----END RSA PRIVATE KEY-----`,
  bearer: "Bearer abcdefghijklmnopqrstuvwxyz012345",
};

const ALL = Object.values(FAKE);

function containsAnyCredential(text: string): boolean {
  return ALL.some((credential) => text.includes(credential));
}

describe("records carry no credential (FR-032)", () => {
  it("redacts every credential shape appearing in a field value", () => {
    for (const credential of ALL) {
      const lines: string[] = [];
      const logger = createLogger({ runId: "run-1", write: (line) => lines.push(line) });

      logger.error("error.unhandled", { error: { message: `failed with ${credential}` } });

      expect(containsAnyCredential(lines[0] ?? "")).toBe(false);
      expect(lines[0]).toContain("[REDACTED]");
    }
  });

  it("redacts a credential nested deep inside a record", () => {
    const lines: string[] = [];
    const logger = createLogger({ runId: "run-1", write: (line) => lines.push(line) });

    logger.info("prerequisites.missing", {
      prerequisites: {
        permissionsHeld: false,
        gateRequiredByBranchProtection: false,
        missing: [`token ${FAKE.classicToken} was rejected`],
      },
    });

    expect(containsAnyCredential(lines[0] ?? "")).toBe(false);
  });

  it("redacts a value under a sensitive key whatever its shape", () => {
    const scrubbed = JSON.stringify(redact({ authorization: "not-obviously-a-secret" }));

    expect(scrubbed).not.toContain("not-obviously-a-secret");
  });

  it("does not redact the ledger's own numbers", () => {
    const lines: string[] = [];
    const logger = createLogger({ runId: "run-1", write: (line) => lines.push(line) });

    logger.info("budget.reported", { usage: { tokensConsumed: 1200, budgetRemaining: 8800 } });

    // `tokensConsumed` and `budgetRemaining` are real record fields. A substring match on "token"
    // would redact the budget accounting FR-031 exists to make visible.
    expect(lines[0]).toContain("1200");
    expect(lines[0]).toContain("8800");
    expect(lines[0]).not.toContain("[REDACTED]");
  });
});

describe("prompts carry no credential (FR-032)", () => {
  function request(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
    return {
      runId: "run-1",
      role: "security",
      effort: "high",
      diff: "diff --git a/a.ts b/a.ts\n+const x = 1;\n",
      constitution: "# Constitution",
      pullRequestContext: { title: "t", body: "b", specPaths: [] },
      priorFindings: [],
      maxTokens: 1000,
      ...overrides,
    };
  }

  it("never carries the service's own credentials into a prompt", () => {
    const prompt = buildReviewPrompt(request());
    const whole = `${prompt.systemPrompt}\n${prompt.userContent}`;

    expect(containsAnyCredential(whole)).toBe(false);
  });

  it("passes a credential found in the diff through as reviewable content", () => {
    // Deliberate and correct: a hardcoded credential in a diff is exactly what the security
    // reviewer exists to find, so it must reach the model. FR-032 is about the *service's own*
    // credentials, not about blinding the reviewer to the defect it is looking for.
    const prompt = buildReviewPrompt(request({ diff: `+const key = "${FAKE.anthropic}";` }));

    expect(prompt.userContent).toContain(FAKE.anthropic);
  });
});

describe("comments carry no credential (FR-032)", () => {
  it("redacts a credential the model echoed into a finding description", () => {
    const finding = createFinding(
      {
        role: "security",
        rule: "hardcoded-credential",
        severity: "critical",
        location: { path: "src/a.ts", line: 4, side: "RIGHT" },
        description: `The literal ${FAKE.anthropic} is committed here.`,
      },
      "high",
    );

    const body = renderFinding(finding);

    // The finding must say what is wrong without republishing the secret to a pull request that
    // may be public.
    expect(containsAnyCredential(body)).toBe(false);
    expect(body).toContain("[REDACTED]");
  });

  it("still states the rule and severity after redaction", () => {
    const finding = createFinding(
      {
        role: "security",
        rule: "hardcoded-credential",
        severity: "critical",
        location: { path: "src/a.ts", line: 4, side: "RIGHT" },
        description: `The literal ${FAKE.classicToken} is committed here.`,
      },
      "high",
    );

    const body = renderFinding(finding);

    expect(body).toContain("hardcoded-credential");
    expect(body).toContain("critical");
  });
});
