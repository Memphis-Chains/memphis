import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
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
    plugins: {
      import: importPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
          pathGroups: [
            {
              pattern: '@/**',
              group: 'internal',
              position: 'before',
            },
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],
      'import/newline-after-import': 'error',
      'import/no-duplicates': 'error',
      // Temporarily disabled to unblock legacy codebase migration.
      // Re-enable incrementally after targeted refactors.
      'max-lines-per-function': 'off',
      complexity: 'off',
      // Sprint D Phase 2 — discourage direct `process.env.X` reads in
      // `src/`. The env-registry (`src/config/env-registry.ts`) is the
      // SSOT for env access; raw reads create the divergent-fallback-
      // chain class of bug (operator sets X but Memphis can't see it).
      //
      // Level is `warn` initially so the ~59 existing call sites surface
      // for incremental migration in Sprint D Phase 3 without blocking
      // CI today. Promote to `error` once the migration is complete.
      //
      // The selector matches `process.env.<NAME>` (dot or bracket access).
      // Passing `process.env` as an object reference (e.g. into the
      // env-registry's `read(rawEnv)`) is fine — only key-level access
      // trips the rule.
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env']",
          message:
            'Avoid direct `process.env.X` reads — go through `src/config/env-registry.ts`. Pass `rawEnv = process.env` and call the typed accessor (e.g. `MEMPHIS_VOICE_MODE.read(rawEnv)`).',
        },
      ],
    },
  },
  {
    // Allowlist: env-registry is the SSOT for env access. Schema and
    // env-loading helpers don't read `process.env.X` today (they take
    // `rawEnv` as an argument), so they don't need the override; if
    // that ever changes, add them here.
    files: ['src/config/env-registry.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['tests/**/*.ts', '**/*.test.ts'],
    languageOptions: {
      globals: nodeGlobals,
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
          pathGroups: [
            {
              pattern: '@/**',
              group: 'internal',
              position: 'before',
            },
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],
      'import/newline-after-import': 'error',
      'import/no-duplicates': 'error',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
  {
    ignores: [
      'dist/**',
      '**/dist/**',
      'node_modules/**',
      '.tools/**',
      '.memphis-intake/**',
      'reference/**',
      'legacy/**',
      'memphis/**',
      'target/**',
    ],
  },
];
