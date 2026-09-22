-- Runs once, on an empty data volume, as the superuser (`eyesonbug`).
-- Everything here is infrastructure that must exist *before* migrations run.

-- ─── Extensions ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS ltree;    -- nested step trees
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- fuzzy search on test titles

-- ─── uuid v7 ────────────────────────────────────────────────────────────────
-- Time-sortable primary keys. Sequential-ish keys keep B-tree inserts at the
-- right edge of the index instead of scattering writes across the whole tree,
-- which matters a great deal for a table taking 20k inserts per run.
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $$
DECLARE
  ts_ms bytea;
  b     bytea;
BEGIN
  -- 48-bit big-endian milliseconds since the Unix epoch
  ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3 FOR 6);
  b     := uuid_send(gen_random_uuid());
  b     := overlay(b PLACING ts_ms FROM 1 FOR 6);
  -- byte 6: clear the high nibble, set version = 7. gen_random_uuid() already
  -- laid down correct variant bits in byte 8, so we leave those alone.
  b     := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);
  RETURN encode(b, 'hex')::uuid;
END $$;

-- ─── Application role ───────────────────────────────────────────────────────
-- ADR-002: the API and worker connect as a role that is NOT the table owner and
-- has NOBYPASSRLS. A forgotten `WHERE organization_id = ...` then returns zero
-- rows instead of another tenant's data. Migrations use the owner role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eyesonbug_app') THEN
    CREATE ROLE eyesonbug_app LOGIN PASSWORD 'eyesonbug_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE eyesonbug TO eyesonbug_app;
GRANT USAGE ON SCHEMA public TO eyesonbug_app;
GRANT EXECUTE ON FUNCTION uuid_generate_v7() TO eyesonbug_app;

-- Tables created later by migrations (owned by `eyesonbug`) become usable by
-- the app role automatically, so no migration has to remember to grant.
ALTER DEFAULT PRIVILEGES FOR ROLE eyesonbug IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eyesonbug_app;
ALTER DEFAULT PRIVILEGES FOR ROLE eyesonbug IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO eyesonbug_app;
ALTER DEFAULT PRIVILEGES FOR ROLE eyesonbug IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO eyesonbug_app;

-- Also cover anything that already exists (re-runs, manual restores).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eyesonbug_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eyesonbug_app;
