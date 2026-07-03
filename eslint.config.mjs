// ESLint flat config — correctness rules only (no stylistic/formatting rules;
// the refactor mandate is behavior-preserving and the codebase is already
// consistently formatted).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["out/**", "media/three/**", "node_modules/**", "**/*.vsix"]
  },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node
    },
    rules: {
      // empty catch = intentional "best effort" cleanup on sockets/config
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ]
    }
  },
  {
    files: ["media/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: "module",
      globals: {
        ...globals.browser,
        acquireVsCodeApi: "readonly"
      }
    }
  },
  {
    files: ["scripts/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node
    }
  },
  {
    files: ["test/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: "module",
      globals: globals.node
    }
  }
);
