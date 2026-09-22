import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { loadEnv, migrationUrl } from './env';

loadEnv();

/**
 * Migrations run as the table owner, which bypasses RLS. This is one of exactly
 * two places that does (the other is the identity bootstrap at login), and it
 * uses a different connection URL so the distinction is visible at a glance.
 */
async function main(): Promise<void> {
  const url = migrationUrl();
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);

  const folder = resolve(process.cwd(), 'migrations');
  console.log(`▸ migrating ${redact(url)}`);
  const started = Date.now();
  await migrate(db, { migrationsFolder: folder });
  console.log(`✓ migrations applied in ${Date.now() - started}ms`);

  await pool.end();
}

function redact(url: string): string {
  return url.replace(/\/\/([^:]+):[^@]*@/, '//$1:***@');
}

main().catch((error: unknown) => {
  console.error('✗ migration failed');
  console.error(error);
  process.exit(1);
});
