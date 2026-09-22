import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entry points on purpose: `index` is isomorphic and safe to import from
  // the browser bundle; `node` pulls in node:crypto and must never reach it.
  entry: { index: 'src/index.ts', node: 'src/node.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
