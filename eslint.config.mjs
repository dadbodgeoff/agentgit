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
    settings: {
      next: {
        rootDir: ["apps/agentgit-cloud/"],
      },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  {
    files: ["apps/agentgit-cloud/src/app/api/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='request'][callee.property.name='json']",
          message: "Use readJsonBody(request) in API routes instead of calling request.json() directly.",
        },
      ],
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
