-- Account disconnect must not strand a target workspace's pending Page job.
CREATE FUNCTION public.provider_account_has_active_jobs(
  origin_workspace_id uuid,
  account_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF actor_id IS NULL
    OR origin_workspace_id IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '')::uuid
    OR NOT EXISTS (
      SELECT 1 FROM public.memberships
      WHERE workspace_id = origin_workspace_id AND user_id = actor_id
        AND role IN ('owner', 'admin')
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.provider_accounts
      WHERE id = account_id AND workspace_id = origin_workspace_id
    ) THEN
    RAISE EXCEPTION 'Provider account is unavailable';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.publication_jobs
    WHERE provider_account_id = account_id
      AND (state IN ('scheduled', 'leased', 'dispatching', 'accepted_pending', 'retry_wait')
        OR reconciliation_required = true)
  );
END
$$;

REVOKE ALL ON FUNCTION public.provider_account_has_active_jobs(uuid, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.provider_account_has_active_jobs(uuid, uuid)
      TO publish_relay_web;
  END IF;
END
$$;
