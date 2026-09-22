import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // One database, one API instance: parallel files would fight over both.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  plugins: [
    // Vitest transpiles with esbuild, which does not implement
    // `emitDecoratorMetadata`. Without it Nest cannot read constructor
    // parameter types, dependency injection fails, and Nest exits the process —
    // taking the test worker with it. SWC emits the metadata esbuild will not.
    swc.vite({ module: { type: 'es6' } }),
  ],
});
