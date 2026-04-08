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
    },
  },
});
