import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  AbortController: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
};

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: false,
      },
      globals: nodeGlobals,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true }],
      complexity: ['warn', 10],
    },
  },
  {
    files: ['tests/**/*.ts', '**/*.test.ts'],
    languageOptions: {
      globals: nodeGlobals,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
  {
    ignores: ['dist/**', '**/dist/**', 'node_modules/**', '.memphis-intake/**', 'reference/**'],
  },
];
