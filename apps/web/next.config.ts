import type { NextConfig } from 'next';

import { resolve } from 'node:path';

const config: NextConfig = {
  reactStrictMode: true,
  // Pin the trace root to the monorepo. Next otherwise walks up until it finds
  // a lockfile and can land outside the repository entirely.
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
  // The API is a separate service. Proxying it under the same origin means the
  // session cookie is first-party in the browser's eyes, which keeps working
  // when third-party cookie restrictions tighten.
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL ?? 'http://localhost:4000'}/:path*`,
      },
    ];
  },
};

export default config;
