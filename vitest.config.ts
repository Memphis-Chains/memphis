import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['.memphis-intake/**', 'reference/**', 'node_modules/**', 'dist/**', 'tests/fuzz/**'],
  },
});
