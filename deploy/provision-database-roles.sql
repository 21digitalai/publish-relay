\set ON_ERROR_STOP on

-- Run once per PostgreSQL cluster as a role administrator. Login roles and
-- passwords are provisioned separately through the approved secret authority.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    CREATE ROLE publish_relay_web NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_worker') THEN
    CREATE ROLE publish_relay_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web_login') THEN
    RAISE EXCEPTION 'publish_relay_web_login must be created before provisioning database roles';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_worker_login') THEN
    RAISE EXCEPTION 'publish_relay_worker_login must be created before provisioning database roles';
  END IF;
END
$roles$;

GRANT publish_relay_web TO publish_relay_web_login;
GRANT publish_relay_worker TO publish_relay_worker_login;
