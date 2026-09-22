import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'playwright-reporter': 'src/playwright-reporter.ts',
  },
  format: ['cjs', 'esm'],
  dts: { entry: { index: 'src/index.ts', 'playwright-reporter': 'src/playwright-reporter.ts' } },
  clean: true,
  sourcemap: true,
  // The CLI is executed directly by CI and needs a shebang. Node strips the
  // line from any module it loads, so applying it to the CommonJS bundles is
  // harmless for the ones that are imported rather than executed.
  banner: ({ format }) => (format === 'cjs' ? { js: '#!/usr/bin/env node' } : {}),
  // `@playwright/test` is an optional peer: the reporter imports only its
  // types, and the CLI must keep working in a repo that does not have it.
  external: ['@playwright/test'],
  noExternal: ['@eyesonbug/adapters', '@eyesonbug/shared'],
});
