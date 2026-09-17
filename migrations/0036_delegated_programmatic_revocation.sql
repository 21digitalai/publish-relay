CREATE FUNCTION public.revoke_delegated_token_family(
  requested_token_hash text,
  requested_client_id text,
  requested_at timestamptz,
  requested_request_id text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  matched_grant_id uuid;
  matched_workspace_id uuid;
BEGIN
  SELECT token.grant_id, token.workspace_id
  INTO matched_grant_id, matched_workspace_id
  FROM public.delegated_tokens AS token
  JOIN public.delegated_grants AS grant_record
    ON grant_record.id = token.grant_id AND grant_record.workspace_id = token.workspace_id
  WHERE (token.access_token_hash = requested_token_hash
      OR token.refresh_token_hash = requested_token_hash)
    AND grant_record.client_id = requested_client_id
  FOR UPDATE OF token, grant_record;

  IF matched_grant_id IS NULL THEN RETURN; END IF;

  UPDATE public.delegated_grants
  SET revoked_at = COALESCE(revoked_at, requested_at), updated_at = requested_at
  WHERE id = matched_grant_id AND workspace_id = matched_workspace_id;

  UPDATE public.delegated_tokens
  SET revoked_at = COALESCE(revoked_at, requested_at), updated_at = requested_at
  WHERE grant_id = matched_grant_id AND workspace_id = matched_workspace_id;

  INSERT INTO public.audit_events (
    workspace_id, actor_type, actor_id, action, target_type, target_id, request_id, metadata
  ) SELECT matched_workspace_id, 'delegated', matched_grant_id,
    'delegated_grant.revoked', 'delegated_grant', matched_grant_id,
    requested_request_id, jsonb_build_object('clientId', requested_client_id)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.audit_events
    WHERE workspace_id = matched_workspace_id
      AND action = 'delegated_grant.revoked' AND target_id = matched_grant_id
  );
END
$$;

REVOKE ALL ON FUNCTION public.revoke_delegated_token_family(text, text, timestamptz, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.revoke_delegated_token_family(text, text, timestamptz, text)
      TO publish_relay_web;
  END IF;
END
$$;
