import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist"]),
  {
    // Type-aware linting only applies to source files. Build tooling
    // (vite.config.ts, vitest.config.ts) is excluded so we don't have to
    // add it to a tsconfig just for ESLint.
    files: ["src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        // Enable type-aware linting (so rules like no-floating-promises can
        // resolve the actual return types). projectService is the modern
        // typescript-eslint v8 recommendation — auto-discovers tsconfig.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Force every log site through src/utils/logger so we keep the ring
      // buffer + scoping behavior. logger.ts is allowed to call console
      // directly via the override below.
      "no-console": "error",
      // Type-aware rule: catch promises that are created but never awaited
      // or chained — the single biggest async bug class in this codebase.
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  // Build tooling files at the repo root — non-type-aware so we don't need
  // them in a tsconfig.
  {
    files: ["vite.config.ts", "vitest.config.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
    },
  },
  {
    files: ["src/utils/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  // Must be last: turns off any ESLint rules that would conflict with
  // Prettier's formatting. Prettier owns style; ESLint owns correctness.
  prettier,
]);
