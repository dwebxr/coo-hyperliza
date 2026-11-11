import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  tsconfig: './tsconfig.build.json',
  platform: 'node',
  sourcemap: true,
  // dist/ is cleaned by scripts/build-assets.mjs, which runs next: tsup's own clean deletes files
  // and leaves their directories behind
  clean: false,
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
});
