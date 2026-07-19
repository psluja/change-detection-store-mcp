import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Synthesizing the stack bundles the Lambda with esbuild — allow for it.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
