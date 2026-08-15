/**
 * Principle III: "TypeScript runs in strict mode and `any` requires an inline justification."
 *
 * `@typescript-eslint/no-explicit-any` bans `any` outright; this rule permits it only when the
 * author states why, in a comment on the same line or the line immediately above, of the form:
 *
 *   // any: the Octokit response type is generated and widens this field to unknown
 *
 * Written as a local rule rather than pulled in as a plugin because it is thirty lines, and the
 * plan's dependency posture (research.md R-014) is to prefer thirty lines over a dependency.
 */

/** @type {import("eslint").Rule.RuleModule} */
export const justifiedAny = {
  meta: {
    type: "problem",
    docs: {
      description: "Require an inline `any:` justification comment on every explicit `any`.",
    },
    schema: [],
    messages: {
      unjustified:
        "Explicit `any` requires an inline justification: add a comment reading `any: <why>` on " +
        "this line or the line above (Principle III).",
    },
  },

  create(context) {
    const source = context.sourceCode;

    /** A justification is `any:` followed by at least one non-space character. */
    const isJustification = (comment) => /^\s*any:\s*\S/.test(comment.value);

    return {
      TSAnyKeyword(node) {
        const line = node.loc.start.line;

        const justified = source.getAllComments().some((comment) => {
          if (!isJustification(comment)) return false;
          // Same line (trailing) or the line immediately above (leading).
          return comment.loc.end.line === line || comment.loc.end.line === line - 1;
        });

        if (!justified) {
          context.report({ node, messageId: "unjustified" });
        }
      },
    };
  },
};
