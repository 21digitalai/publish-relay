ALTER TABLE public.workspaces ADD COLUMN deleted_at timestamptz;

CREATE OR REPLACE FUNCTION public.list_user_workspaces(requested_user_id uuid)
RETURNS TABLE (id uuid, slug text, name text, role public.membership_role, "position" integer)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT workspace_record.id, workspace_record.slug, workspace_record.name,
    membership_record.role, membership_record.position
  FROM public.memberships AS membership_record
  INNER JOIN public.workspaces AS workspace_record
    ON workspace_record.id = membership_record.workspace_id
  WHERE membership_record.user_id = requested_user_id
    AND workspace_record.deleted_at IS NULL
    AND requested_user_id = nullif(current_setting('app.user_id', true), '')::uuid
  ORDER BY membership_record.position, membership_record.created_at, workspace_record.id
$$;

-- Called only after locking the target workspace row. Every FK insertion takes a
-- conflicting key-share lock, so the resource check and tombstone are atomic.
CREATE FUNCTION public.workspace_deletion_blocker(target_workspace_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  dependency record;
  occupied boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships AS membership_record
    WHERE membership_record.workspace_id = target_workspace_id
      AND membership_record.user_id = nullif(current_setting('app.user_id', true), '')::uuid
      AND membership_record.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Workspace is not owned by this user';
  END IF;
  FOR dependency IN
    SELECT constraint_record.conrelid::regclass AS relation_name,
      attribute_record.attname AS column_name,
      constraint_record.conrelid::regclass::text AS table_name
    FROM pg_constraint AS constraint_record
    JOIN pg_attribute AS attribute_record
      ON attribute_record.attrelid = constraint_record.conrelid
      AND attribute_record.attnum = constraint_record.conkey[1]
    WHERE constraint_record.contype = 'f'
      AND constraint_record.confrelid = 'public.workspaces'::regclass
      AND array_length(constraint_record.conkey, 1) = 1
      AND constraint_record.conrelid NOT IN
        ('public.memberships'::regclass, 'public.sessions'::regclass,
         'public.audit_events'::regclass, 'public.users'::regclass)
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)',
      dependency.relation_name, dependency.column_name)
      INTO occupied USING target_workspace_id;
    IF occupied THEN
      RETURN CASE
        WHEN dependency.table_name LIKE '%api_keys' THEN 'Workspace has API keys'
        WHEN dependency.table_name LIKE '%credential%' THEN 'Workspace has credentials'
        WHEN dependency.table_name LIKE '%provider_%' THEN 'Workspace has connected accounts or provider data'
        WHEN dependency.table_name LIKE '%oauth_%' THEN 'Workspace has an OAuth connection in progress'
        WHEN dependency.table_name LIKE '%post%' OR dependency.table_name LIKE '%publication_%' THEN 'Workspace has posts or publication jobs'
        WHEN dependency.table_name LIKE '%media_%' THEN 'Workspace has media'
        WHEN dependency.table_name LIKE '%draft%' THEN 'Workspace has drafts'
        ELSE 'Workspace has linked data'
      END;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.workspace_deletion_blocker(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.workspace_deletion_blocker(uuid) TO publish_relay_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_app') THEN
    GRANT EXECUTE ON FUNCTION public.workspace_deletion_blocker(uuid) TO publish_relay_app;
  END IF;
END
$$;
