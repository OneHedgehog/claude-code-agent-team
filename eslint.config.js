import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

import { justifiedAny } from "./eslint-rules/justified-any.js";
import { noGeneratedContentAssertions } from "./eslint-rules/no-generated-content-assertions.js";

const local = {
  rules: {
    "justified-any": justifiedAny,
    "no-generated-content-assertions": noGeneratedContentAssertions,
  },
};

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      ".claude/**",
      ".specify/**",
      "specs/**",
      "scripts/*.sh",
    ],
  },

  js.configs.recommended,

  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked, prettier],
    languageOptions: {
      parserOptions: {
        // tsconfig.test.json spans src, tests, scripts, and the root config files, so every
        // linted TypeScript file belongs to exactly one program.
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { local },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // Principle III: `any` is permitted only with a stated reason. `no-explicit-any` is off
      // because `local/justified-any` is the stricter, justification-aware form of the same
      // check — leaving both on would report every justified `any` twice.
      "@typescript-eslint/no-explicit-any": "off",
      "local/justified-any": "error",

      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "error",
      eqeqeq: ["error", "always"],
    },
  },

  // The logger is the one place a record reaches stdout (research.md R-014).
  {
    files: ["src/observability/logger.ts"],
    rules: { "no-console": "off" },
  },

  // Principle II, FR-030, SC-010: end-to-end tests assert on the deterministic surface only. An
  // assertion on generated wording breaks when the model rephrases rather than when the behavior
  // changes, and a suite that goes red for no behavioral reason gets deleted.
  {
    files: ["tests/e2e/**/*.ts"],
    rules: { "local/no-generated-content-assertions": "error" },
  },

  // The diagram generator runs against the build output, and reports through stderr/stdout because
  // it is a build tool rather than a run of the service.
  {
    files: ["scripts/*.ts"],
    rules: { "no-console": "off" },
  },

  // Plain JavaScript: the local ESLint rules and this config itself.
  {
    files: ["**/*.js"],
    extends: [prettier],
    languageOptions: {
      sourceType: "module",
      ecmaVersion: 2023,
    },
    rules: {
      eqeqeq: ["error", "always"],
    },
  },
);
