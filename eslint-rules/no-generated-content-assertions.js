/**
 * Fails an assertion on model-produced strings under `tests/e2e/` (FR-030, SC-010).
 *
 * Principle II: "An e2e test MUST NOT assert on generated content." The rule exists because the
 * violation is so easy and so quiet — `expect(finding.description).toContain("hardcoded")` looks
 * like a real assertion and passes for months, until the model rewords one sentence and a green
 * suite goes red for no behavioral reason. The layer stops being a brake and gets deleted.
 *
 * What is allowed is the deterministic surface: states entered, comments posted, verdicts recorded,
 * gate conclusion, escalations. What is banned is reaching into a field the model wrote and
 * asserting on its text.
 */

/** Fields whose value is model-authored prose. */
const GENERATED_FIELDS = new Set(["description", "summary", "reason", "acceptanceReason", "body"]);

/** Matchers that compare string content rather than structure. */
const CONTENT_MATCHERS = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toContain",
  "toMatch",
  "toContainEqual",
  "toHaveTextContent",
]);

function propertyName(node) {
  if (node.type !== "MemberExpression") return null;
  if (node.computed) {
    return node.property.type === "Literal" ? String(node.property.value) : null;
  }
  return node.property.type === "Identifier" ? node.property.name : null;
}

/** Whether an expression reads a model-authored field anywhere along its member chain. */
function readsGeneratedField(node) {
  let current = node;

  while (current !== null && current !== undefined) {
    if (current.type === "MemberExpression") {
      const name = propertyName(current);
      if (name !== null && GENERATED_FIELDS.has(name)) return name;
      current = current.object;
      continue;
    }

    if (current.type === "CallExpression") {
      current = current.callee;
      continue;
    }

    if (current.type === "TSNonNullExpression" || current.type === "ChainExpression") {
      current = current.expression;
      continue;
    }

    return null;
  }

  return null;
}

export const noGeneratedContentAssertions = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow asserting on model-generated content in end-to-end tests (FR-030, Principle II)",
    },
    schema: [],
    messages: {
      generated:
        "End-to-end tests must not assert on generated content (Principle II, FR-030). `{{field}}` " +
        "is model-authored, so this assertion breaks when the wording changes rather than when the " +
        "behavior does. Assert on the deterministic surface instead: states entered, comments " +
        "posted, verdicts recorded, gate conclusion, escalations.",
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        const matcher = propertyName(node.callee);
        if (matcher === null || !CONTENT_MATCHERS.has(matcher)) return;

        // The `expect(...)` whose matcher this is.
        let receiver = node.callee.object;
        while (receiver?.type === "MemberExpression") receiver = receiver.object;

        if (
          receiver?.type !== "CallExpression" ||
          receiver.callee.type !== "Identifier" ||
          receiver.callee.name !== "expect"
        ) {
          return;
        }

        const subject = receiver.arguments[0];
        if (subject === undefined) return;

        const field = readsGeneratedField(subject);
        if (field === null) return;

        context.report({ node, messageId: "generated", data: { field } });
      },
    };
  },
};
