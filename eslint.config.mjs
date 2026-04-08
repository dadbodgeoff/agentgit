import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/coverage/**",
      ".turbo/**",
      ".release-artifacts/**",
      ".agentgit/**",
      ".claude/**",
      "packages/authority-sdk-py/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["eslint.config.{js,mjs,cjs,ts,mts,cts}"],
    plugins: {
      "@next/next": nextPlugin,
    },
  },
  {
    files: ["apps/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    plugins: {
      "@next/next": nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  {
    files: ["**/*.test.{ts,tsx,js,mjs,cjs}", "**/*.integration.test.ts"],
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
    },
  },
];
