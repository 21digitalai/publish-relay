CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'editor', 'viewer');
CREATE TYPE audit_actor_type AS ENUM ('user', 'api_key', 'system');

CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, password_hash text NOT NULL, is_disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX users_email_lower_unique ON users (lower(email));
CREATE TABLE workspaces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE memberships (workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, role membership_role NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (workspace_id, user_id));
CREATE INDEX memberships_user_idx ON memberships(user_id);
CREATE TABLE sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE, csrf_secret_hash text NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX sessions_workspace_user_idx ON sessions(workspace_id, user_id);
CREATE TABLE api_keys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, created_by_user_id uuid NOT NULL REFERENCES users(id), label text NOT NULL, prefix text NOT NULL UNIQUE, secret_hash text NOT NULL, capabilities text[] NOT NULL DEFAULT '{}', expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX api_keys_workspace_idx ON api_keys(workspace_id);
CREATE TABLE audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT, actor_type audit_actor_type NOT NULL, actor_id uuid, action text NOT NULL, target_type text NOT NULL, target_id uuid, request_id text NOT NULL, ip_address text, user_agent text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_workspace_created_idx ON audit_events(workspace_id, created_at);
CREATE TABLE outbox_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, topic text NOT NULL, aggregate_type text NOT NULL, aggregate_id uuid NOT NULL, payload jsonb NOT NULL, available_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX outbox_available_idx ON outbox_events(available_at) WHERE processed_at IS NULL;

REVOKE ALL ON audit_events FROM PUBLIC;
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_events are append-only'; END $$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['memberships','sessions','api_keys','audit_events','outbox_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid) WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;
