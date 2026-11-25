// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import sfLocators from './packages/eslint-plugin-sf-locators/index.js';

export default tseslint.config(
  {
    ignores: [
      '.tmp/**',
      'node_modules/**',
      'dist/**',
      'runs/**',
      '.qa-memory/**',
      'test-results/**',
      'playwright-report/**',
      'reporting-labs/**',
      'templates/**',
      'coverage/**',
      '.claude/**',
      'eval/.venv/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', 'bin/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='waitForTimeout']",
          message: 'No waitForTimeout (CLAUDE.md rule 6). Use web-first assertions.',
        },
      ],
      // Rule 8: provider SDKs only inside src/models/providers/**
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@langchain/google-genai', '@langchain/anthropic', '@langchain/openai', '@langchain/ollama'],
              message: 'Model access only through ModelRouter.get(role) (CLAUDE.md rule 8).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/models/providers/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // MCP boundary: raw protocol payloads may be `any`; they are Zod-parsed immediately (rule 1).
    files: ['src/mcp/boundary/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Browser scripts of the offline fixture pages.
    files: ['examples/fixture/static/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Generated tests, page objects and Playwright support code (CLAUDE.md rule 6; salesforce-api-testing skill).
    files: ['tests/**/*.ts'],
    ignores: ['tests/unit/**'],
    plugins: { 'sf-locators': sfLocators },
    rules: {
      'sf-locators/no-fragile-locators': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='waitForTimeout']",
          message: 'No waitForTimeout (CLAUDE.md rule 6). Use web-first assertions.',
        },
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            'No raw fetch to Salesforce in tests: use the `sf` / `data` fixtures (salesforce-api-testing skill).',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off', '@typescript-eslint/require-await': 'off' },
  },
  prettier,
);
