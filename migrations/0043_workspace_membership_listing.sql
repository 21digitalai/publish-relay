CREATE FUNCTION public.list_user_workspaces(requested_user_id uuid)
RETURNS TABLE (
  id uuid,
  slug text,
  name text,
  role public.membership_role,
  "position" integer
) LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT workspace_record.id, workspace_record.slug, workspace_record.name,
    membership_record.role, membership_record.position
  FROM public.memberships AS membership_record
  INNER JOIN public.workspaces AS workspace_record
    ON workspace_record.id = membership_record.workspace_id
  WHERE membership_record.user_id = requested_user_id
    AND requested_user_id = nullif(current_setting('app.user_id', true), '')::uuid
  ORDER BY membership_record.position, membership_record.created_at, workspace_record.id
$$;

REVOKE ALL ON FUNCTION public.list_user_workspaces(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.list_user_workspaces(uuid) TO publish_relay_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_app') THEN
    GRANT EXECUTE ON FUNCTION public.list_user_workspaces(uuid) TO publish_relay_app;
  END IF;
END
$$;
