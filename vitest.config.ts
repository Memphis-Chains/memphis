import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    silent: 'passed-only',
    include: ['tests/**/*.test.ts'],
    exclude: ['.memphis-intake/**', 'reference/**', 'node_modules/**', 'dist/**'],
    env: {
      MEMPHIS_API_TOKEN: '',
      GATEWAY_EXEC_RESTRICTED_MODE: 'true',
      GATEWAY_EXEC_ALLOWLIST: 'echo,pwd,ls,whoami,date,uptime',
      GATEWAY_EXEC_BLOCKED_TOKENS: '&&,||,;,|,>,<,$,`,',
    },
  },
});
