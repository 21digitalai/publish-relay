-- The web role cannot directly grant or revoke target exposures under forced RLS.
-- This narrow owner-only command is the sole cross-workspace mutation boundary.
CREATE FUNCTION public.edit_facebook_page_exposure(
  origin_workspace_id uuid,
  target_workspace_id uuid,
  account_id uuid,
  expose boolean,
  correlation_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  existing_revoked_at timestamptz;
  found_exposure boolean;
BEGIN
  IF actor_id IS NULL OR origin_workspace_id = target_workspace_id
    OR origin_workspace_id IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '')::uuid
    OR correlation_id IS NULL OR correlation_id = '' THEN
    RETURN 'unavailable';
  END IF;

  -- Origin-first matches provider disconnect/reconnect; subsequent admission
  -- must use this same lock order before checking an active exposure.
  PERFORM 1 FROM public.workspaces WHERE id = origin_workspace_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unavailable'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id = target_workspace_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unavailable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = actor_id AND role = 'owner'
      AND workspace_id = origin_workspace_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = actor_id AND role = 'owner'
      AND workspace_id = target_workspace_id
  ) THEN RETURN 'unavailable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.provider_accounts AS account
    JOIN public.provider_connections AS connection
      ON connection.id = account.connection_id AND connection.workspace_id = account.workspace_id
    WHERE account.id = account_id AND account.workspace_id = origin_workspace_id
      AND account.destination_provider = 'facebook_page'
      AND account.disconnected_at IS NULL AND account.availability = 'active'
      AND connection.status = 'active'
  ) THEN RETURN 'unavailable'; END IF;

  SELECT revoked_at INTO existing_revoked_at
  FROM public.provider_account_exposures
  WHERE workspace_id = target_workspace_id AND provider_account_id = account_id
  FOR UPDATE;
  found_exposure := FOUND;
  IF expose AND found_exposure AND existing_revoked_at IS NULL THEN RETURN 'unchanged'; END IF;
  IF NOT expose AND (NOT found_exposure OR existing_revoked_at IS NOT NULL) THEN
    RETURN 'unchanged';
  END IF;
  IF NOT expose AND EXISTS (
    SELECT 1 FROM public.publication_jobs
    WHERE workspace_id = target_workspace_id AND provider_account_id = account_id
      AND (state IN ('scheduled', 'leased', 'dispatching', 'accepted_pending', 'retry_wait')
        OR reconciliation_required = true)
  ) THEN RETURN 'active_jobs'; END IF;

  IF expose AND NOT found_exposure THEN
    INSERT INTO public.provider_account_exposures
      (workspace_id, provider_account_id, created_by)
    VALUES (target_workspace_id, account_id, actor_id);
  ELSIF expose THEN
    UPDATE public.provider_account_exposures SET revoked_at = NULL
    WHERE workspace_id = target_workspace_id AND provider_account_id = account_id;
  ELSE
    UPDATE public.provider_account_exposures SET revoked_at = now()
    WHERE workspace_id = target_workspace_id AND provider_account_id = account_id;
  END IF;
  INSERT INTO public.audit_events
    (workspace_id, actor_type, actor_id, action, target_type, target_id, request_id, metadata)
  VALUES (origin_workspace_id, 'user', actor_id,
    CASE WHEN expose THEN 'provider.destination.exposed' ELSE 'provider.destination.unexposed' END,
    'provider_account', account_id, correlation_id,
    jsonb_build_object('targetWorkspaceId', target_workspace_id));
  RETURN 'updated';
END
$$;

REVOKE ALL ON FUNCTION public.edit_facebook_page_exposure(uuid, uuid, uuid, boolean, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.edit_facebook_page_exposure(uuid, uuid, uuid, boolean, text)
      TO publish_relay_web;
  END IF;
END
$$;
