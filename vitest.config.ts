import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Unit tests are pure: no network, no Apify platform, no filesystem writes.
    // Anything that would need those is behind an injected port (see CLAUDE.md).
    testTimeout: 10_000,
  },
});
