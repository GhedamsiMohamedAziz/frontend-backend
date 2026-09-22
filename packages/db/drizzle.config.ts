import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Generation and migration run as the *owner* role, which owns the tables and
 * therefore bypasses RLS. The application never uses this URL.
 */
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_MIGRATION_URL ??
      'postgres://eyesonbug:eyesonbug@localhost:5432/eyesonbug',
  },
  casing: 'snake_case',
  verbose: true,
  strict: true,
});
