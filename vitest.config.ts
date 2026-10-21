import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 60000,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'src/plugin-hyperfy/hyperfy/**', 'dist/**'],
    // Vitest 4 only reports files the tests load unless coverage.include lists the rest
    coverage: {
      include: ['src/**/*.ts'],
      // src/tests.ts is elizaOS's in-agent test suite, not application code
      exclude: ['src/**/*.test.ts', 'src/tests.ts', 'src/plugin-hyperfy/hyperfy/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
