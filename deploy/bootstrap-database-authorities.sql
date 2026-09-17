\set ON_ERROR_STOP on

-- Run as the database owner after migrations. A PostgreSQL role administrator
-- must first run provision-database-roles.sql; migrations never need CREATEROLE.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    RAISE EXCEPTION 'publish_relay_web is missing; run deploy/provision-database-roles.sql as a role administrator';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_worker') THEN
    RAISE EXCEPTION 'publish_relay_worker is missing; run deploy/provision-database-roles.sql as a role administrator';
  END IF;
END
$roles$;

GRANT CONNECT ON DATABASE :DBNAME TO publish_relay_web, publish_relay_worker;
GRANT USAGE ON SCHEMA public TO publish_relay_web, publish_relay_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO publish_relay_web, publish_relay_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO publish_relay_web, publish_relay_worker;
-- Re-run after every migration so newly created functions receive grants.
DO $functions$
BEGIN
  IF to_regprocedure('public.exchange_delegated_authorization_code(text,text,text,text,text,text,timestamptz,timestamptz,timestamptz)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.exchange_delegated_authorization_code(text, text, text, text, text, text, timestamptz, timestamptz, timestamptz) TO publish_relay_web;
  END IF;
  IF to_regprocedure('public.resolve_delegated_access_token(text,timestamptz)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.resolve_delegated_access_token(text, timestamptz) TO publish_relay_web;
  END IF;
  IF to_regprocedure('public.rotate_delegated_refresh_token(text,text,text,timestamptz,timestamptz,timestamptz)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.rotate_delegated_refresh_token(text, text, text, timestamptz, timestamptz, timestamptz) TO publish_relay_web;
  END IF;
END
$functions$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO publish_relay_web, publish_relay_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO publish_relay_web, publish_relay_worker;
