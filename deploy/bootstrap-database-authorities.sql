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

-- Use the database selected by the migration URL. This keeps the bootstrap
-- command independent of psql variable substitution and avoids granting against
-- a database name copied from an untrusted deployment environment.
DO $database$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO publish_relay_web, publish_relay_worker',
    current_database()
  );
END
$database$;
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
  IF to_regprocedure('public.edit_facebook_page_exposure(uuid,uuid,uuid,boolean,text)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.edit_facebook_page_exposure(uuid, uuid, uuid, boolean, text) TO publish_relay_web;
  END IF;
  IF to_regprocedure('public.provider_account_has_active_jobs(uuid,uuid)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.provider_account_has_active_jobs(uuid, uuid) TO publish_relay_web;
  END IF;
  IF to_regprocedure('public.resolve_exposed_post_accounts(uuid,uuid[],boolean)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.resolve_exposed_post_accounts(uuid, uuid[], boolean) TO publish_relay_web;
  END IF;
  IF to_regprocedure('public.list_visible_exposed_facebook_pages(uuid)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.list_visible_exposed_facebook_pages(uuid) TO publish_relay_web;
  END IF;
  IF to_regprocedure('public.list_visible_exposed_facebook_pages_page(uuid,text,uuid,integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.list_visible_exposed_facebook_pages_page(uuid, text, uuid, integer) TO publish_relay_web;
  END IF;
  IF to_regprocedure('public.list_facebook_page_exposure_targets(uuid,uuid,uuid,integer)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.list_facebook_page_exposure_targets(uuid, uuid, uuid, integer) TO publish_relay_web;
  END IF;
  IF to_regprocedure('public.resolve_fanvue_payment_callback(text)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.resolve_fanvue_payment_callback(text) TO publish_relay_web;
  END IF;
END
$functions$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO publish_relay_web, publish_relay_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO publish_relay_web, publish_relay_worker;
