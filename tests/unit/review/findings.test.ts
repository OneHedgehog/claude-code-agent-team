import { describe, expect, it } from "vitest";

import {
  SEVERITY_ORDER,
  createFinding,
  isBlocking,
  parseMarker,
  renderMarker,
  type FindingDraftInput,
} from "../../../src/review/findings.js";

function draft(overrides: Partial<FindingDraftInput> = {}): FindingDraftInput {
  return {
    role: "security",
    rule: "hardcoded-credential",
    severity: "critical",
    location: { path: "src/cli.ts", line: 42, side: "RIGHT" },
    description: "An API key is committed in this file.",
    ...overrides,
  };
}

describe("the fixed severity scale (FR-011)", () => {
  it("orders critical above high above medium above low", () => {
    expect(SEVERITY_ORDER.critical).toBeGreaterThan(SEVERITY_ORDER.high);
    expect(SEVERITY_ORDER.high).toBeGreaterThan(SEVERITY_ORDER.medium);
    expect(SEVERITY_ORDER.medium).toBeGreaterThan(SEVERITY_ORDER.low);
  });

  it("declares exactly the four levels the design names", () => {
    expect(Object.keys(SEVERITY_ORDER).sort()).toEqual(["critical", "high", "low", "medium"]);
  });
});

describe("blocking derivation against the configured threshold (FR-012, FR-013)", () => {
  it.each([
    ["critical", "high", true],
    ["high", "high", true],
    ["medium", "high", false],
    ["low", "high", false],
    ["low", "low", true],
    ["critical", "critical", true],
    ["high", "critical", false],
  ] as const)("severity %s against threshold %s blocks: %s", (severity, threshold, expected) => {
    expect(isBlocking(severity, threshold)).toBe(expected);
  });

  it("states blocking explicitly on the finding rather than leaving it to be inferred", () => {
    const finding = createFinding(draft({ severity: "critical" }), "high");

    expect(finding.blocking).toBe(true);
  });

  it("evaluates blocking once at creation, so a later threshold change cannot reinterpret it", () => {
    const finding = createFinding(draft({ severity: "medium" }), "low");

    // The finding was created under a `low` threshold and blocks. Re-reading it under a stricter
    // threshold must not silently un-block an already-posted finding.
    expect(finding.blocking).toBe(true);
    expect(isBlocking(finding.severity, "critical")).toBe(false);
    expect(finding.blocking).toBe(true);
  });
});

describe("content fingerprints (research.md R-006)", () => {
  it("is stable for the same role, rule, path, and content", () => {
    expect(createFinding(draft(), "high").id).toBe(createFinding(draft(), "high").id);
  });

  it("survives a line number moving, so a shifted finding is recognized as the same one", () => {
    const first = createFinding(
      draft({ location: { path: "src/cli.ts", line: 42, side: "RIGHT" } }),
      "high",
    );
    const moved = createFinding(
      draft({ location: { path: "src/cli.ts", line: 99, side: "RIGHT" } }),
      "high",
    );

    expect(moved.id).toBe(first.id);
  });

  it("differs when the role differs", () => {
    expect(createFinding(draft({ role: "implementation" }), "high").id).not.toBe(
      createFinding(draft({ role: "security" }), "high").id,
    );
  });

  it("differs when the rule differs", () => {
    expect(createFinding(draft({ rule: "missing-test" }), "high").id).not.toBe(
      createFinding(draft(), "high").id,
    );
  });

  it("differs when the path differs", () => {
    expect(
      createFinding(draft({ location: { path: "src/other.ts", line: 42, side: "RIGHT" } }), "high")
        .id,
    ).not.toBe(createFinding(draft(), "high").id);
  });

  it("differs when the description differs", () => {
    expect(createFinding(draft({ description: "Something else." }), "high").id).not.toBe(
      createFinding(draft(), "high").id,
    );
  });

  it("ignores incidental whitespace in the description, so re-wording spacing is not a new finding", () => {
    const spaced = draft({ description: "  An API key is   committed in this file.\n" });

    expect(createFinding(spaced, "high").id).toBe(createFinding(draft(), "high").id);
  });

  it("fingerprints a pull-request-level finding without a path", () => {
    const finding = createFinding(draft({ location: { pullRequestLevel: true } }), "high");

    expect(finding.id).toBeTruthy();
    expect(finding.id).not.toBe(createFinding(draft(), "high").id);
  });
});

describe("the machine-readable marker (research.md R-006)", () => {
  it("round-trips through a comment body", () => {
    const finding = createFinding(draft(), "high");
    const body = `${finding.description}\n\n${renderMarker(finding)}`;

    expect(parseMarker(body)).toMatchObject({
      id: finding.id,
      role: "security",
      rule: "hardcoded-credential",
    });
  });

  it("is an HTML comment, so it does not show in the rendered comment", () => {
    expect(renderMarker(createFinding(draft(), "high"))).toMatch(/^<!--[\s\S]*-->$/);
  });

  it("returns nothing for a comment the service did not author", () => {
    expect(parseMarker("Looks good to me!")).toBeNull();
  });

  it("returns nothing for a marker that is not this service's", () => {
    expect(parseMarker("<!-- some-other-bot: {} -->")).toBeNull();
  });
});

describe("the finding lifecycle (data-model.md)", () => {
  it("starts open", () => {
    expect(createFinding(draft(), "high").status).toBe("open");
  });

  it("carries no waiver until one is requested", () => {
    expect(createFinding(draft(), "high").waiver).toBeNull();
  });
});
