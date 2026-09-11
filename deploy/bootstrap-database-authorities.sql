\set ON_ERROR_STOP on

-- Run as a PostgreSQL administrator after migrations. Login roles and their
-- passwords are provisioned separately through the approved secret authority.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    CREATE ROLE publish_relay_web NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_worker') THEN
    CREATE ROLE publish_relay_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_token_exchange') THEN
    CREATE ROLE publish_relay_token_exchange NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
END
$roles$;

GRANT CONNECT ON DATABASE :DBNAME TO publish_relay_web, publish_relay_worker;
GRANT USAGE ON SCHEMA public TO publish_relay_web, publish_relay_worker, publish_relay_token_exchange;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO publish_relay_web, publish_relay_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO publish_relay_web, publish_relay_worker;
GRANT EXECUTE ON FUNCTION public.exchange_delegated_authorization_code(text, text, text, text, text, text, timestamptz, timestamptz, timestamptz) TO publish_relay_web;
GRANT EXECUTE ON FUNCTION public.resolve_delegated_access_token(text, timestamptz) TO publish_relay_web;
GRANT EXECUTE ON FUNCTION public.rotate_delegated_refresh_token(text, text, text, timestamptz, timestamptz, timestamptz) TO publish_relay_web;

-- OAuth token resolution starts from an opaque, globally unique code/token hash,
-- before a workspace is known. FORCE ROW LEVEL SECURITY therefore requires a
-- narrowly scoped definer which may cross the tenant boundary. The web runtime
-- can execute these functions but never assumes the bypass role itself.
GRANT SELECT, INSERT, UPDATE ON public.delegated_grants,
  public.delegated_authorization_codes, public.delegated_tokens
  TO publish_relay_token_exchange;
GRANT SELECT ON public.workspaces TO publish_relay_token_exchange;
ALTER FUNCTION public.exchange_delegated_authorization_code(text, text, text, text, text, text, timestamptz, timestamptz, timestamptz)
  OWNER TO publish_relay_token_exchange;
ALTER FUNCTION public.resolve_delegated_access_token(text, timestamptz)
  OWNER TO publish_relay_token_exchange;
ALTER FUNCTION public.rotate_delegated_refresh_token(text, text, text, timestamptz, timestamptz, timestamptz)
  OWNER TO publish_relay_token_exchange;
GRANT EXECUTE ON FUNCTION public.exchange_delegated_authorization_code(text, text, text, text, text, text, timestamptz, timestamptz, timestamptz) TO publish_relay_web;
GRANT EXECUTE ON FUNCTION public.resolve_delegated_access_token(text, timestamptz) TO publish_relay_web;
GRANT EXECUTE ON FUNCTION public.rotate_delegated_refresh_token(text, text, text, timestamptz, timestamptz, timestamptz) TO publish_relay_web;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO publish_relay_web, publish_relay_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO publish_relay_web, publish_relay_worker;
