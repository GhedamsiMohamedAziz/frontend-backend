-- ADR-002: tenant isolation enforced by Postgres, not by remembering to write
-- a WHERE clause.
--
-- The API and worker connect as `eyesonbug_app`, which is NOT the table owner
-- and has NOBYPASSRLS. Every query runs inside a transaction that sets
-- `app.current_org_id`. A query that forgets its organization predicate then
-- returns zero rows instead of another tenant's data.

-- ─── Context accessors ──────────────────────────────────────────────────────
-- Both return NULL when the GUC is unset, and `column = NULL` is never true,
-- so the failure mode of a missing context is "see nothing", not "see all".

CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_org_id', true), '')::uuid
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION current_actor_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_user_id', true), '')::uuid
$$;
--> statement-breakpoint

-- SECURITY DEFINER so the membership lookup is not itself filtered by the
-- policies it exists to support. `search_path` is pinned: a SECURITY DEFINER
-- function with a caller-controlled search_path is a privilege escalation.
CREATE OR REPLACE FUNCTION is_org_member(org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_membership m
    WHERE m.organization_id = org AND m.user_id = current_actor_id()
  )
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION shares_org_with_actor(target_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_membership m
    WHERE m.user_id = target_user AND m.organization_id = current_org_id()
  )
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION is_org_member(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION shares_org_with_actor(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION current_org_id(), current_actor_id(),
  is_org_member(uuid), shares_org_with_actor(uuid) TO eyesonbug_app;
--> statement-breakpoint

-- ─── Tenant data: one uniform policy, applied by discovery ──────────────────
-- Driven off the presence of an `organization_id` column rather than a
-- hand-maintained list, so a table added later cannot be forgotten. The
-- isolation test asserts the coverage is total.

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.oid, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
      AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t.relname);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I
         USING (organization_id = current_org_id())
         WITH CHECK (organization_id = current_org_id())',
      t.relname
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- ─── Identity tables ────────────────────────────────────────────────────────
-- These are not tenant data: one GitHub identity legitimately belongs to
-- several customer organizations. They get narrower, hand-written policies.

ALTER TABLE "organization" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "organization_visible" ON "organization";
--> statement-breakpoint
-- Visible when it is the active tenant, or when the actor is a member — the
-- latter is what lets "which organizations do I belong to?" be answerable
-- before any organization has been selected.
CREATE POLICY "organization_visible" ON "organization"
  USING (id = current_org_id() OR is_org_member(id))
  WITH CHECK (id = current_org_id());
--> statement-breakpoint

-- org_membership carries organization_id, so the loop above already gave it a
-- tenant policy. Widen it so the actor can always see their own rows, across
-- every organization, which is the same "which orgs am I in?" question.
DROP POLICY IF EXISTS tenant_isolation ON "org_membership";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "org_membership"
  USING (organization_id = current_org_id() OR user_id = current_actor_id())
  WITH CHECK (organization_id = current_org_id());
--> statement-breakpoint

ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "user_visible" ON "user";
--> statement-breakpoint
-- You can see yourself, and anyone who shares the active organization with you.
-- Without this, every tenant could enumerate every other tenant's users and
-- email addresses.
CREATE POLICY "user_visible" ON "user"
  USING (id = current_actor_id() OR shares_org_with_actor(id))
  WITH CHECK (id = current_actor_id());
--> statement-breakpoint

ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "session_own" ON "session";
--> statement-breakpoint
CREATE POLICY "session_own" ON "session"
  USING (user_id = current_actor_id())
  WITH CHECK (user_id = current_actor_id());
