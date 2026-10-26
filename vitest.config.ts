import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests for the Electron side (main, shared), on Node. Renderer tests run via `ng test`. The
 * ffmpeg integration tests encode real clips, in their hooks too, hence the longer timeouts.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
  },
  test: {
    include: ['src/{main,shared}/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
