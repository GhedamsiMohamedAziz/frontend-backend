import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs'],
  clean: true,
  sourcemap: true,
  external: ['pg', 'ioredis'],
});
