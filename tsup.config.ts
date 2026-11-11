import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  tsconfig: './tsconfig.build.json',
  platform: 'node',
  sourcemap: true,
  clean: true,
  format: ['esm'],
  dts: false,
  external: [
    'dotenv',
    'fs',
    'http',
    'https',
    'zod',
    'path',
    'buffer',
    'crypto',
    'url',
    'perf_hooks',
    'stream',
    'util'
  ],
  banner: {},
});
