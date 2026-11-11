import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string): string => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@airlock/shared': src('shared'),
      '@airlock/engine': src('engine'),
      '@airlock/replay': src('replay'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
