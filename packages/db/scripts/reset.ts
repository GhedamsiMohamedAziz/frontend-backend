import { Pool } from 'pg';
import { loadEnv, migrationUrl } from './env';

loadEnv();

/**
 * Drop and recreate the public schema, then re-apply the bootstrap objects that
 * `docker/init` normally provides. Development only — it refuses to run against
 * anything that is not obviously a local database.
 */
async function main(): Promise<void> {
  const url = migrationUrl();
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to reset: NODE_ENV=production');
  }
  if (!/@(localhost|127\.0\.0\.1|postgres)[:/]/.test(url)) {
    throw new Error(`refusing to reset a non-local database: ${url.replace(/:[^:@]*@/, ':***@')}`);
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  console.log('▸ dropping schema public');
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  // The migration journal lives in its own schema. Leaving it behind would make
  // the next `db:migrate` believe every migration had already been applied, and
  // it would happily report success against a completely empty database.
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('GRANT USAGE ON SCHEMA public TO eyesonbug_app');
  await pool.query('CREATE EXTENSION IF NOT EXISTS ltree');
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  // uuid_generate_v7 lived in the dropped schema, so restate it.
  await pool.query(`
    CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
    LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $$
    DECLARE ts_ms bytea; b bytea;
    BEGIN
      ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3 FOR 6);
      b     := uuid_send(gen_random_uuid());
      b     := overlay(b PLACING ts_ms FROM 1 FOR 6);
      b     := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);
      RETURN encode(b, 'hex')::uuid;
    END $$;
  `);
  await pool.query('GRANT EXECUTE ON FUNCTION uuid_generate_v7() TO eyesonbug_app');
  await pool.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eyesonbug_app
  `);
  await pool.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO eyesonbug_app
  `);
  await pool.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO eyesonbug_app
  `);
  console.log('✓ schema reset — run `pnpm db:migrate` next');
  await pool.end();
}

main().catch((error: unknown) => {
  console.error('✗ reset failed');
  console.error(error);
  process.exit(1);
});
