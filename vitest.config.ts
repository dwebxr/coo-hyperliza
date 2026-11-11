import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 60000,
    include: ['src/**/*.test.ts'],
    // No test may reach anything but this machine: a connection or DNS lookup that would is
    // refused and fails the test that made it
    setupFiles: ['src/plugin-hyperfy/test-support/no-network.ts'],
    exclude: ['**/node_modules/**', 'src/plugin-hyperfy/hyperfy/**', 'dist/**'],
    // Vitest 4 only reports files the tests load unless coverage.include lists the rest
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/plugin-hyperfy/hyperfy/**'],
    },
  },
});
