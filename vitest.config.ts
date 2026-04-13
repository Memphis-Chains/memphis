import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    silent: 'passed-only',
    testTimeout: 15000,
    include: ['tests/**/*.test.ts'],
    exclude: ['.memphis-intake/**', 'reference/**', 'node_modules/**', 'dist/**'],
    env: {
      MEMPHIS_API_TOKEN: '',
      RUST_CHAIN_ENABLED: 'true',
      // Pin rate-limit defaults for deterministic test behavior regardless
      // of what the operator's local .env contains.
      MEMPHIS_RATE_LIMIT_SENSITIVE_MAX: '10',
      MEMPHIS_RATE_LIMIT_GLOBAL_MAX: '100',
    },
  },
});
